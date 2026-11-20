# token-radar-v2

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Teazel-lab/token-radar-v2/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Teazel-lab/token-radar-v2/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar ranks protocols that record no token by an implied fully diluted value read from the snapshot itself: TVL, the market's mcap/TVL multiple, 7-day TVL growth, and how long the protocol has already run with no token on record. Protocols whose token already trades stay on a separate calibration tab. Each pre-token row carries a farm plan with a dollar cost and a time for every step.

## Run it

```sh
node main.ts --input _kit/input/snapshot.json --output out/run
node tools/capture.mjs
node tools/verify.mjs
```

## The value model

`impliedValue` in `dashboard/model.js` states the claim. `rankBoard` sorts by that claim.

Implied FDV = TVL × peer multiple × growth factor × runway factor × class factor, rounded to a whole dollar, at least $1.

- Peer multiple: among protocols whose token already trades (mcap and TVL both above zero), each category takes the median of log(mcap/TVL), shrunk toward the all-peer median with weight n/(n+4). A category with no trading peer uses the all-peer median. Clamped to 0.05 .. 1.5.
- Growth factor = 1 + 0.20 × c/(1+|c|), where c is the 7-day TVL change in percent divided by 25. That keeps the factor inside 0.80 .. 1.20. A null `change_7d` is 1.00.
- Runway factor = 0.92 + 0.36 × days/(days+540). Days are the UTC span from `listed_at` to the snapshot `as_of` (2026-11-14). Longer token-free time on record raises the factor from 0.92 toward 1.28. A null `listed_at` is 1.00.
- Class factor is 1.00 for watchlist and early, and 0.01 for custody.

`per1kFarmed` is an illustration, not a promised airdrop: dollars per $1,000 deposited if 10% of implied FDV were shared with depositors pro rata to TVL.

## Launch classes

`classifyLaunchClass` reads the snapshot only.

- **Watchlist.** The slug is on the snapshot's watchlist (40 protocols at or above the $50,000,000 floor that record no token and are not a wrapped or staked product of one that already trades). Class factor 1.
- **Early.** Records no token (`gecko_id` and `symbol` both null), is not on the watchlist, and is not custody. This is the below-floor and leftover pre-token set the radar exists to find. Class factor 1, same formula, so a smaller TVL ranks itself.
- **Custody.** Records no token, is not on the watchlist, and the snapshot fields mark it as someone else's asset: category Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC or CEX; a name ending in a version marker (V2, v3, 2.0); a whole word wrapped, staked or staking; or a name starting with Binance, Coinbase, Bybit, Kraken, Bitget, OKX, Bitfinex or Gemini. Class factor 0.01, one percent of an otherwise identical launch candidate, so custody sinks. On this snapshot the best custody row is outside the top 30. Every pre-token row still stays on the board.

A protocol with `mcap_usd` > 0 is "token already trades" and is kept off the ranked board, on the calibration tab. Anything else with a token field filled in is "token on record" and is not ranked.

## Farm plans

`buildFarmPlan` in `dashboard/farm.js` builds 5 steps (6 for a non-custody row, which adds a funding leg), each with a cost in dollars and a hands-on time in minutes.

The ticket is 0.02% of TVL, clamped to $1,000 .. $25,000 and rounded to the nearest $100. Gas comes from a fixed per-chain table; the plan uses the cheapest chain the protocol lists. The hold is 30 days plus one day per 10 runway days, capped at 120 (45 when `listed_at` is unreported). Opportunity cost is 5% APR on the ticket for that hold, stated as that step's cost, not a fee paid to the protocol.

The middle steps follow the category: lend (supply, borrow under 35% LTV), CDP (mint at most 40%), dex (50/50 LP and a weekly 5% swap), vault, RWA (KYC then subscribe), derivatives, basis (long spot, short perp), or a plain deposit. Custody does not ask for fresh capital. Every plan ends with a weekly TVL check and an exit if TVL falls 25% under the snapshot figure or the 7-day change turns below -15%. `farmStepText` is the sentence written onto each board row.

## The dashboard

Plain page, no framework. Hash routes, same model the board is scored with:

- `#/` the pre-token board, ranked by implied FDV. Sort any column; ties break by value, then slug. Filter by class, category, chain, minimum TVL and search.
- `#/?class=watchlist&sort=growth&dir=desc` a filtered view: chips, a shown-of counter, and combined implied value, median 7-day change and the cheapest plan.
- `#/?tab=live` protocols whose token already trades, with market cap and mcap/TVL. They are not ranked on the pre-token board.
- `#/p/<slug>` one protocol: the value waterfall, the farm plan with cash, time, hold and opportunity cost, peers in that category, and risks.
- `#/how` the model's own lines.

## Determinism

No `Date.now`, no `Math.random`, no `Intl`. The runway clock is the snapshot `as_of`. Number formatters are local. Every sort is a total order: the chosen key, then implied value descending, then slug ascending. `node tools/verify.mjs` runs `main.ts` twice and checks the sha256 of every output file.

---

<sub>Entered on [make.fun](https://make.fun/?ref=68mq8j14&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
