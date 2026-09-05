const { createHash } = require("node:crypto");
const detector = require("./detector");
const { createWorker } = require("tesseract.js");
const { decodeQr } = require("./qr");
const { imageVariants } = require("./ocr-preprocess");

let workerPromise;
let queue = Promise.resolve();

/** @returns {Promise<object>} */
function getWorker() {
  if (!workerPromise) workerPromise = createWorker("eng", undefined, { errorHandler: (error) => console.warn("OCR worker:", error.message || error) }).catch((error) => { workerPromise = undefined; throw error; });
  return workerPromise;
}

/** @param {Buffer | string} input @returns {Promise<string>} */
function ocrImage(input) {
  // a rejected job is returned to its caller; the next queued job may still run.
  const job = queue.catch(() => {}).then(async () => {
    if ((process.env.OCR_IMAGES || "true").toLowerCase() !== "true") throw new Error("OCR disabled");
    const texts = await decodeQr(input);
    if (detector.scan(texts.join("\n"))) return texts.join("\n");
    const worker = await getWorker();
    const seen = new Set();
    const recognized = new Set();
    let timer;
    const deadline = Date.now() + 30_000;
    try {
      for await (const { png, psm } of imageVariants(input)) {
        if (Date.now() >= deadline) throw new Error("OCR timed out");
        const key = `${psm}:${createHash("sha256").update(png).digest("hex")}`;
        if (recognized.has(key)) continue;
        recognized.add(key);
        await worker.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: "150" });
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("OCR timed out")), deadline - Date.now()); });
        const { data } = await Promise.race([worker.recognize(png), timeout]);
        clearTimeout(timer);
        // noisy OCR can accidentally match broad spelling/cipher heuristics. let vision inspect it instead.
        if (data.confidence < 50) continue;
        const text = data.text.trim();
        if (text && !seen.has(text)) { texts.push(text); seen.add(text); }
        if (detector.scan(text)) return texts.join("\n");
      }
      return texts.join("\n");
    } catch (error) {
      await worker.terminate();
      workerPromise = undefined;
      throw error;
    } finally { clearTimeout(timer); }
  });
  queue = job;
  return job;
}

/** @returns {Promise<void>} */
async function close() {
  await queue.catch(() => {});
  if (workerPromise) await (await workerPromise).terminate();
  workerPromise = undefined;
}

module.exports = { ocrImage, close };
