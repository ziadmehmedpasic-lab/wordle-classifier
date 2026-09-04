const sharp = require("sharp");
const yauzl = require("yauzl");
const { SaxesParser } = require("saxes");
const path = require("node:path");
const { readLimited } = require("./download");

const limits = { bytes: 32_000_000, expandedBytes: 32_000_000, entries: 64, depth: 2, pages: 10, pixels: 16_000_000, text: 200_000, imageBytes: 16_000_000 };

/** @param {object} result @param {Buffer} png @param {object} budget @returns {void} */
function addImage(result, png, budget) {
  budget.imageBytes += png.length;
  if (budget.imageBytes > limits.imageBytes) {
    if (!result.issues.includes("document image byte limit exceeded")) result.issues.push("document image byte limit exceeded");
    return;
  }
  result.images.push(`data:image/png;base64,${png.toString("base64")}`);
}

/** @param {Buffer} bytes @returns {string} */
function decodeText(bytes) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (/[\x00-\x08\x0e-\x1f]/.test(text)) throw new Error("unsupported binary content");
  if (text.length > limits.text) throw new Error("text exceeds character limit");
  return text;
}

/** @param {string} xml @returns {{text: string, external: boolean}} */
function xmlText(xml) {
  const texts = [];
  let external = false;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => { throw new Error("XML document types are unsupported"); });
  parser.on("text", (text) => texts.push(text));
  parser.on("cdata", (text) => texts.push(text));
  parser.on("opentag", (tag) => {
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.local === "TargetMode" && attribute.value === "External") external = true;
    }
  });
  parser.on("closetag", (tag) => { if (["p", "row", "si"].includes(tag.local)) texts.push("\n"); });
  parser.write(xml).close();
  return { text: texts.join(""), external };
}

/** @param {Buffer} bytes @param {object} options @returns {Promise<object>} */
async function extractDocument(bytes, { name = "attachment", ocrImage, depth = 0, budget = { bytes: 0, entries: 0, images: 0, imageBytes: 0 } } = {}) {
  const result = { text: "", images: [], issues: [], clips: [] };
  const texts = [];
  if (depth > limits.depth) { result.issues.push("archive nesting limit exceeded"); return result; }
  if (bytes.length > limits.bytes) { result.issues.push("file exceeds byte limit"); return result; }
  const { fileTypeFromBuffer } = await import("file-type");
  // ZIP is identified before file-type's Office inspection so decompression is always bounded here.
  const isZip = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const type = isZip ? { mime: "application/zip" } : await fileTypeFromBuffer(bytes);
  if (isZip) {
    const zip = await yauzl.fromBufferPromise(bytes, { lazyEntries: true, validateEntrySizes: true });
    try {
      for await (const entry of zip.eachEntry()) {
        if (++budget.entries > limits.entries) { result.issues.push("archive entry limit exceeded"); break; }
        if (entry.fileName.endsWith("/")) continue;
        if (entry.generalPurposeBitFlag & 1) { result.issues.push("encrypted archive entry"); continue; }
        if (budget.bytes + entry.uncompressedSize > limits.expandedBytes) { result.issues.push("archive expanded byte limit exceeded"); continue; }
        try {
          const stream = await zip.openReadStreamPromise(entry);
          const data = await readLimited(stream, limits.expandedBytes - budget.bytes);
          budget.bytes += data.length;
          texts.push(entry.fileName);
          const child = await extractDocument(data, { name: entry.fileName, ocrImage, depth: depth + 1, budget });
          texts.push(child.text);
          result.images.push(...child.images);
          result.clips.push(...child.clips);
          result.issues.push(...child.issues.map((issue) => `${entry.fileName}: ${issue}`));
        } catch (error) { result.issues.push(`${entry.fileName}: ${error.message}`); }
      }
    } finally { zip.close(); }
  } else if (type?.mime === "application/pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const root = path.dirname(require.resolve("pdfjs-dist/package.json"));
    const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, standardFontDataUrl: `${root}/standard_fonts/`, wasmUrl: `${root}/wasm/`, maxImageSize: limits.pixels, stopAtErrors: true });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > limits.pages) result.issues.push("PDF page limit exceeded");
      for (let i = 1; i <= Math.min(pdf.numPages, limits.pages); i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        texts.push(content.items.map((item) => item.str || "").join(" "));
        if (++budget.images > limits.pages) { result.issues.push("rendered image limit exceeded"); break; }
        const viewport = page.getViewport({ scale: 1.5 });
        if (viewport.width * viewport.height > limits.pixels) { result.issues.push(`PDF page ${i} exceeds pixel limit`); continue; }
        const canvas = pdf.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
        try {
          await page.render({ canvasContext: canvas.context, viewport }).promise;
          const png = canvas.canvas.toBuffer("image/png");
          addImage(result, png, budget);
          try { texts.push(await ocrImage(png)); }
          catch (error) { result.issues.push(`PDF page OCR failed: ${error.message}`); }
        } finally { pdf.canvasFactory.destroy(canvas); page.cleanup(); }
      }
    } finally { await task.destroy(); }
  } else if (type?.mime.startsWith("video/") || type?.mime.startsWith("audio/") || ["image/gif", "image/apng"].includes(type?.mime)) {
    result.clips.push({ bytes, name, contentType: type.mime });
  } else if (type?.mime.startsWith("image/") || (!type && /<svg[\s>]/i.test(bytes.subarray(0, 4096).toString()))) {
    if (++budget.images > limits.pages) { result.issues.push("rendered image limit exceeded"); return result; }
    const source = sharp(bytes, { limitInputPixels: limits.pixels });
    const metadata = await source.metadata();
    if (metadata.pages > 1) {
      const count = Math.min(metadata.pages, limits.pages - budget.images + 1);
      budget.images += count - 1;
      if (count < metadata.pages) result.issues.push("image page limit exceeded");
      for (let page = 0; page < count; page++) {
        const png = await sharp(bytes, { page, pages: 1, limitInputPixels: limits.pixels }).png().toBuffer();
        addImage(result, png, budget);
        try { texts.push(await ocrImage(png)); }
        catch (error) { result.issues.push(`image page OCR failed: ${error.message}`); }
      }
      result.text = texts.filter(Boolean).join("\n");
      return result;
    }
    // native decoders interpret the content rather than the filename or MIME header.
    const png = await source.png().toBuffer();
    addImage(result, png, budget);
    try { texts.push(await ocrImage(png)); }
    catch (error) { result.issues.push(`image OCR failed: ${error.message}`); }
  } else if (!type || type.mime === "application/xml") {
    const text = decodeText(bytes);
    if (/^\s*<\?xml\b/.test(text) || /\.(xml|rels)$/i.test(name)) {
      const xml = xmlText(text);
      texts.push(xml.text);
      if (xml.external) result.issues.push("external document references are not fetched");
    } else texts.push(text);
  } else result.issues.push(`unsupported format: ${type.mime}`);
  const text = texts.filter(Boolean).join("\n");
  result.text = text.slice(0, limits.text);
  if (text.length > limits.text) result.issues.push("extracted text limit exceeded");
  return result;
}

module.exports = { extractDocument, decodeText, xmlText, limits };
