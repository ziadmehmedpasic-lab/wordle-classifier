const { test } = require("node:test");
const assert = require("node:assert/strict");
const { inspectMessage, limits } = require("../inspection");
const detector = require("../detector");

detector.setAnswers(["wager"]);
const judge = { cfg: { enabled: true, vision: true }, noteContext() {}, shouldCheck: () => true, classify: async () => ({ verdict: "clean" }), shouldDelete: () => false };

test("attachment and vision caps produce unscanned results", async () => {
  const saved = { ...limits };
  Object.assign(limits, { assets: 1, images: 1 });
  try {
    const result = await inspectMessage({ channelId: "channel", attachments: [{ url: "first" }, { url: "second" }] }, {
      judge, describe: async () => "", extract: async () => ({ text: "hello", images: ["image-one", "image-two"], issues: [] }),
    });
    assert.equal(result.status, "unscanned");
    assert.ok(result.issues.includes("message attachment limit exceeded"));
    assert.ok(result.issues.includes("message vision limit exceeded"));
  } finally { Object.assign(limits, saved); }
});

test("saturation keeps direct text protection and reports rejected slow inspections", async () => {
  const saved = { ...limits };
  Object.assign(limits, { concurrent: 1, waiting: 0 });
  let release;
  const running = inspectMessage({ channelId: "channel", attachments: [{ url: "image" }] }, {
    judge, describe: async () => "", extract: async () => new Promise((resolve) => { release = resolve; }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    const rejected = await inspectMessage({ channelId: "channel", content: "hello" }, { judge, describe: async () => "" });
    assert.equal(rejected.status, "unscanned");
    assert.ok(rejected.issues.includes("inspection queue full"));
    const direct = await inspectMessage({ channelId: "channel", content: "WAGER" }, { judge, describe: async () => "" });
    assert.equal(direct.status, "spoiler");
  } finally {
    release({ text: "hello", images: [], issues: [] });
    await running;
    Object.assign(limits, saved);
  }
  assert.equal((await inspectMessage({ content: "hello" }, { judge, describe: async () => "" })).status, "clean");
});

test("external linked pages are not labelled fully inspected", async () => {
  const result = await inspectMessage({ content: "https://example.com/page" }, { judge, describe: async () => "" });
  assert.equal(result.status, "unscanned");
});

test("expired queue waits are removed and do not consume future inspection slots", async () => {
  const saved = { ...limits };
  Object.assign(limits, { concurrent: 1, waiting: 1, waitMs: 5 });
  let release;
  const running = inspectMessage({ attachments: [{ url: "image" }] }, { judge, describe: async () => "", extract: async () => new Promise((resolve) => { release = resolve; }) });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    const result = await inspectMessage({ content: "hello" }, { judge, describe: async () => "" });
    assert.ok(result.issues.includes("inspection queue wait expired"));
  } finally {
    release({ text: "hello", images: [], issues: [] });
    await running;
    Object.assign(limits, saved);
  }
  assert.equal((await inspectMessage({ content: "hello" }, { judge, describe: async () => "" })).status, "clean");
});
