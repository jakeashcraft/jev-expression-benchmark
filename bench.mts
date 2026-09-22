// Runs every expression in data/expressions.csv through Jev via the TypeSafe API and times it.
//   node bench.mts --limit 20                               smoke run
//   node bench.mts --batch 1,25,50,100 --concurrency 128    sweep expressions per request
//   node bench.mts --batch 50,50,50 --concurrency 128       repeat one config
//   node bench.mts --batch 100 --retries 0                  raw failure rate, no retries
import { APIConnectionError, APIError, TypeSafeClient } from '@typesafe-ai/sdk';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

type TagValue = boolean | number;
type Snapshot = Record<string, TagValue>;
type Row = { id: string; name: string; expr: string; tags: string[]; truth: (...values: TagValue[]) => boolean; expected: boolean };
type Payload = { state: Snapshot; questions: Record<string, { type: 'noul'; instructions: string }> };
type Request = Payload & { rows: Row[] };
type Outcome = { ms: number; serverMs?: number; retries: number; tokens: number; answers?: Record<string, { noul: number }>; error?: string };

const { values: args } = parseArgs({
  options: {
    batch: { type: 'string', default: '1' }, // expressions per request; comma list sweeps
    concurrency: { type: 'string', default: '16' }, // requests in flight; comma list sweeps
    limit: { type: 'string' }, // only the first N rows, for cheap smoke runs
    retries: { type: 'string', default: '2' }, // per request, for retryable errors; 0 shows the raw failure rate
    model: { type: 'string', default: 'jev-latest' },
  },
});
const maxRetries = Number(args.retries);
assert(Number.isInteger(maxRetries) && maxRetries >= 0, `--retries must be a non-negative integer, got "${args.retries}"`);
const integers = (value: string) => {
  const list = value.split(',').map(Number);
  assert(list.every(n => Number.isInteger(n) && n > 0), `expected positive integers, got "${value}"`);
  return list;
};

// Ground truth: the grammar is a subset of JavaScript, and JS loose equality gives the
// true == 1 / false == 0 coercion that the mixed Boolean/number tags need.
// Safe to compile: only whitelisted tokens get through, and every identifier becomes a parameter.
const TOKENS = /\s+|&&|\|\||[=!]=|[<>]=?|[()!]|-?\d+(?:\.\d+)?|[A-Za-z_]\w*/g;
const BOOLEAN = /\b(?:true|false)\b/gi;
const tagsOf = (expr: string) => [...new Set(expr.replace(BOOLEAN, '').match(/[A-Za-z_]\w*/g))];
const compile = (expr: string, tags: string[]) =>
  Function(...tags, `return !!(${expr.replace(BOOLEAN, literal => literal.toLowerCase())})`) as Row['truth'];
const evaluateLocally = (row: Row, snapshot: Snapshot) => row.truth(...row.tags.map(tag => snapshot[tag]));

const check = (expr: string, state: Snapshot) => compile(expr, Object.keys(state))(...Object.values(state));
assert.equal(check('A == true && T > 150', { A: true, T: 151 }), true);
assert.equal(check('A == true && T > 150', { A: true, T: 150 }), false);
assert.equal(check('A == 1 || S != 7', { A: true, S: 7 }), true); // true equals 1
assert.equal(check('S <= 13 && S >= 14', { S: 13 }), false);

// ponytail: naive CSV split (no quoted fields) - use a CSV parser if a Name ever contains a comma
const rows: Row[] = [];
const skipped: string[] = [];
const lines = readFileSync(new URL('data/expressions.csv', import.meta.url), 'utf8').split(/\r?\n/);
for (const [index, line] of lines.entries()) {
  if (index === 0 || !line.trim()) continue;
  const comma = line.indexOf(',');
  const expr = line.slice(comma + 1).trim();
  try {
    assert(expr && expr.replace(TOKENS, '') === '' && !/[\w)]\s*\(/.test(expr), 'unsupported syntax');
    const tags = tagsOf(expr);
    rows.push({ id: `r${index + 1}`, name: line.slice(0, comma), expr, tags, truth: compile(expr, tags), expected: false });
  } catch (error) {
    skipped.push(`line ${index + 1}: ${(error as Error).message}`);
  }
}
if (skipped.length) console.warn(`skipped ${skipped.length} rows:\n  ${skipped.join('\n  ')}`);

// The simulated PLC: one value per tag in data/tags.json. Edit it by hand, or delete it to regenerate.
// ponytail: assumes `tag op literal` order (true for every row today); literal-first comparisons get a Boolean domain
const COMPARISON = /([A-Za-z_]\w*)\s*(?:[=!]=|[<>]=?)\s*(true|false|-?\d+(?:\.\d+)?)/gi;
const literals = new Map<string, Set<string>>();
for (const row of rows) {
  for (const tag of row.tags) if (!literals.has(tag)) literals.set(tag, new Set());
  for (const [, tag, literal] of row.expr.matchAll(COMPARISON)) literals.get(tag)?.add(literal.toLowerCase());
}

function domainOf(compared: Set<string>): TagValue[] {
  const numbers = [...compared].filter(literal => literal !== 'true' && literal !== 'false').map(Number);
  const isBoolean = numbers.every(n => n === 0 || n === 1) && (numbers.length < compared.size || !numbers.length);
  if (isBoolean) return [true, false];
  // Boundary values: each compared constant and its neighbours, where >, >= and == disagree.
  return [...new Set(numbers.flatMap(n => [n - 1, n, n + 1]))].filter(n => n >= 0);
}

function generateSnapshot(): Snapshot {
  let seed = 42;
  const random = () => { // mulberry32: seeded, so the generated file is reproducible
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const domains = [...literals].map(([tag, compared]) => [tag, domainOf(compared)] as const);
  let best: Snapshot = {};
  let bestGap = Infinity;
  // Random values make most expressions false; keep the draw closest to a 50/50 true/false split.
  for (let draw = 0; draw < 5000; draw++) {
    const candidate = Object.fromEntries(domains.map(([tag, domain]) => [tag, domain[Math.floor(random() * domain.length)]]));
    const gap = Math.abs(rows.filter(row => evaluateLocally(row, candidate)).length / rows.length - 0.5);
    if (gap < bestGap) [best, bestGap] = [candidate, gap];
  }
  return best;
}

const snapshotFile = new URL('data/tags.json', import.meta.url);
if (!existsSync(snapshotFile)) writeFileSync(snapshotFile, JSON.stringify(generateSnapshot(), null, 2));
const snapshot: Snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
const missing = [...literals.keys()].filter(tag => !(tag in snapshot));
assert(!missing.length, `data/tags.json is missing ${missing.length} tags (e.g. ${missing[0]}) - delete it to regenerate`);
assert(Object.values(snapshot).every(value => typeof value === 'boolean' || Number.isFinite(value)), 'data/tags.json values must be Booleans or numbers');

const localStarted = performance.now();
for (const row of rows) row.expected = evaluateLocally(row, snapshot);
const localMs = performance.now() - localStarted;

const selected = rows.slice(0, args.limit ? integers(args.limit)[0] : undefined);
const expectedTrue = selected.filter(row => row.expected).length;
console.log(`${selected.length} expressions, ${literals.size} tags, expected ${expectedTrue} true / ${selected.length - expectedTrue} false`);
console.log(`local JS evaluation of all ${rows.length} rows: ${localMs.toFixed(2)} ms\n`);

const RULES =
  'Evaluate the Boolean expression against the tag values in the state; tag names are state keys. ' +
  '&& is AND, || is OR, and && binds tighter than ||. true equals 1 and false equals 0.';
const question = (expr: string) => ({ type: 'noul' as const, instructions: `${RULES}\nExpression: ${expr}` });
// Warm-up uses a payload the timed pass never sends, so no cache anywhere can flatter the numbers.
const WARMUP: Payload = { state: { WARMUP_TAG: true }, questions: { warmup: question('WARMUP_TAG == true') } };

function buildRequests(batch: number): Request[] {
  const requests: Request[] = [];
  for (let start = 0; start < selected.length; start += batch) {
    const chunk = selected.slice(start, start + batch);
    requests.push({
      rows: chunk,
      state: Object.fromEntries(chunk.flatMap(row => row.tags).map(tag => [tag, snapshot[tag]])),
      questions: Object.fromEntries(chunk.map(row => [row.id, question(row.expr)])),
    });
  }
  return requests;
}

// The SDK's own retry backs off from 500 ms and hides the count, so it is off (maxRetries: 0) and
// retryable errors are retried below after a short jittered delay, and counted.
const client = new TypeSafeClient({ timeout: 60_000, retry: { maxRetries: 0 } });

async function send({ state, questions }: Payload): Promise<Outcome> {
  const started = performance.now(); // ms covers every attempt and delay: it is how long the caller waited
  for (let retries = 0; ; retries++) {
    try {
      const { data, response } = await client.systemOne({ model: args.model, state, questions }).withResponse();
      const ms = performance.now() - started;
      // Envoy's header: how long TypeSafe's edge proxy waited on the service behind it, so ms minus this is
      // network + proxy. It is not in TypeSafe's docs, so it may vanish; the column is then NaN.
      const serverMs = Number(response.headers.get('x-envoy-upstream-service-time')) || undefined;
      return { ms, serverMs, retries, tokens: data.usage.input_tokens, answers: data.answers };
    } catch (error) {
      const { message, retryAfterMs } = error as { message: string; retryAfterMs?: number }; // an APIError's message leads with its status
      // Same errors the SDK would retry: connection failures and timeouts, 408, 429 and 5xx (529 is overload).
      const isRetryable = error instanceof APIConnectionError || (error instanceof APIError && client.retry.httpStatuses.has(error.status));
      if (isRetryable && retries < maxRetries) {
        await sleep(retryAfterMs ?? (retries + 1) * (50 + Math.random() * 100)); // a 429's retry-after wins
        continue;
      }
      return { ms: performance.now() - started, retries, tokens: 0, error: message };
    }
  }
}

async function sendAll(payloads: Payload[], concurrency: number): Promise<Outcome[]> {
  const outcomes: Outcome[] = new Array(payloads.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, payloads.length) }, async () => {
    while (next < payloads.length) {
      const index = next++;
      outcomes[index] = await send(payloads[index]);
    }
  }));
  return outcomes;
}

const JEV_USD_PER_MTOK = 0.042; // Jev input price; output tokens are free. Wrong for any other --model.
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;
const round = (value: number, digits = 0) => Number(value.toFixed(digits));
const runs = [];

for (const batch of integers(args.batch)) { // repeat a value (--batch 50,50,50) to repeat a config
  const buildStarted = performance.now();
  const requests = buildRequests(batch);
  const buildMs = performance.now() - buildStarted;

  const seen = new Set<number>(); // concurrency is capped at the request count, so big values collapse
  for (const requested of integers(args.concurrency)) {
    const concurrency = Math.min(requested, requests.length);
    if (seen.has(concurrency)) continue;
    seen.add(concurrency);

    // Untimed: one keep-alive socket per worker, so TLS handshakes stay out of the measurement.
    const warmupStarted = performance.now();
    const warmup = await sendAll(Array(concurrency).fill(WARMUP), concurrency);
    const warmupMs = performance.now() - warmupStarted;
    if (warmup.every(outcome => outcome.error)) {
      // Skip, don't throw: an abort here would lose the results of every config that already ran.
      console.warn(`batch ${batch} x conc ${concurrency}: skipped, every warm-up request failed: ${warmup[0].error}`);
      continue;
    }

    const started = performance.now();
    const outcomes = await sendAll(requests, concurrency);
    const wallMs = performance.now() - started;

    const scored = outcomes.flatMap((outcome, index) =>
      (outcome.answers ? requests[index].rows : []).map(row => {
        const probability = outcome.answers![row.id].noul;
        return { row, probability, correct: probability >= 0.5 === row.expected };
      }));
    const accuracy = (subset: typeof scored) => round((100 * subset.filter(item => item.correct).length) / subset.length, 2);
    const latencies = outcomes.filter(outcome => !outcome.error).map(outcome => outcome.ms).sort((a, b) => a - b);
    const serverLatencies = outcomes.flatMap(outcome => outcome.serverMs ?? []).sort((a, b) => a - b);
    const failures: Record<string, number> = {};
    for (const { error } of outcomes) if (error) failures[error] = (failures[error] ?? 0) + 1;
    const tokens = outcomes.reduce((sum, outcome) => sum + outcome.tokens, 0);
    const retries = outcomes.reduce((sum, outcome) => sum + outcome.retries, 0);

    const summary = {
      batch,
      conc: concurrency,
      reqs: requests.length,
      'build ms': round(buildMs, 2),
      'warmup ms': round(warmupMs),
      'wall s': round(wallMs / 1000, 3),
      'expr/s': round(scored.length / (wallMs / 1000)),
      'p50 ms': round(percentile(latencies, 0.5)),
      'p95 ms': round(percentile(latencies, 0.95)),
      'max ms': round(latencies.at(-1) ?? NaN),
      'server p50 ms': round(percentile(serverLatencies, 0.5)),
      retries, // transient errors absorbed; wall time and latencies include them
      failed: outcomes.length - latencies.length, // still failing after every retry
      'acc %': accuracy(scored),
      'acc true %': accuracy(scored.filter(item => item.row.expected)),
      'acc false %': accuracy(scored.filter(item => !item.row.expected)),
      tokens,
      'cost $': round((tokens * JEV_USD_PER_MTOK) / 1e6, 5),
    };
    console.log(`batch ${batch} x conc ${concurrency}: ${summary['wall s']} s, ${summary['expr/s']} expr/s, ${summary['acc %']}% correct, ${retries} retries, ${summary.failed} failed`);
    for (const [error, count] of Object.entries(failures).slice(0, 3)) console.warn(`  ${count}x ${error.slice(0, 200)}`);

    runs.push({
      summary,
      failures,
      requests: outcomes.map(({ ms, serverMs, retries, tokens, error }, index) => ({ expressions: requests[index].rows.length, ms: round(ms), serverMs, retries, tokens, error })),
      mismatches: scored.filter(item => !item.correct).map(({ row, probability }) => ({
        id: row.id,
        name: row.name,
        expr: row.expr,
        state: Object.fromEntries(row.tags.map(tag => [tag, snapshot[tag]])),
        expected: row.expected,
        probability,
      })),
      probabilities: Object.fromEntries(scored.map(({ row, probability }) => [row.id, probability])),
    });
  }
}

console.table(runs.map(run => run.summary), ['batch', 'conc', 'reqs', 'wall s', 'expr/s', 'p50 ms', 'p95 ms', 'max ms', 'server p50 ms', 'retries', 'failed', 'acc %', 'tokens', 'cost $']);
mkdirSync(new URL('results/', import.meta.url), { recursive: true });
const resultsFile = new URL(`results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
writeFileSync(resultsFile, JSON.stringify({ model: args.model, rules: RULES, expressions: selected.length, expectedTrue, localMs, runs }, null, 2));
console.log(`details: ${resultsFile.pathname.split('/').slice(-2).join('/')}`);
