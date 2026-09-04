// text inside document attachments: office files (docx, pptx, xlsx), opendocument, pdf, rtf, html, epub, zips and
// gzips, legacy office binaries (doc, xls, ppt) and anything else with readable strings in it. images inside
// office files and pdfs, and the pages of a pdf with no text layer, go to ocr like a screenshot would.
const { unzipSync, gunzipSync } = require("fflate");

const cfg = {
  maxBytes: 30_000_000, // skip huge uploads before downloading
  maxImages: 10, // embedded images sent to ocr per document
  maxPdfPages: 10, // pages rendered for ocr when a pdf is short or has no text layer
  maxChars: 500_000, // text handed to the detector per document
};
const cache = new Map();

const MEDIA_TYPE = /^(image|audio|video)\//;
const MEDIA_EXT = /\.(png|jpe?g|webp|bmp|gif|mp4|m4v|mov|webm|mkv|avi|gifv|mp3|ogg|oga|wav|m4a|flac|opus|aac)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif)$/i;
// office parts that carry formatting, not the user's text (style names like "Light Grid" would otherwise read as words)
const OFFICE_NOISE = /(\[content_types\]|\.rels$|styles|theme|settings|fonttable|numbering|presprops|viewprops|tablestyles|slidelayout|slidemaster|notesmaster|handoutmaster|app\.xml|calcchain|manifest|mimetype|customxml|glossary|people\.xml)/i;
// strings that every ole compound file and word template carries
const OLE_NOISE = /\b(root entry|summaryinformation|documentsummaryinformation|worddocument|compobj|objectpool|workbook|current user|powerpoint document|pictures|normal\.dotm?|microsoft (office )?(word|excel|powerpoint)( \d+(\.\d+)?)?|msworddoc|word\.document\.\d+|excel\.sheet\.\d+|powerpoint\.show\.\d+|title|subject|author|keywords|comments|template|(calibri|cambria|segoe ui|arial|helvetica|times new roman|courier new|symbol|wingdings|aptos|tahoma|verdana|georgia)( light| semilight| display| black| narrow)?)\b/gi;

// everything that is not an image, video or audio file is a document to read
function kind(attachment) {
  const type = attachment.contentType || "";
  const name = attachment.name || "";
  if (MEDIA_TYPE.test(type) || MEDIA_EXT.test(name)) return null;
  return "document";
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function unescapeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(parseInt(e[1] === "x" || e[1] === "X" ? e.slice(2) : e.slice(1), e[1] === "x" || e[1] === "X" ? 16 : 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// xml or html -> text: paragraphs, cells and rows end lines, tabs become spaces, every other tag vanishes
function stripTags(markup) {
  return unescapeEntities(
    markup
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(w:p|a:p|text:p|text:h|p|tr|w:tc|a:tc|table:table-cell|c|row|si|li|h\d|div|td|th|title|dt|dd)>|<(w:br|text:line-break|br|hr)\b[^>]*\/?>/gi, "\n")
      .replace(/<(w:tab|text:tab|text:s)\b[^>]*\/?>/gi, " ")
      .replace(/<[^>]+>/g, ""),
  );
}

function looksLikeText(buf) {
  const sample = buf.subarray(0, 4096);
  let bad = 0;
  for (const b of sample) if (b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13)) bad++;
  return bad < sample.length / 100;
}

// printable ascii and utf-16le runs of a binary file: the text of doc, xls and ppt files and anything unknown
function strings(buf) {
  const out = [];
  const ascii = buf.toString("latin1").match(/[\x20-\x7e]{4,}/g) || [];
  out.push(...ascii);
  const wide = buf.toString("latin1").match(/(?:[\x20-\x7e]\x00){4,}/g) || [];
  out.push(...wide.map((w) => w.replace(/\x00/g, "")));
  return out.join("\n").replace(OLE_NOISE, " ");
}

// {\rtf1 ...}: font, colour and style tables dropped, control words removed, hex escapes decoded
function rtfText(s) {
  let out = "";
  let depth = 0, skipDepth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{") {
      depth++;
      if (!skipDepth && /^\{\\(\*|fonttbl|colortbl|stylesheet|listtable|listoverridetable|rsidtbl|generator|xmlnstbl|themedata|colorschememapping|latentstyles|datastore|pict|object)/.test(s.slice(i, i + 24))) skipDepth = depth;
      continue;
    }
    if (c === "}") { if (skipDepth === depth) skipDepth = 0; depth--; continue; }
    if (skipDepth) continue;
    if (c === "\\") {
      const m = s.slice(i, i + 32).match(/^\\(?:'([0-9a-f]{2})|u(-?\d+)\??|([a-z]+)(-?\d+)? ?|(.))/i);
      if (!m) continue;
      i += m[0].length - 1;
      if (m[1]) out += String.fromCharCode(parseInt(m[1], 16));
      else if (m[2]) out += String.fromCodePoint(((+m[2]) + 65536) % 65536);
      else if (m[3] && /^(par|line|tab|cell|row|sect|page)$/.test(m[3])) out += m[3] === "tab" || m[3] === "cell" ? " " : "\n";
      else if (m[5] && /[\\{}]/.test(m[5])) out += m[5];
      continue;
    }
    if (c !== "\n" && c !== "\r") out += c;
  }
  return out;
}

async function pdfText(buf, ocrImage) {
  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  const bits = [];
  try {
    bits.push((await parser.getText()).text || "");
    const letters = (bits[0].match(/\p{L}/gu) || []).length;
    const images = [];
    for (const p of (await parser.getImage({ imageDataUrl: false, imageThreshold: 20 })).pages || []) for (const im of p.images || []) images.push(im.data);
    for (const im of images.slice(0, cfg.maxImages)) bits.push(await ocrImage(Buffer.from(im)));
    // text drawn as outlines has no text layer: read the rendered pages when there is nothing else to read, and always for a short pdf
    const pages = (await parser.getInfo()).total || 0;
    if ((letters < 20 && !images.length) || pages <= 2) {
      for (const p of (await parser.getScreenshot({ first: cfg.maxPdfPages, scale: 2, imageDataUrl: false })).pages || []) bits.push(await ocrImage(Buffer.from(p.data)));
    }
  } finally {
    await parser.destroy();
  }
  return bits.filter(Boolean).join(" \n ");
}

// office and opendocument files, epubs, plain zips: user-facing xml and text entries as text, pictures to ocr
async function zipText(buf, ocrImage, depth) {
  const entries = unzipSync(new Uint8Array(buf));
  const bits = [];
  let images = 0;
  for (const name of Object.keys(entries).sort()) {
    const data = Buffer.from(entries[name]);
    if (!data.length || data.length > 20_000_000) continue;
    if (OFFICE_NOISE.test(name)) continue;
    if (/\.(xml|xhtml|html?|svg|txt|md|csv|json|tsv|rtf|opf|ncx)$/i.test(name) || /^(content|meta)\.xml$/.test(name)) bits.push(await extract(data, name, ocrImage, depth + 1));
    else if (IMAGE_EXT.test(name)) { if (images++ < cfg.maxImages) bits.push(await ocrImage(data)); }
    else if (/\.(zip|docx|pptx|xlsx|odt|odp|ods|epub)$/i.test(name) && depth < 1) bits.push(await extract(data, name, ocrImage, depth + 1));
    else if (/\.(doc|xls|ppt|pdf|bin)$/i.test(name) && depth < 1) bits.push(await extract(data, name, ocrImage, depth + 1)); // embedded objects
  }
  return bits.filter(Boolean).join(" \n ");
}

async function extract(buf, name, ocrImage, depth = 0) {
  const head = buf.subarray(0, 8).toString("latin1");
  if (head.startsWith("PK\x03\x04")) return zipText(buf, ocrImage, depth);
  if (head.startsWith("\x1f\x8b") && depth < 2) return extract(Buffer.from(gunzipSync(new Uint8Array(buf))), name.replace(/\.gz$/i, ""), ocrImage, depth + 1);
  if (head.startsWith("%PDF")) return pdfText(buf, ocrImage);
  if (head.startsWith("{\\rtf")) return rtfText(buf.toString("latin1"));
  if (head.startsWith("\xff\xfe") || head.startsWith("\xfe\xff")) { // utf-16 text files, either byte order
    const le = head.startsWith("\xff\xfe") ? Buffer.from(buf) : Buffer.from(buf).swap16();
    return extract(Buffer.from(le.toString("utf16le").replace(/^\uFEFF/, "")), name, ocrImage, depth);
  }
  if (!looksLikeText(buf)) return strings(buf); // doc, xls, ppt, anything else
  const text = buf.toString("utf8").replace(/^\uFEFF/, "");
  return /^\s*<(\?xml|!doctype|html|svg|w:|a:|office:)/i.test(text) || /\.(xml|xhtml|html?|svg)$/i.test(name) ? stripTags(text) : text;
}

async function read(url, ocrImage, { id = url, name = url, size = 0 } = {}) {
  if (cache.has(id)) return cache.get(id);
  if (size > cfg.maxBytes) { console.warn(`Skipping document ${name}: ${size} bytes is over the cap`); return ""; }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`download returned ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > cfg.maxBytes) throw new Error(`${buf.length} bytes is over the cap`);
    let text = await extract(buf, String(name).split("?")[0], ocrImage);
    if (text.length > cfg.maxChars) { console.warn(`Document ${name}: only the first ${cfg.maxChars} of ${text.length} characters are scanned`); text = text.slice(0, cfg.maxChars); }
    cache.set(id, text);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    console.log(`Document ${String(name).split("?")[0].split("/").pop()}: ${text.length} chars, "${text.replace(/\s+/g, " ").trim().slice(0, 60)}"`);
    return text;
  } catch (e) {
    console.warn("Document read failed:", e.message);
    return "";
  }
}

module.exports = { cfg, kind, extract, read, stripTags, rtfText, strings, cache };
