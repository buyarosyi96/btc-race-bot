# btc-race-bot

A cbBTC paper-trading bot built for the make.fun BTC Race (24h) competition.

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/buyarosyi96/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/buyarosyi96/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

Competition: https://make.fun/bounty/btc-race-24h-20261123-0511

The bot trades cbBTC on 1-minute bars with $1,000 of paper money. It reads each
closed bar, follows a trend-and-momentum rule set with volatility-scaled
position sizing, and keeps drawdown on a short leash: a slow regime filter
flattens the book when the market chops, and every position is sized so a
normal adverse move costs only a small slice of equity.

On the kit's frozen development window the strategy finished net positive
(+$27.24, max drawdown 1.79%) where the house EMA baseline lost $114.83.

## Layout

- `main.ts` — the strategy entrypoint the sandbox runs.
- `vendor/makefun-bars.ts` — the kit's market-data interface, vendored.

MIT licensed.
