const assert = require("node:assert/strict");

/** @param {object[]} rows @returns {object} */
function summarize(rows) {
  assert.ok(rows.length > 0, "evaluation has no cases");
  const attacks = rows.filter((row) => row.expected.length > 0);
  const benign = rows.filter((row) => row.expected.length === 0);
  const missed = attacks.filter((row) => row.expected.some((id) => !row.removed.includes(id)));
  const falseDeletions = rows.filter((row) => row.removed.some((id) => !row.expected.includes(id)));
  const times = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
  return {
    cases: rows.length, attacks: attacks.length, benign: benign.length,
    missedSpoilers: missed.map((row) => row.id), falseDeletions: falseDeletions.map((row) => row.id),
    incomplete: rows.filter((row) => row.steps.some((step) => step.status === "unscanned")).map((row) => row.id),
    recall: attacks.length ? (attacks.length - missed.length) / attacks.length : null,
    latencyMs: { median: times[Math.ceil(times.length / 2) - 1], p95: times[Math.ceil(times.length * 0.95) - 1], total: times.reduce((a, b) => a + b, 0) },
    requests: rows.reduce((n, row) => n + row.requests.length, 0),
    apiFailures: rows.reduce((n, row) => n + row.requests.filter((request) => request.error).length, 0),
    estimatedCostUsd: rows.every((row) => row.estimatedCostUsd !== null) ? rows.reduce((n, row) => n + row.estimatedCostUsd, 0) : null,
  };
}

/** @param {object[]} requests @param {object | null} prices @returns {number | null} */
function estimateCost(requests, prices) {
  if (!requests.length) return 0;
  if (!prices || requests.some((request) => !request.usage)) return null;
  if (requests.some((request) => request.model && request.model !== prices.model && !request.model.startsWith(prices.model + "-"))) return null;
  for (const key of ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"]) assert.ok(Number.isFinite(prices[key]) && prices[key] >= 0, `missing or invalid price: ${key}`);
  return requests.reduce((total, { usage }) => {
    const five = usage.cache_creation?.ephemeral_5m_input_tokens || 0;
    const hour = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
    assert.equal(five + hour, usage.cache_creation_input_tokens || 0, "cache write usage lacks TTL breakdown; cannot price it accurately");
    return total + ((usage.input_tokens || 0) * prices.input + (usage.output_tokens || 0) * prices.output + (usage.cache_read_input_tokens || 0) * prices.cacheRead + five * prices.cacheWrite5m + hour * prices.cacheWrite1h) / 1_000_000;
  }, 0);
}

module.exports = { summarize, estimateCost };
