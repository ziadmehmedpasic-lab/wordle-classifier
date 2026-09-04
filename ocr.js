const sharp = require("sharp");
const detector = require("./detector");
const { createWorker } = require("tesseract.js");

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
    const worker = await getWorker();
    const source = sharp(input, { limitInputPixels: 16_000_000 });
    const metadata = await source.metadata();
    const width = Math.min(1600, Math.max(metadata.width, 640));
    const texts = [];
    const seen = new Set();
    let timer;
    const deadline = Date.now() + 30_000;
    try {
      for (const rotation of [0, 90, 180, 270]) {
        for (const background of ["white", "black"]) {
          const png = await source.clone().flatten({ background }).rotate(rotation).resize({ width }).normalise().sharpen().png().toBuffer();
          if (Date.now() >= deadline) throw new Error("OCR timed out");
          const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("OCR timed out")), deadline - Date.now()); });
          const { data } = await Promise.race([worker.recognize(png), timeout]);
          clearTimeout(timer);
          const text = data.text.trim();
          if (text && !seen.has(text)) { texts.push(text); seen.add(text); }
          if (detector.scan(text)) return texts.join("\n");
        }
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
