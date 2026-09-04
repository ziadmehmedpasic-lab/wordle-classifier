const { test } = require("node:test");
const assert = require("node:assert/strict");
const { collectContent, inspectMessage } = require("../inspection");
const detector = require("../detector");
const llm = require("../llm");

detector.setAnswers(["wager"]);

/** @param {object} overrides @returns {object} */
function message(overrides = {}) {
  return { id: "1", channelId: "channel", content: "", attachments: new Map(), ...overrides };
}

/** @param {object[]} calls @returns {object} */
function judge(calls) {
  return {
    cfg: { enabled: true, vision: true },
    noteContext() {},
    shouldCheck: () => true,
    classify: async (input) => { calls.push(input); return { verdict: "clean" }; },
    shouldDelete: (result) => result.verdict === "spoiler",
  };
}

test("forwarded media and deeply nested component text are collected", () => {
  const result = collectContent(message({
    messageSnapshots: new Map([["forward", { content: "forwarded", attachments: [{ id: "image", url: "https://example.com/image", contentType: "image/png" }] }]]),
    components: [{ components: [{ components: [{ content: "WAGER" }] }] }],
    embeds: [{ image: { url: "https://example.com/a" }, thumbnail: { url: "https://example.com/b" } }],
  }));
  assert.match(result.text, /forwarded/);
  assert.match(result.text, /WAGER/);
  assert.equal(result.assets.length, 3);
});

test("caption and OCR fragments are checked together", async () => {
  const result = await inspectMessage(message({ content: "WA", attachments: [{ url: "image" }] }), {
    extract: async () => ({ text: "GER", images: [], issues: [] }),
    judge: judge([]), describe: async () => "",
  });
  assert.equal(result.status, "spoiler");
  assert.equal(result.hit, "wager");
});

test("file hints, OCR and transcripts reach the judge even for bot authors", async () => {
  const calls = [];
  const texts = ["something you do at a casino", "read this picture", "spoken clue"];
  const result = await inspectMessage(message({ author: { bot: true }, attachments: texts.map((text, id) => ({ url: String(id), text })) }), {
    extract: async (asset) => ({ text: asset.text, images: [], issues: [] }),
    judge: judge(calls), describe: async () => "",
  });
  assert.equal(result.status, "clean");
  assert.equal(calls.length, 1);
  for (const text of texts) assert.ok(calls[0].text.includes(text));
});

test("partial extraction preserves other evidence and does not mean clean", async () => {
  const calls = [];
  const result = await inspectMessage(message({ attachments: [{ url: "bad" }, { url: "good" }] }), {
    extract: async (asset) => {
      if (asset.url === "bad") throw new Error("decoder failed");
      return { text: "a harmless document", images: [], issues: [] };
    },
    judge: judge(calls), describe: async () => "",
  });
  assert.equal(result.status, "unscanned");
  assert.match(result.issues[0], /decoder failed/);
  assert.match(calls[0].text, /harmless document/);
});

test("a direct spoiler is still removed when a different attachment fails", async () => {
  const result = await inspectMessage(message({ attachments: [{ url: "bad" }, { url: "good" }] }), {
    extract: async (asset) => {
      if (asset.url === "bad") throw new Error("decoder failed");
      return { text: "WAGER", images: [], issues: [] };
    },
    judge: judge([]), describe: async () => "",
  });
  assert.equal(result.status, "spoiler");
});

test("images trigger the judge in a cold channel and none are silently sliced away", async () => {
  const enabled = llm.cfg.enabled;
  llm.cfg.enabled = true;
  try {
    assert.equal(llm.shouldCheck("cold", "", true), true);
    let request;
    const client = { beta: { messages: { create: async (input) => {
      request = input;
      return { content: [{ type: "text", text: JSON.stringify({ verdict: "clean", confidence: 1, reason: "benign" }) }] };
    } } } };
    const imageUrls = ["a", "b", "c", "d"].map((id) => `https://example.com/${id}.png`);
    await llm.classify({ text: "", answers: ["wager"], imageUrls }, client);
    assert.deepEqual(request.messages[0].content.filter((part) => part.type === "image").map((part) => part.source.url), imageUrls);
  } finally { llm.cfg.enabled = enabled; }
});

test("an excessive nesting depth is reported", () => {
  let nested = { content: "buried" };
  for (let i = 0; i < 10; i++) nested = { components: [nested] };
  assert.deepEqual(collectContent(nested).issues, ["nested content exceeds depth limit"]);
});
