const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const sharp = require("sharp");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const { ZipFile } = require("yazl");
const { extractDocument, decodeText, limits } = require("../documents");
const { download, readLimited } = require("../download");
const { inspectMessage } = require("../inspection");
const detector = require("../detector");

/** @param {Record<string, Buffer>} files @returns {Promise<Buffer>} */
async function zip(files) {
  const archive = new ZipFile();
  for (const [name, bytes] of Object.entries(files)) archive.addBuffer(bytes, name);
  const result = readLimited(archive.outputStream, 1_000_000);
  archive.end();
  return result;
}

test("UTF-16 and text without a useful filename are decoded", async () => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("WAGER", "utf16le")]);
  assert.equal(decodeText(bytes), "WAGER");
  assert.equal((await extractDocument(bytes, { name: "random.bin" })).text, "WAGER");
  assert.throws(() => decodeText(Buffer.from([0, 1, 2])), /binary/);
});

test("renamed SVG and raster images reach OCR and vision", async () => {
  const svg = await fs.readFile("test/fixtures/spoiler.svg");
  for (const bytes of [svg, await sharp(svg).png().toBuffer()]) {
    let calls = 0;
    const result = await extractDocument(bytes, { name: "innocent.txt", ocrImage: async (png) => {
      assert.equal((await sharp(png).metadata()).format, "png");
      calls++;
      return "WAGER";
    } });
    assert.equal(calls, 1);
    assert.match(result.text, /WAGER/);
    assert.match(result.images[0], /^data:image\/png;base64,/);
  }
});

test("Office XML split runs and embedded images are extracted from ZIP contents", async () => {
  const archive = await zip({
    "word/document.xml": await fs.readFile("test/fixtures/document.xml"),
    "word/media/image.png": await sharp(await fs.readFile("test/fixtures/spoiler.svg")).png().toBuffer(),
  });
  const result = await extractDocument(archive, { name: "pretend.txt", ocrImage: async () => "picture text" });
  assert.match(result.text, /WAGER/);
  assert.match(result.text, /picture text/);
  assert.equal(result.images.length, 1);
  assert.deepEqual(result.issues, []);
});

test("archive nesting and expanded byte caps are explicit", async () => {
  let archive = await zip({ "text.txt": Buffer.from("WAGER") });
  for (let i = 0; i < 3; i++) archive = await zip({ "nested.zip": archive });
  assert.ok((await extractDocument(archive)).issues.some((issue) => issue.includes("nesting limit")));
  const saved = limits.expandedBytes;
  limits.expandedBytes = 4;
  try {
    const result = await extractDocument(await zip({ "text.txt": Buffer.from("WAGER") }));
    assert.match(result.issues[0], /expanded byte limit/);
  } finally { limits.expandedBytes = saved; }
});

test("encrypted ZIP entries and XML entities are reported without treating them as clean", async () => {
  const archive = await zip({ "text.txt": Buffer.from("WAGER") });
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  archive.writeUInt16LE(archive.readUInt16LE(6) | 1, 6);
  archive.writeUInt16LE(archive.readUInt16LE(central + 8) | 1, central + 8);
  assert.ok((await extractDocument(archive)).issues.includes("encrypted archive entry"));
  await assert.rejects(extractDocument(Buffer.from("<!DOCTYPE x [<!ENTITY secret 'WAGER'>]><x>&secret;</x>"), { name: "file.xml" }), /document types/);
});

test("PDF text and rendered pages are both inspected, including an image-only page", async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([320, 100]).drawText("WAGER", { x: 20, y: 30, size: 50, font });
  const png = await sharp(await fs.readFile("test/fixtures/spoiler.svg")).png().toBuffer();
  const image = await pdf.embedPng(png);
  pdf.addPage([320, 100]).drawImage(image, { x: 0, y: 0, width: 320, height: 100 });
  let calls = 0;
  const result = await extractDocument(Buffer.from(await pdf.save()), { ocrImage: async (buffer) => {
    assert.ok((await sharp(buffer).metadata()).width > 0);
    calls++;
    return "rendered page";
  } });
  assert.match(result.text, /WAGER/);
  assert.equal(result.images.length, 2);
  assert.equal(calls, 2);
  assert.deepEqual(result.issues, []);
});

test("PDF page cap reports incomplete coverage", async () => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i <= limits.pages; i++) pdf.addPage([10, 10]);
  const result = await extractDocument(Buffer.from(await pdf.save()), { ocrImage: async () => "" });
  assert.equal(result.images.length, limits.pages);
  assert.ok(result.issues.includes("PDF page limit exceeded"));
});

test("rendered image bytes are bounded before retaining vision payloads", async () => {
  const saved = limits.imageBytes;
  limits.imageBytes = 1;
  try {
    const result = await extractDocument(await fs.readFile("test/fixtures/spoiler.svg"), { ocrImage: async () => "WAGER" });
    assert.equal(result.images.length, 0);
    assert.ok(result.issues.includes("document image byte limit exceeded"));
    assert.equal(result.text, "WAGER");
  } finally { limits.imageBytes = saved; }
});

test("download limits check actual streamed bytes and reject off-host redirects", async () => {
  const url = "https://cdn.discordapp.com/attachments/test";
  await assert.rejects(download(url, { maxBytes: 4, fetchImpl: async () => new Response("WAGER") }), /byte limit/);
  let requests = 0;
  await assert.rejects(download(url, { fetchImpl: async () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
  } }), /approved HTTPS host/);
  assert.equal(requests, 1);
  assert.equal((await download(url, { fetchImpl: async () => new Response("hello") })).toString(), "hello");
});

test("real renamed file bytes go through the message pipeline", async () => {
  detector.setAnswers(["wager"]);
  const original = global.fetch;
  global.fetch = async () => new Response("WAGER");
  try {
    const result = await inspectMessage({ channelId: "test", content: "", attachments: [{ name: "photo.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/test" }] }, { ocrImage: async () => "", describe: async () => "" });
    assert.equal(result.status, "spoiler");
  } finally { global.fetch = original; }
});
