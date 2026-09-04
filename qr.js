const sharp = require("sharp");
const jsQR = require("jsqr");
const detector = require("./detector");

/** @param {Buffer | string} input @returns {Promise<string[]>} */
async function decodeQr(input) {
  const source = sharp(input, { limitInputPixels: 16_000_000 });
  const texts = new Set();
  for (const background of ["white", "black"]) {
    const { data, info } = await source.clone().flatten({ background }).resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const regions = [{ left: 0, top: 0, width: info.width, height: info.height }];
    // overlapping halves keep separate finder patterns from confusing a single-code locator.
    for (const left of [0, Math.floor(info.width * 0.4)]) regions.push({ left, top: 0, width: Math.ceil(info.width * 0.6), height: info.height });
    for (const top of [0, Math.floor(info.height * 0.4)]) regions.push({ left: 0, top, width: info.width, height: Math.ceil(info.height * 0.6) });
    for (const region of regions) {
      const cropped = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).extract(region).raw().toBuffer();
      const pixels = new Uint8ClampedArray(cropped);
      for (let attempt = 0; attempt <= 8; attempt++) {
        const code = jsQR(pixels, region.width, region.height, { inversionAttempts: "attemptBoth" });
        if (!code) break;
        if (attempt === 8) throw new Error("QR code inspection limit exceeded");
        texts.add(code.data);
        if (detector.scan([...texts].join("\n"))) return [...texts];
        // mask this code only in the decoder's copy; OCR and vision retain the original image.
        const corners = [code.location.topLeftCorner, code.location.topRightCorner, code.location.bottomLeftCorner, code.location.bottomRightCorner];
        const left = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.x))));
        const right = Math.min(region.width, Math.ceil(Math.max(...corners.map((point) => point.x))));
        const top = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.y))));
        const bottom = Math.min(region.height, Math.ceil(Math.max(...corners.map((point) => point.y))));
        for (let y = top; y < bottom; y++) pixels.fill(255, (y * region.width + left) * 4, (y * region.width + right) * 4);
      }
    }
  }
  return [...texts];
}

module.exports = { decodeQr };
