// Trend-rider bot for the cbBTC 24h bars race (agent-fun/bars-replay/v1).
//
// Idea: fees, slippage and price impact make a full round trip cost roughly
// 30-45 bps at useful size, so the bot only trades when a trend is clearly
// established and then rides it instead of churning. It stays in cash while
// the market falls or drifts, which is also what keeps drawdown small.
//
// Rules (all decided on a bar's close, filled at the next bar's open):
//   - Indicators over CBBTC closes: EMA(15) and EMA(90), each seeded as the
//     mean of its first span of closes, plus the plain return over the last
//     30 bars.
//   - Entry: not holding, not in warm-up, at least 90 bars seen, EMA(15)
//     above EMA(90) by at least 0.1% of the slow EMA (a real trend, not a
//     marginal cross), the 60-bar return at least +0.2%, and at least 60
//     bars since the last exit. Buy with 90% of equity, but skip the entry
//     when the pool is so thin that the estimated impact of that size alone
//     exceeds 40 bps.
//   - Exit (whole position, whichever comes first): the position's value
//     drops to 4% under its cost (fees included), or the value falls 3%
//     below the best value-to-cost ratio seen since entry (a trailing
//     stop that locks in a run). There is deliberately no exit on an EMA
//     cross or a dip under the slow EMA: in testing those fired on brief
//     wobbles inside a continuing trend and bled the round-trip cost each
//     time, while the two stops alone bound a losing trade and still let
//     a winning one run to the end of the window. The stops are wide on
//     purpose: one-minute noise in this market swings about 0.08% a bar,
//     and tight stops were shaken out again and again in testing.
//   - Insurance for a hostile window: the race ranks an entry that never
//     trades below every entry that traded at least once, so if half the
//     window has passed with no trade at all, the entry bars relax (the
//     spread to 0.05%, the 60-bar return to +0.1%) for the rest of the
//     window. A clear trend still has to appear; the stops still bound
//     the loss on the trade it makes. On a window with any real uptrend
//     the main rules trade long before this matters.
//   - An order that has not taken effect after 3 bars is treated as refused
//     and its intent is re-evaluated from the live state, never resent
//     blindly; a sell whose reason still holds is simply decided again on
//     the next bar because the exit rules read the current position.
// Everything is a pure function of the bars and the account the harness
// sends: no clock, no environment, no randomness, so two runs agree byte
// for byte.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST_SPAN = 15;
const SLOW_SPAN = 90;
const MOMENTUM_BARS = 60;
const MOMENTUM_MIN = 0.002; // +0.2% over the last 60 bars
const SPREAD_MIN = 0.001; // EMA(15) must clear EMA(90) by 0.1% of it
const SIZE_BPS = 9000; // spend 90% of equity on an entry
const MAX_ENTRY_IMPACT_BPS = 40n; // skip entries into a very thin pool
const HARD_STOP = 0.04; // exit at 4% under cost
const TRAIL_STOP = 0.03; // exit 3% under the best value/cost seen
const COOLDOWN_BARS = 60; // bars to wait after an exit before re-entry
const RELAX_AFTER = 720; // bars without any trade before the entry bars relax
const SPREAD_MIN_RELAXED = 0.0005; // 0.05% once relaxed
const MOMENTUM_MIN_RELAXED = 0.001; // +0.1% over 60 bars once relaxed
const SLIPPAGE_BPS = 200; // head-room so fills are not refused on a fast open
const PENDING_BARS = 3; // bars an order may take to show in the account

class TrendRider {
  closes: number[] = [];
  emaFast: number | null = null;
  emaSlow: number | null = null;
  pendingBuy = -1; // seq the last buy was decided on, -1 for none
  pendingSell = -1;
  lastExitSeq = -1_000_000;
  wasHolding = false;
  everHeld = false; // a position has been seen at least once this window
  peakRatio = 0; // best position value / cost since the current entry

  emaStep(span: number, prev: number | null, seed: number, close: number): number {
    if (prev === null) return seed;
    const k = 2 / (span + 1);
    return prev + k * (close - prev);
  }

  seedMean(span: number): number {
    const part = this.closes.slice(-span);
    let sum = 0;
    for (const c of part) sum += c;
    return sum / part.length;
  }

  onBatch(state: BarsState, _batch: Batch): OrderInput[] {
    const closeBig = state.close(SYMBOL);
    if (closeBig === null) return [];
    const close = Number(closeBig);
    this.closes.push(close);
    if (this.closes.length === FAST_SPAN) this.emaFast = this.seedMean(FAST_SPAN);
    else if (this.closes.length > FAST_SPAN) this.emaFast = this.emaStep(FAST_SPAN, this.emaFast, 0, close);
    if (this.closes.length === SLOW_SPAN) this.emaSlow = this.seedMean(SLOW_SPAN);
    else if (this.closes.length > SLOW_SPAN) this.emaSlow = this.emaStep(SLOW_SPAN, this.emaSlow, 0, close);

    const held = state.positions.get(SYMBOL);
    const holding = held !== undefined && held.qty > 0n;
    if (holding) this.everHeld = true;

    // An exit is recognised when a position we held is gone from the account.
    if (this.wasHolding && !holding) {
      this.lastExitSeq = state.seq;
      this.peakRatio = 0;
      this.pendingSell = -1;
    }
    this.wasHolding = holding;

    // Pending orders clear once they show up, or expire after a few bars.
    if (this.pendingBuy >= 0 && (holding || state.seq - this.pendingBuy > PENDING_BARS)) this.pendingBuy = -1;
    if (this.pendingSell >= 0 && (!holding || state.seq - this.pendingSell > PENDING_BARS)) this.pendingSell = -1;

    if (state.warmingUp) return [];
    if (this.emaFast === null || this.emaSlow === null) return [];

    if (holding && held !== undefined) {
      // Value of the position at this close against what it cost us.
      const value = state.value(SYMBOL, held.qty);
      const ratio = Number(value) / Number(held.cost);
      if (ratio > this.peakRatio) this.peakRatio = ratio;
      const hardStop = ratio <= 1 - HARD_STOP;
      const trailed = this.peakRatio > 1 && ratio <= this.peakRatio * (1 - TRAIL_STOP);
      if ((hardStop || trailed) && this.pendingSell < 0) {
        this.pendingSell = state.seq;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: look for an entry, but only in a confirmed, rising trend.
    if (this.pendingBuy >= 0) return [];
    if (state.seq - this.lastExitSeq < COOLDOWN_BARS) return [];
    if (this.closes.length <= MOMENTUM_BARS) return [];
    const past = this.closes[this.closes.length - 1 - MOMENTUM_BARS];
    const momentum = close / past - 1;
    const relaxed = !this.everHeld && state.seq >= RELAX_AFTER;
    const spreadMin = relaxed ? SPREAD_MIN_RELAXED : SPREAD_MIN;
    const momentumMin = relaxed ? MOMENTUM_MIN_RELAXED : MOMENTUM_MIN;
    if (this.emaFast <= this.emaSlow * (1 + spreadMin)) return [];
    if (momentum < momentumMin) return [];

    const notional = (state.equity * BigInt(SIZE_BPS)) / 10_000n;
    const spend = notional < state.cash ? notional : state.cash;
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    const impact = state.impactBps(SYMBOL, spend);
    if (impact !== null && impact > MAX_ENTRY_IMPACT_BPS) return [];

    this.pendingBuy = state.seq;
    this.peakRatio = 0;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: SLIPPAGE_BPS }];
  }
}

const rider = new TrendRider();
await runBars(rider);
