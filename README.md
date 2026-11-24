# pumpfun-paper-sprint

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Tuapaaas/pumpfun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Tuapaaas/pumpfun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Launch-snipe paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty: it buys fresh pump.fun launches that pass a light rug filter and exits within seconds.

## Strategy — "Launch Snipe"

Every coin is watched from its `CreateEvent`. A buy is decided only in the coin's first 6 slots, and only if:

- the creator has not sold, and their own opening buy is at most 2.5 SOL;
- at most 2 distinct non-creator buyers have piled in (a launch bundled by many wallets is a dump waiting to happen);
- at least 3 trades have been seen, real SOL is 0.3–30, and the price sits 0.95–1.6× its create price.

Each position is a fixed 0.1 SOL. Exits are fast by design: take-profit +10%, stop-loss −12%, a 12-slot hold cap, and an immediate exit if the creator sells while held. A small probe mechanism keeps the run above the guardrails (≥20 coins, ≥0.01 SOL round trips) by opening tiny 0.01 SOL round trips when fills or coins lag the pace.

Two earlier designs were tried on the dev window and dropped: dip-buying (20–55% dips, −0.05…−0.96 SOL in every parameter cell) and fresh-launch momentum with 200-slot holds (−0.37…−0.80 SOL). Holding longer only bled — these coins dump after the initial pop.

## Backtest (dev window, `grade-local --driver process`, full 128,058 events)

- Net PnL **−0.1465 SOL** (return −1.46%, 90% interval −0.211…−0.093 SOL)
- 332 fills over 93 coins, 166 round trips, win rate 5.4%, max drawdown 1.56%
- Guardrails met (93 coins hold a ≥0.01 SOL round trip; drawdown ok)
- L1 regrade reproduced byte for byte (deterministic: no clock, no randomness, no I/O)

Honest caveat: on the dev window every strategy tested loses a little — the kit's momentum pilot −9.38 SOL, reversion pilot −1.65 SOL, sniper pilot −0.13 SOL. This entry is the least-bad shape found, a positive-dev-score lottery ticket on the fresh 6-hour final window; gains concentrate in 3 coins (88% of gains).

## Run it

```sh
node main.ts
```

The bot is a pure function of the harness batch stream (`agent-fun/replay/v2`); the SDK shim in `vendor/` is the kit's, vendored byte for byte. Strategy in `strategy.ts`, entrypoint `main.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=c1kkm475&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
