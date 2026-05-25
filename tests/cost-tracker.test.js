// tests/cost-tracker.test.js — Per-thread cost budget helpers.
// Run: node tests/cost-tracker.test.js
//
// We test the two pure helpers exported from lib/agent-manager.js:
//   - computeTurnCostUsd(usage, model) — token → USD
//   - detectBudgetCrossing(prev, current, budget, state) — threshold detector
// No DOM, no IPC, no subprocess — these are the only bits that benefit from
// unit coverage. Renderer wiring (toast, modal, pill) is tested manually.

'use strict';

const assert = require('assert');
const {
  computeTurnCostUsd,
  detectBudgetCrossing,
  COST_RATES,
} = require('../lib/agent-manager.js');

function approx(actual, expected, eps = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ~${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`,
  );
}

async function testCostRatesShape() {
  assert.ok(COST_RATES.sonnet && COST_RATES.opus && COST_RATES.haiku);
  for (const k of Object.keys(COST_RATES)) {
    assert.strictEqual(typeof COST_RATES[k].in, 'number');
    assert.strictEqual(typeof COST_RATES[k].out, 'number');
    assert.ok(COST_RATES[k].in > 0);
    assert.ok(COST_RATES[k].out > 0);
  }
}

async function testComputeTurnCostSonnet() {
  // 1M in + 1M out at sonnet ($3 in, $15 out) = $18.
  const usd = computeTurnCostUsd(
    { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    'sonnet',
  );
  approx(usd, 18, 1e-6);
}

async function testComputeTurnCostOpus() {
  // 1M in + 1M out at opus ($15 in, $75 out) = $90.
  const usd = computeTurnCostUsd(
    { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    'claude-opus-4-7',
  );
  approx(usd, 90, 1e-6);
}

async function testComputeTurnCostHaiku() {
  const usd = computeTurnCostUsd(
    { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    'haiku',
  );
  approx(usd, COST_RATES.haiku.in + COST_RATES.haiku.out, 1e-6);
}

async function testComputeTurnCostCacheDiscount() {
  // Cache read should be billed at 10% of base input rate. With 1M cache_read
  // tokens on sonnet → 0.1 * $3 = $0.30.
  const usd = computeTurnCostUsd(
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 },
    'sonnet',
  );
  approx(usd, 0.3, 1e-6);
}

async function testComputeTurnCostCacheCreate() {
  // Cache creation billed at 125% of base input. 1M tokens on sonnet → $3.75.
  const usd = computeTurnCostUsd(
    { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 },
    'sonnet',
  );
  approx(usd, 3.75, 1e-6);
}

async function testComputeTurnCostMissingUsage() {
  assert.strictEqual(computeTurnCostUsd(null, 'sonnet'), 0);
  assert.strictEqual(computeTurnCostUsd(undefined, 'sonnet'), 0);
  assert.strictEqual(computeTurnCostUsd({}, 'sonnet'), 0);
}

async function testComputeTurnCostUnknownModelDefaultsToSonnet() {
  const a = computeTurnCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, 'sonnet');
  const b = computeTurnCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, 'some-future-model');
  assert.strictEqual(a, b);
}

async function testDetectBudgetCrossingNoBudget() {
  const state = {};
  const r = detectBudgetCrossing(0, 5, null, state);
  assert.strictEqual(r.crossed, null);
}

async function testDetectBudgetCrossingBelowAllThresholds() {
  const state = {};
  const r = detectBudgetCrossing(0, 1, 10, state);
  assert.strictEqual(r.crossed, null);
  assert.ok(!state.warnedAt80);
  assert.ok(!state.warnedAt100);
}

async function testDetectBudgetCrossingFiresWarnAt80Percent() {
  const state = {};
  // Budget=10, cross to 8 → 80% exactly → warn.
  const r = detectBudgetCrossing(7, 8, 10, state);
  assert.strictEqual(r.crossed, 'warn');
  assert.ok(state.warnedAt80);
  assert.ok(!state.warnedAt100);
}

async function testDetectBudgetCrossingWarnFiresOnlyOnce() {
  const state = {};
  const r1 = detectBudgetCrossing(7, 8, 10, state);
  assert.strictEqual(r1.crossed, 'warn');
  // Bumping further but still under 100% → null (already warned).
  const r2 = detectBudgetCrossing(8, 9, 10, state);
  assert.strictEqual(r2.crossed, null);
}

async function testDetectBudgetCrossingFiresExceededAt100Percent() {
  const state = {};
  // Past warning, now cross 100%.
  detectBudgetCrossing(7, 8, 10, state); // → warn
  const r = detectBudgetCrossing(8, 10, 10, state);
  assert.strictEqual(r.crossed, 'exceeded');
  assert.ok(state.warnedAt100);
}

async function testDetectBudgetCrossingExceededWinsOverWarnOnSameTurn() {
  // Single very expensive turn pushes from $0 past BOTH thresholds — the
  // detector must return 'exceeded' (the more severe), and mark both flags
  // so a follow-up warn isn't fired on the next turn.
  const state = {};
  const r = detectBudgetCrossing(0, 20, 10, state);
  assert.strictEqual(r.crossed, 'exceeded');
  assert.ok(state.warnedAt80, 'warn flag is also set so we never re-fire warn');
  assert.ok(state.warnedAt100);
}

async function testDetectBudgetCrossingExceededFiresOnlyOnce() {
  const state = {};
  const r1 = detectBudgetCrossing(0, 20, 10, state);
  assert.strictEqual(r1.crossed, 'exceeded');
  const r2 = detectBudgetCrossing(20, 30, 10, state);
  assert.strictEqual(r2.crossed, null);
}

async function testDetectBudgetCrossingResetAllowsRefiring() {
  // The caller (agent-manager) resets `warnedAt80` / `warnedAt100` when the
  // budget changes or the session id rolls. After a reset the helper should
  // fire each threshold again.
  const state = { warnedAt80: true, warnedAt100: true };
  const r1 = detectBudgetCrossing(20, 30, 10, state);
  assert.strictEqual(r1.crossed, null, 'flags still set → no fire');
  state.warnedAt80 = false;
  state.warnedAt100 = false;
  const r2 = detectBudgetCrossing(0, 10, 10, state);
  assert.strictEqual(r2.crossed, 'exceeded');
}

async function testDetectBudgetCrossingNonPositiveBudgetIsNoop() {
  assert.strictEqual(detectBudgetCrossing(0, 5, 0, {}).crossed, null);
  assert.strictEqual(detectBudgetCrossing(0, 5, -1, {}).crossed, null);
  assert.strictEqual(detectBudgetCrossing(0, 5, NaN, {}).crossed, null);
}

async function run() {
  const tests = [
    ['COST_RATES: has sonnet/opus/haiku rows', testCostRatesShape],
    ['computeTurnCostUsd: sonnet rates', testComputeTurnCostSonnet],
    ['computeTurnCostUsd: opus rates (model id form)', testComputeTurnCostOpus],
    ['computeTurnCostUsd: haiku rates', testComputeTurnCostHaiku],
    ['computeTurnCostUsd: cache_read billed at 10%', testComputeTurnCostCacheDiscount],
    ['computeTurnCostUsd: cache_create billed at 125%', testComputeTurnCostCacheCreate],
    ['computeTurnCostUsd: missing usage is 0', testComputeTurnCostMissingUsage],
    ['computeTurnCostUsd: unknown model → sonnet rates', testComputeTurnCostUnknownModelDefaultsToSonnet],
    ['detectBudgetCrossing: null budget → no fire', testDetectBudgetCrossingNoBudget],
    ['detectBudgetCrossing: below thresholds → no fire', testDetectBudgetCrossingBelowAllThresholds],
    ['detectBudgetCrossing: 80% triggers warn', testDetectBudgetCrossingFiresWarnAt80Percent],
    ['detectBudgetCrossing: warn fires only once', testDetectBudgetCrossingWarnFiresOnlyOnce],
    ['detectBudgetCrossing: 100% triggers exceeded', testDetectBudgetCrossingFiresExceededAt100Percent],
    ['detectBudgetCrossing: exceeded wins over warn on the same turn', testDetectBudgetCrossingExceededWinsOverWarnOnSameTurn],
    ['detectBudgetCrossing: exceeded fires only once', testDetectBudgetCrossingExceededFiresOnlyOnce],
    ['detectBudgetCrossing: reset re-arms detectors', testDetectBudgetCrossingResetAllowsRefiring],
    ['detectBudgetCrossing: non-positive budget is no-op', testDetectBudgetCrossingNonPositiveBudgetIsNoop],
  ];
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok ${name}`); passed++; }
    catch (err) {
      console.error(`  FAIL ${name}`);
      console.error('   ', err && err.stack ? err.stack : err);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
}

run();
