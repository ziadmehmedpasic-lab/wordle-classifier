const { test } = require("node:test");
const assert = require("node:assert/strict");
const { summarize, estimateCost } = require("../eval/metrics");

test("misses include incomplete scans and false deletions include innocent contributors", () => {
  const base = { latencyMs: 1, requests: [], estimatedCostUsd: 0 };
  const result = summarize([
    { ...base, id: "cap", expected: ["1"], removed: [], steps: [{ status: "unscanned" }] },
    { ...base, id: "split", expected: ["2", "3"], removed: ["1", "2", "3"], steps: [] },
    { ...base, id: "benign", expected: [], removed: [], steps: [] },
  ]);
  assert.deepEqual(result.missedSpoilers, ["cap"]);
  assert.deepEqual(result.falseDeletions, ["split"]);
  assert.equal(result.recall, 0.5);
  assert.equal(result.estimatedCostUsd, 0);
  assert.throws(() => summarize([]));
});

test("cost accounts for every response, cache TTL and missing usage", () => {
  const prices = { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 };
  const request = { usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 2_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 } } };
  assert.equal(estimateCost([request, request], prices), 37.4);
  assert.equal(estimateCost([{ usage: null }], prices), null);
  assert.equal(estimateCost([request], null), null);
  assert.equal(estimateCost([], null), 0);
  assert.throws(() => estimateCost([{ usage: { cache_creation_input_tokens: 1 } }], prices), /TTL breakdown/);
});
