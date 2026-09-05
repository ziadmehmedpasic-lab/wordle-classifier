const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const sharp = require("sharp");
const { removeSpecks, imageVariants } = require("../ocr-preprocess");
const llm = require("../llm");

test("speck removal does not join components across row edges or mutate its input", () => {
  const input = Buffer.alloc(100, 255);
  for (const row of [3, 4]) input.fill(0, row * 10 + 2, row * 10 + 7);
  input[9] = 0;
  input[10] = 0;
  const original = Buffer.from(input);
  const clean = removeSpecks(input, 10, 10);
  assert.deepEqual(input, original);
  assert.equal(clean[9], 255);
  assert.equal(clean[10], 255);
  assert.equal([...clean].filter((value) => value === 0).length, 10);
  assert.deepEqual(removeSpecks(Buffer.alloc(1, 255), 1, 1), Buffer.from([255]));
  assert.deepEqual(removeSpecks(Buffer.from([0]), 1, 1), Buffer.from([0]));
});

test("OCR variants stay bounded for a tall, narrow image", async () => {
  const input = await sharp({ create: { width: 2, height: 4000, channels: 4, background: "white" } }).png().toBuffer();
  let count = 0;
  for await (const { png } of imageVariants(input)) {
    const metadata = await sharp(png).metadata();
    assert.ok(metadata.width <= 1640 && metadata.height <= 1640);
    count++;
  }
  assert.ok(count > 0 && count <= 13);
});

test("vision receives the original image without depending on successful OCR", async () => {
  const previous = llm.cfg.enabled;
  llm.cfg.enabled = true;
  try {
    const input = await fs.readFile("test/fixtures/noisy-images/handwriting.png");
    let content;
    await llm.classify({ text: "", answers: ["wager"], imageUrls: [`data:image/png;base64,${input.toString("base64")}`] }, { beta: { messages: { create: async (request) => {
      content = request.messages[0].content;
      return { content: [{ type: "text", text: '{"verdict":"clean","confidence":1,"reason":"transport test"}' }] };
    } } } });
    const images = content.filter((part) => part.type === "image");
    assert.equal(images.length, 1);
    assert.deepEqual(Buffer.from(images[0].source.data, "base64"), input);
  } finally { llm.cfg.enabled = previous; }
});

test("all original images reach bounded vision batches, including a positive last batch", async () => {
  const previous = llm.cfg.enabled;
  llm.cfg.enabled = true;
  try {
    const images = Array.from({ length: 21 }, (_, index) => `https://example.com/${index}.png`);
    const seen = [];
    let calls = 0;
    const result = await llm.classify({ text: "", answers: ["wager"], imageUrls: images }, { beta: { messages: { create: async (request) => {
      const batch = request.messages[0].content.filter((part) => part.type === "image");
      assert.ok(batch.length <= 20);
      seen.push(...batch.map((part) => part.source.url));
      calls++;
      const verdict = seen.includes(images.at(-1)) ? "spoiler" : "clean";
      return { content: [{ type: "text", text: JSON.stringify({ verdict, confidence: 1, reason: "transport test" }) }] };
    } } } });
    assert.equal(calls, 2);
    assert.deepEqual(seen, images);
    assert.equal(result.verdict, "spoiler");
  } finally { llm.cfg.enabled = previous; }
});
