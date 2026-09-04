const { test } = require("node:test");
const assert = require("node:assert/strict");
const { transliterate } = require("../translit");
const detector = require("../detector");

test("long ambiguous script tokens cannot expand into large candidate strings", () => {
  assert.deepEqual(transliterate("و".repeat(200_000)), []);
  const rows = transliterate("و".repeat(20));
  assert.ok(rows.every((row) => row.variants.length <= 256 && row.variants.every((word) => word.length <= 40)));
});

test("script matching can be disabled independently of the existing detector", () => {
  detector.setAnswers(["wager"]);
  detector.configure({ scripts: false });
  try {
    assert.equal(detector.scan("وايجر"), null);
    assert.equal(detector.scan("WAGER"), "wager");
  } finally { detector.configure({ scripts: true }); }
  assert.equal(detector.scan("وايجر"), "wager");
});
