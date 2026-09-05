const assert = require("node:assert/strict");
const sharp = require("sharp");

/** @param {Buffer} pixels @param {number} width @param {number} height @returns {Buffer} */
function removeSpecks(pixels, width, height) {
  assert.equal(pixels.length, width * height);
  const seen = new Uint8Array(pixels.length);
  const queue = new Uint32Array(pixels.length);
  const components = [];
  let end = 0;
  let largest = 0;
  for (let start = 0; start < pixels.length; start++) {
    if (pixels[start] !== 0 || seen[start]) continue;
    const begin = end;
    seen[start] = 1;
    queue[end++] = start;
    for (let cursor = begin; cursor < end; cursor++) {
      const index = queue[cursor];
      const x = index % width;
      for (const neighbor of [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, index - width, index + width]) {
        if (neighbor < 0 || neighbor >= pixels.length || seen[neighbor] || pixels[neighbor] !== 0) continue;
        seen[neighbor] = 1;
        queue[end++] = neighbor;
      }
    }
    largest = Math.max(largest, end - begin);
    components.push({ begin, end });
  }
  const clean = Buffer.alloc(pixels.length, 255);
  for (const component of components) {
    if (component.end - component.begin < largest * 0.15) continue;
    for (let cursor = component.begin; cursor < component.end; cursor++) clean[queue[cursor]] = 0;
  }
  return clean;
}

/** @param {Buffer | string} input @returns {AsyncGenerator<Buffer>} */
async function* noiseVariants(input) {
  // segment before upscaling: interpolation would blur the color histogram and specks.
  const { data, info } = await sharp(input, { limitInputPixels: 16_000_000 }).flatten({ background: "white" }).greyscale()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 1);
  const histogram = new Uint32Array(256);
  for (const value of data) histogram[value]++;
  let peak = 8;
  for (let value = 9; value < 248; value++) if (histogram[value] > histogram[peak]) peak = value;
  if (histogram[peak] >= data.length * 0.01) {
    const mask = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) mask[i] = Math.abs(data[i] - peak) <= 8 ? 0 : 255;
    const filtered = await sharp(mask, { raw: info }).median(3).greyscale().raw().toBuffer();
    yield await sharp(removeSpecks(filtered, info.width, info.height), { raw: info }).png().toBuffer();
  }
  for (const [light, threshold] of [[false, 128], [false, 144], [true, 128]]) {
    const mask = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) mask[i] = (light ? data[i] >= threshold : data[i] < threshold) ? 0 : 255;
    yield await sharp(removeSpecks(mask, info.width, info.height), { raw: info }).png().toBuffer();
  }
}

/** @param {Buffer | string} input @returns {AsyncGenerator<{png: Buffer, psm: string}>} */
async function* imageVariants(input) {
  const source = sharp(input, { limitInputPixels: 16_000_000 });
  const metadata = await source.metadata();
  const width = Math.min(1600, Math.max(metadata.width, 1000));
  // a text-block pass avoids treating small, spaced letters as a full page layout.
  yield { png: await source.clone().flatten({ background: "white" }).resize({ width, height: 1600, fit: "inside" }).extend({ top: 20, bottom: 20, left: 20, right: 20, background: "white" }).png().toBuffer(), psm: "6" };
  for await (const mask of noiseVariants(input)) {
    yield { png: await sharp(mask).resize({ width, height: 1600, fit: "inside" }).extend({ top: 20, bottom: 20, left: 20, right: 20, background: "white" }).png().toBuffer(), psm: "6" };
  }
  for (const rotation of [0, 90, 180, 270]) {
    for (const background of metadata.hasAlpha ? ["white", "black"] : ["white"]) {
      yield { png: await source.clone().flatten({ background }).rotate(rotation).resize({ width, height: 1600, fit: "inside" }).normalise().sharpen().png().toBuffer(), psm: "3" };
    }
  }
}

module.exports = { imageVariants, noiseVariants, removeSpecks };
