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

test("real OCR recovers letters from supplied noisy images and JPEG copies", async () => {
  try {
    for (const [name, answer] of [["flat-gray", "soupy"], ["static", "wager"], ["dots", "wager"]]) {
      detector.setAnswers([answer]);
      const input = await fs.readFile(`test/fixtures/noisy-images/${name}.png`);
      for (const [index, image] of [input, await sharp(input).jpeg({ quality: 85 }).toBuffer()].entries()) {
        const text = await ocrImage(image);
        assert.ok(text.toLowerCase().replace(/\s/g, "").includes(answer), `${name} variant ${index}: ${text}`);
      }
    }
  } finally { detector.setAnswers(["wager"]); }
});

test("noise and unrelated image text do not turn into the protected answer", async () => {
  const staticImage = sharp("test/fixtures/noisy-images/static.png");
  const dots = sharp("test/fixtures/noisy-images/dots.png");
  const controls = [
    await staticImage.extract({ left: 0, top: 0, width: 261, height: 20 }).resize({ height: 77, width: 261 }).png().toBuffer(),
    await dots.extract({ left: 0, top: 65, width: 262, height: 15 }).resize({ height: 80, width: 262 }).png().toBuffer(),
    await fs.readFile("test/fixtures/noisy-images/flat-gray.png"),
  ];
  for (const [index, image] of controls.entries()) assert.equal(detector.scan(await ocrImage(image)), null, `benign image ${index}`);
});
