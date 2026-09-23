# Jev expression benchmark

How fast can a [System One Model](https://typesafe.ai/blog/introducing-system-one-models-and-jev) evaluate a real workload? This repo runs 975 Boolean expressions from a production expression engine (PLC tags in, `true`/`false` out) through TypeSafe AI's **Jev**, calling the [TypeSafe API](https://docs.typesafe.ai/api) directly with the [`@typesafe-ai/sdk`](https://docs.typesafe.ai/sdk/javascript) package. It times the pass and checks every answer against a local evaluator.

The dataset ships in `data/` with generic tag names (see [The dataset](#the-dataset)), so every number below can be reproduced.

**Headline: all 975 expressions in a median 0.22 s (fifteen runs, 0.16–0.29 s) at 99.2–99.5% accuracy, for $0.004 a pass.**

## Results

Measured with `jev-latest` (it answered as `jev-1.13.0`), `@typesafe-ai/sdk` 0.6.0 and Node 24.21, from one desktop on a home connection in the US. Wall time covers the network pass only; warm-up and payload building are excluded. No run needed a retry, and the concurrency sweep ran with `--retries 0` and lost nothing: there was not a single 429 or 529 all session.

### Headline runs

Five back-to-back passes of `node bench.mts --batch 50,50,50,50,50 --concurrency 128` on the published dataset: 50 expressions per request, all 20 requests in flight.

| Run | Wall time | Expressions/s | Server p50 | Accuracy | Retries | Failed |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.229 s | 4,267 | 90 ms | 99.28% | 0 | 0 |
| 2 | 0.195 s | 5,004 | 103 ms | 99.28% | 0 | 0 |
| 3 | 0.177 s | 5,518 | 101 ms | 99.38% | 0 | 0 |
| 4 | 0.183 s | 5,339 | 102 ms | 99.49% | 0 | 0 |
| 5 | 0.241 s | 4,041 | 117 ms | 99.28% | 0 | 0 |

An identical set of five a few minutes earlier took 0.219, 0.280, 0.161, 0.199 and 0.248 s, and a third set ninety minutes later, right after about 8,000 single-expression requests, took 0.231, 0.177, 0.182, 0.244 and 0.285 s. Across all fifteen the median is 0.22 s. Quote the median of several runs, not the best run.

### Approaches compared

| Approach | Requests | Wall time | Expressions/s | Accuracy |
| --- | --- | --- | --- | --- |
| 1 per request, one at a time | 975 | ~102 s (extrapolated from the 105 ms p50, not run) | ~10 | not measured |
| 1 per request, 4 in flight | 975 | 26.8 s (1 run) | 36 | 100% |
| 1 per request, 16 in flight | 975 | 6.9–7.6 s (3 runs) | 128–141 | 100% |
| 1 per request, 32 in flight | 975 | 3.8–4.4 s (2 runs) | 222–258 | 99.9–100% |
| 1 per request, 64 in flight | 975 | 2.3 s (1 run) | 432 | 99.9% |
| 1 per request, 128 in flight | 975 | 1.3 s (1 run) | 774 | 99.9% |
| 1 per request, 256 in flight | 975 | 0.90 s (1 run) | 1,087 | 99.9% |
| 1 per request, 512 in flight | 975 | 0.79 s (1 run) | 1,227 | 99.9% |
| 1 per request, all 975 in flight | 975 | 0.80 s (1 run) | 1,225 | 99.8% |
| 25 per request, all in flight | 39 | 0.19–0.24 s (3 runs) | 4,086–5,150 | 99.6% |
| 50 per request, all in flight | 20 | 0.16–0.29 s (15 runs) | 3,417–6,052 | 99.2–99.5% |
| 100 per request, all in flight | 10 | 0.20–0.27 s (4 runs) | 3,646–4,956 | 99.3–99.5% |
| 250 per request, all in flight | 4 | 0.24 s (1 run) | 4,104 | 99.5% |
| 500 per request, all in flight | 2 | 0.49 s (1 run) | 1,980 | 98.9% |
| Local JavaScript evaluation, for scale | 0 | 0.3 ms | | 100% by definition |

What the numbers say:

- **Questions per request is the lever.** Jev evaluates many questions against one shared state, and with 4 requests in flight a request took 105 ms for 1 question, 108 ms for 10, 132 ms for 50 and 189 ms for 100. Batching is about 3.6x faster than the best per-expression run, for a quarter of the tokens.
- **Brute-force concurrency plateaus around 0.8 s.** Doubling the workers halves the wall time up to about 128 in flight. Past that the per-request p50 climbs (138 ms at 128 in flight, 279 ms at 975) and throughput flattens near 1,200 expressions/s.
- **With every request in flight, wall time is the slowest single request.** That is why 25, 50, 100 and 250 per request all land in the same place. At 500 per request the single request itself gets slow (490 ms) and accuracy drops, so there is nothing to gain past about 100.
- **Most of each request is TypeSafe, not the network.** The `x-envoy-upstream-service-time` response header reports 70–80 ms inside TypeSafe for a single question and 90–140 ms for a 50–100 question request. The other 25–30 ms is network and TypeSafe's edge proxy.
- **Limits found:**
  - One request with all 975 questions fails with `400 {"detail":{"error_type":"max_tokens_exceeded"}}`. The [documented budget](https://docs.typesafe.ai/models) is 64K tokens per request; 500 questions (about 47K tokens) works.
  - The documented rate limits are 250,000 tokens per second and 1,200 requests per minute, answered with `429`, plus `529 Overloaded` when TypeSafe sheds load. Nothing here reached either. About 8,000 single-question requests in a few minutes, 975 of them in flight at once, ran without a 429, and a batched pass is about 99K tokens in 0.2 s. TypeSafe says the limits move without notice, so treat that as one session's observation, not headroom you can plan on.
- **Batching costs a little accuracy.** One expression per request misses 0–2 of 975 (8 of 10,725 over eleven passes). A shared state misses 4–8 of 975, and identical payloads do not always miss the same rows, though five rows account for two thirds of the misses. The misses are tags with near-identical names in the same state (a `Step` and a `Step_No` on one circuit), 600-character chains of `||` ranges, and rows that compare a number to `true`. The probability is a usable gate: across 32 complete batched runs (31,200 answers, 193 wrong), trusting only answers below 0.1 or above 0.9 sends 3.2% to review, catches 164 of the 193, and leaves 29 confident misses (25 of them the `Step`/`Step_No` pair), which is 99.9% accuracy on what it accepts.
- **Tokens:** about 300 fixed per request plus about 100 per question, so a batched pass is about 96K–105K tokens ($0.004) and a per-expression pass is about 371K ($0.016).

## Quick start

You need Node 24+ (it runs `bench.mts` directly, no build step) and a TypeSafe API key from the [TypeSafe console](https://typesafe.ai).

```sh
npm install
export TYPESAFE_API_KEY=your-typesafe-key   # PowerShell: $env:TYPESAFE_API_KEY = '...'
```

Or put `TYPESAFE_API_KEY=...` in a `.env` file and run with `node --env-file=.env bench.mts`.

The dataset is already in `data/`, so the first run needs nothing else:

```sh
node bench.mts --limit 20
```

### Bring your own expressions

The benchmark reads two files from `data/`:

- `expressions.csv` is the workload: a header row, then one `Name,ExpressionScript` pair per line.
- `tags.json` is the simulated PLC: one value per tag, the state every expression is evaluated against.

To run your own expressions, replace `expressions.csv` and delete `tags.json`. On its next run, `bench.mts` sees that `tags.json` is missing and writes a new one from the expressions alone (see step 2 under [How it works](#how-it-works) for how it picks the values). You can also write `tags.json` by hand, or edit the generated one, as long as every tag the expressions use has a Boolean or numeric value.

```csv
Name,ExpressionScript
Caustic Circulation,PUMP_1 == true && VALVE_1 == false && TT_RECIRC_TEMP > 150
Caustic Circulation Stop,PUMP_1 == false || TT_RECIRC_TEMP < 110
Drain,STEP_NO == 15
```

Supported grammar: tag names (`[A-Za-z_][A-Za-z0-9_]*`), `true`/`false`, numbers, `== != > >= < <=`, `&&`, `||`, `!` and parentheses. Write comparisons tag-first (`TEMP > 150`). Names cannot contain commas. Rows that use anything else are skipped with a warning, and the run continues without them.

## Usage

| Flag | Default | Meaning |
| --- | --- | --- |
| `--batch` | `1` | Expressions per request. A comma list sweeps; repeat a value to repeat a config. |
| `--concurrency` | `16` | Requests in flight. A comma list sweeps. Capped at the number of requests. |
| `--limit` | all rows | Only the first N rows, for cheap smoke runs. |
| `--retries` | `2` | Extra attempts per request for retryable errors such as a 429 or 529. `0` shows the raw failure rate. |
| `--model` | `jev-latest` | TypeSafe model ID or alias. The cost column assumes Jev's input price. |
| `--trace` | off | Print every answer as it lands: ID, P(yes), ✓/✗ against ground truth, the expression and the state it was judged against. Useful for watching a run or recording one. |

```sh
node bench.mts --batch 1,25,50,100 --concurrency 128    # sweep expressions per request
node bench.mts --batch 100,100,100 --concurrency 128    # repeat one config three times
node bench.mts --batch 1 --concurrency 16,32,64         # sweep concurrency
node bench.mts --batch 100 --concurrency 128 --retries 0   # raw failure rate, no retries
```

Output of `node bench.mts --limit 100 --batch 1,10,25,50,100 --concurrency 10`:

```
100 expressions, 309 tags, expected 34 true / 66 false
local JS evaluation of all 975 rows: 0.39 ms

batch 1 x conc 10: 2.033 s, 49 expr/s, 100% correct, 0 retries, 0 failed
batch 10 x conc 10: 0.157 s, 636 expr/s, 100% correct, 0 retries, 0 failed
batch 25 x conc 4: 0.118 s, 844 expr/s, 100% correct, 0 retries, 0 failed
batch 50 x conc 2: 0.145 s, 690 expr/s, 100% correct, 0 retries, 0 failed
batch 100 x conc 1: 0.134 s, 748 expr/s, 99% correct, 0 retries, 0 failed
┌─────────┬───────┬──────┬──────┬────────┬────────┬────────┬────────┬────────┬───────────────┬─────────┬────────┬───────┬────────┬─────────┐
│ (index) │ batch │ conc │ reqs │ wall s │ expr/s │ p50 ms │ p95 ms │ max ms │ server p50 ms │ retries │ failed │ acc % │ tokens │ cost $  │
├─────────┼───────┼──────┼──────┼────────┼────────┼────────┼────────┼────────┼───────────────┼─────────┼────────┼───────┼────────┼─────────┤
│ 0       │ 1     │ 10   │ 100  │ 2.033  │ 49     │ 94     │ 135    │ 1196   │ 69            │ 0       │ 0      │ 100   │ 37966  │ 0.00159 │
│ 1       │ 10    │ 10   │ 10   │ 0.157  │ 636    │ 106    │ 157    │ 157    │ 80            │ 0       │ 0      │ 100   │ 12422  │ 0.00052 │
│ 2       │ 25    │ 4    │ 4    │ 0.118  │ 844    │ 100    │ 118    │ 118    │ 76            │ 0       │ 0      │ 100   │ 10493  │ 0.00044 │
│ 3       │ 50    │ 2    │ 2    │ 0.145  │ 690    │ 145    │ 145    │ 145    │ 120           │ 0       │ 0      │ 100   │ 9829   │ 0.00041 │
│ 4       │ 100   │ 1    │ 1    │ 0.134  │ 748    │ 134    │ 134    │ 134    │ 107           │ 0       │ 0      │ 99    │ 9522   │ 0.0004  │
└─────────┴───────┴──────┴──────┴────────┴────────┴────────┴────────┴────────┴───────────────┴─────────┴────────┴───────┴────────┴─────────┘
```

| Column | Meaning |
| --- | --- |
| `wall s` | The timed network pass. Warm-up and payload building are excluded. |
| `expr/s` | Answered expressions divided by wall time. |
| `p50 ms`, `p95 ms`, `max ms` | How long the client waited per request, including any retries and their delays. |
| `server p50 ms` | Time TypeSafe's edge proxy waited on the service behind it for the successful attempt, from the `x-envoy-upstream-service-time` response header. `p50 ms` minus this is network plus proxy. The header is not in TypeSafe's docs, so the column is `NaN` if it ever goes away. |
| `retries` | Extra attempts made for retryable errors. Each one is a 429, a 529 or similar that was absorbed. |
| `failed` | Requests still failing after every retry. Their expressions go unanswered, so rerun for a headline number. |
| `acc %` | Answers that match the local evaluator, calling `noul >= 0.5` true. |
| `tokens`, `cost $` | Input tokens billed, and their cost at Jev's $0.042 per million. |

Each run also writes `results/<timestamp>.json` with payload build time, warm-up time, accuracy split by expected true and false, per-request timings and retry counts, every probability, and each mismatch with the state it was judged against.

## How it works

1. **Load.** Read the CSV and keep rows whose tokens are all on a whitelist.
2. **Simulate the PLC.** `data/tags.json` holds one value per tag. If it is missing, the script generates it: Boolean tags get `true`/`false`, numeric tags get each constant they are compared against and its two neighbours (for `TEMP > 150` that is 149, 150 or 151, where `>`, `>=` and `==` disagree), and of 5,000 seeded random draws it keeps the one closest to an even true/false split (random values alone make nearly everything false). Edit the file by hand, or delete it to regenerate.
3. **Ground truth.** The grammar is a subset of JavaScript, so each expression is compiled with `new Function` and evaluated against the snapshot. Every identifier becomes a function parameter, so nothing outside the snapshot is reachable.
4. **Build requests, untimed.** Rows are chunked in CSV order, which keeps related equipment together. Each request carries only the tags its chunk uses as `state`, plus one [Noul](https://docs.typesafe.ai/primitives/noul) (yes/no) question per expression:

   ```json
   {
     "state": { "PUMP_1": true, "VALVE_1": false, "TT_RECIRC_TEMP": 151 },
     "questions": {
       "r2": { "type": "noul", "instructions": "<RULES>\nExpression: PUMP_1 == true && VALVE_1 == false && TT_RECIRC_TEMP > 150" },
       "r3": { "type": "noul", "instructions": "<RULES>\nExpression: PUMP_1 == false || TT_RECIRC_TEMP < 110" }
     }
   }
   ```

   `RULES` is a two-sentence constant in `bench.mts`. Building all 975 payloads takes about 1 ms, so there is nothing to gain from pre-building them to disk.
5. **Warm up, then time.** Before each config, one throwaway request per worker opens a keep-alive socket, so TLS handshakes stay out of the measurement. The warm-up payload is one the timed pass never sends, so no cache can flatter the numbers. Then a worker pool sends the real requests and the clock runs. A request that gets a retryable error is sent again by the same worker after a short random delay, up to `--retries` times, and that time stays on the clock.
6. **Score.** `client.systemOne` returns `{ type: 'noul', noul }` per question. That is P(yes), not a Boolean, so the script thresholds at 0.5 and compares with ground truth.

## Things worth knowing

- **`true == 1` and `false == 0`.** The export compares 43 tags against both `true`/`false` and `0`/`1`. Ground truth uses JavaScript loose equality, and the rules sent to Jev say the same. If your engine treats those as unequal, change `RULES` and the evaluator together.
- **Retries are the script's own, not the SDK's.** The SDK's built-in retry backs off from 500 ms and does not report how many attempts it made, which would turn one 529 into a 0.7 s run with no explanation. So the client is built with `retry: { maxRetries: 0 }` and `bench.mts` retries the same errors the SDK would (connection failures, timeouts, 408, 429 and 5xx) itself: up to 2 more attempts, 50–150 ms then 100–300 ms apart, counted in the `retries` column. A 429's `retry-after` overrides that delay. Use `--retries 0` to see the raw failure rate.
- **Latency and load change minute to minute**, so one run proves little. Repeat a config (`--batch 50,50,50`) and report the spread.
- **A config whose warm-up fails completely is skipped**, not fatal, so a sweep keeps the results it already has.
- **Zero data retention is not a request flag here.** On the direct API it is an account-level enterprise feature; see TypeSafe's [data handling](https://docs.typesafe.ai/models#data-handling) notes.
- **The cost column is Jev-specific.** It is wrong for any other `--model`.

## The dataset

`data/expressions.csv` is a real export: 975 expressions over 309 tags from a production CIP expression engine, 875 of them distinct. The logic, constants and activity names are untouched. Only the tag names were changed:

- Each equipment unit is numbered in order of first appearance, giving 52 units (`CIP_01` to `CIP_52`).
- Signal words are kept (`Caustic_Supply_Valve`, `Return_Temp`, `Step`), so look-alike tags such as `CIP_20_Step` and `CIP_20_Step_No` still look alike. That matters, because they cause most of the confident misses.
- An equipment number inside a signal keeps only its letter (`Pump_12A` becomes `Pump_A`).

The renaming is one-to-one, every row's expected answer is identical before and after, and `data/tags.json`, regenerated from the published CSV alone, gives the same value for every tag as the original values carried over under the new names.

## Files

| Path | What |
| --- | --- |
| `bench.mts` | The whole benchmark. |
| `single-call-typesafe.mts` | The minimal single-call example. |
| `data/expressions.csv` | The published dataset, with generic tag names. |
| `data/tags.json` | The simulated tag values. Delete it to regenerate. |
| `results/` | One JSON per run. Gitignored. |
