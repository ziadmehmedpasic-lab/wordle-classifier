const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const sharp = require("sharp");
const { ocrImage, close } = require("../ocr");
const detector = require("../detector");

detector.setAnswers(["wager"]);
after(close);

test("real OCR reads upright, rotated, low-contrast and transparent text", async () => {
  const svg = await fs.readFile("test/fixtures/spoiler.svg");
  const png = await sharp(svg).png().toBuffer();
  const transparent = Buffer.from(svg.toString().replace('<rect width="320" height="100" fill="white"/>', "").replace('fill="black"', 'fill="white"'));
  const cases = [png, await sharp(png).rotate(90).toBuffer(), await sharp(png).linear(0.05, 200).toBuffer(), await sharp(transparent).png().toBuffer()];
  for (const [index, image] of cases.entries()) assert.equal(detector.scan(await ocrImage(image)), "wager", `image ${index}`);
});

test("a blank image is retained, and a broken image does not poison the next job", async () => {
  const blank = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toBuffer();
  assert.equal(detector.scan(await ocrImage(blank)), null);
  await assert.rejects(ocrImage(Buffer.from("not an image")));
  const png = await sharp(await fs.readFile("test/fixtures/spoiler.svg")).png().toBuffer();
  assert.equal(detector.scan(await ocrImage(png)), "wager");
});
