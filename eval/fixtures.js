const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const sharp = require("sharp");
const QRCode = require("qrcode");
const { PDFDocument } = require("pdf-lib");
const { ZipFile } = require("yazl");
const { readLimited } = require("../download");

/** @param {string} directory @returns {Promise<void>} */
async function buildFixtures(directory) {
  await fs.mkdir(directory, { recursive: true });
  const svg = await fs.readFile(path.join(__dirname, "../test/fixtures/spoiler.svg"));
  const png = await sharp(svg).png().toBuffer();
  const blank = await sharp({ create: { width: 320, height: 100, channels: 3, background: "white" } }).png().toBuffer();
  const transparent = Buffer.from(svg.toString().replace('<rect width="320" height="100" fill="white"/>', "").replace('fill="black"', 'fill="white"'));
  const images = {
    "upright.png": png, "blank.png": blank,
    "rotated.png": await sharp(png).rotate(90).toBuffer(),
    "low-contrast.png": await sharp(png).linear(0.05, 200).toBuffer(),
    "transparent.png": await sharp(transparent).png().toBuffer(),
    "qr.png": await QRCode.toBuffer("WAGER", { width: 320 }),
    "benign-qr.png": await QRCode.toBuffer("coffee", { width: 320 }),
    "text.bin": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("WAGER", "utf16le")]),
  };
  for (const [name, right] of [["adjacent-qr.png", images["qr.png"]], ["benign-adjacent-qr.png", images["benign-qr.png"]]]) {
    images[name] = await sharp({ create: { width: 680, height: 340, channels: 3, background: "white" } }).composite([{ input: images["benign-qr.png"], left: 10, top: 10 }, { input: right, left: 350, top: 10 }]).png().toBuffer();
  }
  for (const [name, bytes] of Object.entries(images)) await fs.writeFile(path.join(directory, name), bytes);
  for (const name of ["static", "dots", "flat-gray", "handwriting"]) {
    const source = path.join(__dirname, `../test/fixtures/noisy-images/${name}.png`);
    await fs.copyFile(source, path.join(directory, `${name}.png`));
    await sharp(source).jpeg({ quality: 85 }).toFile(path.join(directory, `${name}.jpg`));
  }
  await sharp(path.join(__dirname, "../test/fixtures/noisy-images/static.png")).extract({ left: 0, top: 0, width: 261, height: 20 }).resize({ width: 261, height: 77 }).png().toFile(path.join(directory, "static-background.png"));
  await sharp(path.join(__dirname, "../test/fixtures/noisy-images/dots.png")).extract({ left: 0, top: 65, width: 262, height: 15 }).resize({ width: 262, height: 80 }).png().toFile(path.join(directory, "dots-background.png"));
  for (const [name, pages] of [["image.pdf", 1], ["long.pdf", 11]]) {
    const pdf = await PDFDocument.create();
    const image = await pdf.embedPng(png);
    for (let i = 0; i < pages; i++) {
      const page = pdf.addPage([320, 100]);
      if (i === pages - 1) page.drawImage(image, { x: 0, y: 0, width: 320, height: 100 });
    }
    await fs.writeFile(path.join(directory, name), await pdf.save());
  }
  for (const [name, entries] of [["image.zip", 1], ["long.zip", 65]]) {
    const zip = new ZipFile();
    for (let i = 0; i < entries; i++) zip.addBuffer(i === entries - 1 ? png : Buffer.from("coffee"), `part${i}.${i === entries - 1 ? "png" : "txt"}`);
    const bytes = readLimited(zip.outputStream, 1_000_000);
    zip.end();
    await fs.writeFile(path.join(directory, name), await bytes);
  }
  for (let i = 0; i < 3; i++) await fs.writeFile(path.join(directory, `frame${i}.png`), i === 1 ? png : blank);
  const ffmpeg = require("ffmpeg-static");
  await promisify(execFile)(ffmpeg, ["-v", "error", "-y", "-framerate", "30", "-i", path.join(directory, "frame%d.png"), "-c:v", "ffv1", path.join(directory, "flash.mkv")]);
  // 300 blank frames followed by one spoiler frame; the payload is beyond the default cap.
  for (let i = 0; i <= 300; i++) await fs.writeFile(path.join(directory, `long-frame${i}.png`), i === 300 ? png : blank);
  await promisify(execFile)(ffmpeg, ["-v", "error", "-y", "-framerate", "30", "-i", path.join(directory, "long-frame%d.png"), "-frames:v", "301", "-c:v", "ffv1", path.join(directory, "long.mkv")]);
  await fs.copyFile(path.join(__dirname, "fixtures/subtitle.srt"), path.join(directory, "subtitle.srt"));
  await promisify(execFile)(ffmpeg, ["-v", "error", "-y", "-loop", "1", "-i", path.join(directory, "blank.png"), "-i", path.join(directory, "subtitle.srt"), "-t", "1", "-c:v", "ffv1", "-c:s", "srt", path.join(directory, "subtitle.mkv")]);
}

module.exports = { buildFixtures };
