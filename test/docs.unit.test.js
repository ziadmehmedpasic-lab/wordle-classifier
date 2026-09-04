// offline checks for document attachments: office and opendocument zips, pdfs (text layer, embedded image, no text
// layer), rtf, html, utf-16 and gzipped text, legacy binary office files, nested zips, noise parts skipped. ocr is faked.
const assert = require("assert");
const http = require("http");
const { zipSync, gzipSync } = require("fflate");
const docs = require("../docs");
const detector = require("../detector");

detector.setAnswers(["wager"]);
let fails = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; } catch (e) { fails++; console.log(`FAIL ${name}: ${e.message}`); }
}
const enc = (s) => new TextEncoder().encode(s);
const zip = (entries) => Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, typeof v === "string" ? enc(v) : v]))));
const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64, 7)]); // any bytes: ocr is faked
let ocrCalls = 0;
const ocr = async (input) => { ocrCalls++; assert.ok(Buffer.isBuffer(input) && input.length, "ocr gets image bytes"); return "wager"; };
const noOcr = async () => { throw new Error("ocr should not run"); };

// a pdf from a list of object bodies, with a correct xref table
function pdf(objects) {
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const stream = (dict, data) => `<< ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream`;
const page = (extra, contents, resources) => [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << ${resources} >> >>`,
  stream("", contents),
  ...extra,
];
const textPdf = pdf(page(["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"], "BT /F1 24 Tf 20 40 Td (wager) Tj ET", "/Font << /F1 5 0 R >>"));
const rgb = Buffer.alloc(32 * 32 * 3, 0x80).toString("latin1");
const imagePdf = pdf(page([stream("/Type /XObject /Subtype /Image /Width 32 /Height 32 /ColorSpace /DeviceRGB /BitsPerComponent 8", rgb)], "q 100 0 0 100 50 0 cm /Im1 Do Q", "/XObject << /Im1 5 0 R >>"));
const blankPdf = pdf(page([], "0 0 m 100 100 l S", ""));

(async () => {
  await check("attachment kinds", () => {
    assert.strictEqual(docs.kind({ contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", name: "deck.pptx" }), "document");
    assert.strictEqual(docs.kind({ contentType: "text/plain", name: "a.txt" }), "document");
    assert.strictEqual(docs.kind({ contentType: "application/octet-stream", name: "mystery" }), "document");
    assert.strictEqual(docs.kind({ contentType: "image/png", name: "a.png" }), null);
    assert.strictEqual(docs.kind({ contentType: "video/mp4", name: "a.mp4" }), null);
    assert.strictEqual(docs.kind({ contentType: "", name: "voice.ogg" }), null);
  });

  await check("docx paragraphs and runs", async () => {
    const docx = zip({
      "[Content_Types].xml": "<Types/>", "word/styles.xml": "<w:styles><w:name w:val=\"Light Grid\"/></w:styles>",
      "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>todays answer is</w:t></w:r><w:r><w:t xml:space=\"preserve\"> wa</w:t></w:r><w:r><w:t>ger</w:t></w:r></w:p><w:p><w:r><w:t>lol</w:t></w:r></w:p></w:body></w:document>",
    });
    const text = await docs.extract(docx, "a.docx", noOcr);
    assert.ok(/todays answer is wager\nlol/.test(text), JSON.stringify(text));
    assert.ok(!/Light Grid/.test(text), "style names skipped");
    assert.strictEqual(detector.scan(text), "wager");
  });
  await check("pptx slide, notes and picture", async () => {
    ocrCalls = 0;
    const pptx = zip({
      "ppt/slides/slide1.xml": "<p:sld><p:txBody><a:p><a:r><a:t>W</a:t></a:r><a:r><a:t>AG</a:t></a:r><a:r><a:t>ER</a:t></a:r></a:p></p:txBody></p:sld>",
      "ppt/notesSlides/notesSlide1.xml": "<p:notes><a:p><a:r><a:t>speaker notes here</a:t></a:r></a:p></p:notes>",
      "ppt/slideLayouts/slideLayout1.xml": "<p:sldLayout><a:t>Title and Content</a:t></p:sldLayout>",
      "ppt/media/image1.png": png,
    });
    const text = await docs.extract(pptx, "a.pptx", ocr);
    assert.ok(/WAGER/.test(text) && /speaker notes/.test(text) && !/Title and Content/.test(text), JSON.stringify(text));
    assert.strictEqual(ocrCalls, 1);
    assert.strictEqual(detector.scan(text), "wager");
  });
  await check("xlsx shared strings and sheet names", async () => {
    const xlsx = zip({
      "xl/workbook.xml": "<workbook><sheets><sheet name=\"wa ger\" sheetId=\"1\"/></sheets></workbook>",
      "xl/sharedStrings.xml": "<sst><si><t>hello</t></si><si><t>w</t></si><si><t>a</t></si></sst>",
      "xl/worksheets/sheet1.xml": "<worksheet><sheetData><row><c t=\"s\"><v>0</v></c><c t=\"inlineStr\"><is><t>g e r</t></is></c></row></sheetData></worksheet>",
      "xl/styles.xml": "<styleSheet/>",
    });
    const text = await docs.extract(xlsx, "a.xlsx", noOcr);
    assert.ok(/hello\nw\na\n/.test(text) && /g e r/.test(text), JSON.stringify(text));
    assert.strictEqual(detector.scan(text), "wager");
  });
  await check("odt content", async () => {
    const odt = zip({ mimetype: "application/vnd.oasis.opendocument.text", "content.xml": "<office:document-content><office:text><text:p>the word is<text:s/>wager</text:p></office:text></office:document-content>", "styles.xml": "<x>Light</x>" });
    const text = await docs.extract(odt, "a.odt", noOcr);
    assert.ok(/the word is wager/.test(text) && !/Light/.test(text), JSON.stringify(text));
  });
  await check("zip of a text file, nested zip, gzip", async () => {
    const inner = zip({ "note.txt": "w a g e r" });
    assert.strictEqual(detector.scan(await docs.extract(inner, "a.zip", noOcr)), "wager");
    assert.strictEqual(detector.scan(await docs.extract(zip({ "inner.zip": inner }), "outer.zip", noOcr)), "wager");
    assert.strictEqual(detector.scan(await docs.extract(Buffer.from(gzipSync(enc("its wager"))), "a.txt.gz", noOcr)), "wager");
  });
  await check("html and svg", async () => {
    const text = await docs.extract(Buffer.from("<html><head><style>.light{}</style><title>hi</title></head><body><p>the answer</p><p>is <b>wa</b>ger</p><script>var light=1</script></body></html>"), "a.html", noOcr);
    assert.ok(/hi\n.*the answer\nis wager/s.test(text) && !/light/.test(text), JSON.stringify(text));
    assert.strictEqual(detector.scan(await docs.extract(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><text x=\"1\" y=\"2\">wager</text></svg>"), "a.svg", noOcr)), "wager");
  });
  await check("rtf", async () => {
    const rtf = "{\\rtf1\\ansi{\\fonttbl{\\f0\\fswiss Calibri Light;}}{\\colortbl;\\red0\\green0\\blue0;}{\\*\\generator Riched20}\\pard\\f0\\fs24 the answer is w\\'61ger\\par and \\u1085?ot light\\par}";
    const text = docs.rtfText(rtf);
    assert.ok(/the answer is wager\nand нot light/.test(text), JSON.stringify(text));
    assert.strictEqual(detector.scan(await docs.extract(Buffer.from(rtf), "a.rtf", noOcr)), "wager");
  });
  await check("utf-16 text, either byte order", async () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("today: wager", "utf16le")]);
    assert.strictEqual(await docs.extract(le, "a.txt", noOcr), "today: wager");
    assert.strictEqual(await docs.extract(Buffer.from(le).swap16(), "a.txt", noOcr), "today: wager");
  });
  await check("legacy binary office file: strings, ole noise dropped", async () => {
    const doc = Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(64), Buffer.from("Root Entry", "utf16le"), Buffer.alloc(16), Buffer.from("Calibri Light", "utf16le"), Buffer.alloc(16), Buffer.from("the word is wager ok", "utf16le"), Buffer.alloc(16), Buffer.from("Normal.dotm"), Buffer.alloc(200)]);
    const text = await docs.extract(doc, "a.doc", noOcr);
    assert.ok(/the word is wager ok/.test(text) && !/Root Entry|Calibri|Normal/.test(text), JSON.stringify(text));
    detector.setAnswers(["light"]);
    assert.strictEqual(detector.scan(text), null, "font names do not read as words");
    detector.setAnswers(["wager"]);
  });
  const blankOcr = async (input) => { ocrCalls++; assert.ok(Buffer.isBuffer(input) && input.length); return ""; };
  await check("pdf text layer", async () => {
    ocrCalls = 0;
    const text = await docs.extract(textPdf, "a.pdf", blankOcr);
    assert.ok(/wager/.test(text), JSON.stringify(text));
    assert.strictEqual(ocrCalls, 1, "a short pdf also has its page rendered");
  });
  await check("pdf embedded image goes to ocr", async () => {
    ocrCalls = 0;
    const text = await docs.extract(imagePdf, "a.pdf", ocr);
    assert.strictEqual(ocrCalls, 2, "the image and the rendered page");
    assert.strictEqual(detector.scan(text), "wager");
  });
  await check("pdf with no text layer is rendered for ocr", async () => {
    ocrCalls = 0;
    const text = await docs.extract(blankPdf, "a.pdf", ocr);
    assert.strictEqual(ocrCalls, 1, "one page rendered");
    assert.strictEqual(detector.scan(text), "wager");
  });

  // download path: size cap, cache, failure
  const server = http.createServer((req, res) => {
    if (req.url === "/a.docx") { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(zip({ "word/document.xml": "<w:p><w:t>wager</w:t></w:p>" })); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  await check("download, cache and caps", async () => {
    const text = await docs.read(`${base}/a.docx`, noOcr, { id: "1", name: "a.docx", size: 100 });
    assert.ok(/wager/.test(text));
    assert.strictEqual(docs.cache.get("1"), text);
    assert.strictEqual(await docs.read(`${base}/missing.docx`, noOcr, { id: "2", name: "missing.docx", size: 1 }), "");
    assert.strictEqual(await docs.read(`${base}/a.docx`, noOcr, { id: "3", name: "big.docx", size: 1e9 }), "");
  });
  server.close();

  console.log(`docs unit: ${passed}/${passed + fails} passed`);
  process.exit(fails ? 1 : 0);
})();
