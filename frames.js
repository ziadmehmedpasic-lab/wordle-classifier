const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createHash } = require("node:crypto");
const sharp = require("sharp");
const { download } = require("./download");

const cfg = { enabled: false, maxFrames: Number(process.env.OCR_MAX_FRAMES || 300), maxSeconds: 120, maxBytes: 32_000_000, maxPixels: 16_000_000, timeoutMs: 120_000 };
const ffmpegPath = process.env.FFMPEG_PATH || require("ffmpeg-static");
const ffprobePath = process.env.FFPROBE_PATH || require("ffprobe-static").path;

/** @returns {boolean} */
function init() {
  if (!Number.isInteger(cfg.maxFrames) || cfg.maxFrames < 1) throw new Error("OCR_MAX_FRAMES must be a positive integer");
  cfg.enabled = (process.env.OCR_FRAMES || "true").toLowerCase() === "true";
  return cfg.enabled;
}

/** @param {object} attachment @returns {string | null} */
function kind(attachment) {
  const type = attachment.contentType || "";
  const name = attachment.name || "";
  if (type === "image/gif" || (!type.startsWith("image/") && /\.gif$/i.test(name))) return "gif";
  if (type.startsWith("video/") || ((!type || type === "application/octet-stream") && /\.(mp4|m4v|mov|webm|mkv|avi|gifv)$/i.test(name))) return "video";
  return null;
}

/** @param {object} embed @returns {string | null} */
function embedMedia(embed) {
  return [embed.video?.url, embed.thumbnail?.url, embed.image?.url].find((url) => url && /\.(gif|mp4|webm)(\?|$)/i.test(url)) || null;
}

/** @param {string} input @returns {Promise<object>} */
async function probe(input) {
  const { stdout } = await promisify(execFile)(ffprobePath, ["-v", "error", "-protocol_whitelist", "file,pipe", "-count_frames", "-show_streams", "-show_format", "-of", "json", input], { timeout: 15_000, maxBuffer: 2_000_000 });
  return JSON.parse(stdout);
}

/** @param {string} input @param {(png: Buffer) => Promise<void>} onFrame @returns {Promise<{issues: string[], count: number}>} */
async function decode(input, onFrame) {
  const metadata = await probe(input);
  const video = metadata.streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("no video stream found");
  if (!(video.width > 0 && video.height > 0) || video.width * video.height > cfg.maxPixels) throw new Error("invalid or excessive video dimensions");
  const issues = [];
  const seconds = Number(metadata.format.duration);
  if (seconds > cfg.maxSeconds) issues.push("video duration exceeds limit");
  if (metadata.streams.filter((stream) => stream.codec_type === "video").length > 1) issues.push("additional video tracks are unscanned");
  if (metadata.streams.some((stream) => stream.codec_type === "subtitle")) issues.push("subtitle tracks are unscanned");
  // no frame-rate filter or near-duplicate removal: even a one-frame text change survives.
  const child = spawn(ffmpegPath, ["-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-noautorotate", "-i", input, "-map", "0:v:0", "-t", String(cfg.maxSeconds), "-frames:v", String(cfg.maxFrames + 1), "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let timedOut = false;
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const finished = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code) => resolve({ code }));
  });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, cfg.timeoutMs);
  const frameBytes = video.width * video.height * 3;
  let pending = Buffer.alloc(0);
  let previous = "";
  let count = 0;
  try {
    for await (const chunk of child.stdout) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const raw = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        count++;
        if (count > cfg.maxFrames) continue;
        const hash = createHash("sha256").update(raw).digest("hex");
        if (hash === previous) continue;
        previous = hash;
        const png = await sharp(raw, { raw: { width: video.width, height: video.height, channels: 3 } }).png().toBuffer();
        await onFrame(png);
      }
    }
    const exit = await finished;
    if (timedOut) issues.push("video inspection timed out");
    else if (exit.error || exit.code !== 0 || pending.length) issues.push(`video decode failed: ${exit.error?.message || stderr || "incomplete frame"}`);
    if (!count) issues.push("no video frames decoded");
    if (count > cfg.maxFrames) issues.push("video frame limit exceeded");
    // some GIF demuxers omit duration; a full frame count can still prove coverage.
    if (!Number.isFinite(seconds) && count !== Number(video.nb_read_frames)) issues.push("video duration unknown and full frame coverage unverified");
    if (Number.isFinite(Number(video.nb_read_frames)) && count < Number(video.nb_read_frames)) issues.push("not all source frames were decoded");
    return { issues, count: Math.min(count, cfg.maxFrames), subtitleStreams: metadata.streams.filter((stream) => stream.codec_type === "subtitle") };
  } finally { clearTimeout(timer); child.kill("SIGKILL"); await finished; }
}

/** @param {string} input @param {string} outDir @returns {Promise<object>} */
async function sample(input, outDir) {
  const files = [];
  const result = await decode(input, async (png) => {
    const file = path.join(outDir, `frame_${String(files.length).padStart(4, "0")}.png`);
    await fs.writeFile(file, png);
    files.push(file);
  });
  return { ...result, files };
}

/** @param {string} input @param {(input: Buffer) => Promise<string>} ocrImage @returns {Promise<object>} */
async function inspectFile(input, ocrImage) {
  const texts = [];
  const images = [];
  const issues = [];
  let imageBytes = 0;
  const result = await decode(input, async (png) => {
    imageBytes += png.length;
    if (imageBytes <= cfg.maxBytes) images.push(`data:image/png;base64,${png.toString("base64")}`);
    else if (!issues.includes("frame vision byte limit exceeded")) issues.push("frame vision byte limit exceeded");
    try { texts.push(await ocrImage(png)); }
    catch (error) { issues.push(`frame OCR failed: ${error.message}`); }
  });
  const subtitles = await readSubtitles(input, result.subtitleStreams);
  texts.push(subtitles.text);
  return { text: texts.filter(Boolean).join("\n"), images, issues: [...issues, ...result.issues.filter((issue) => issue !== "subtitle tracks are unscanned"), ...subtitles.issues] };
}

/** @param {string} input @param {object[]} streams @returns {Promise<{text: string, issues: string[]}>} */
async function readSubtitles(input, streams) {
  const texts = [];
  const issues = [];
  if (streams.length > 8) issues.push("subtitle track limit exceeded");
  for (const stream of streams.slice(0, 8)) {
    if (!["subrip", "ass", "ssa", "webvtt", "mov_text", "text"].includes(stream.codec_name)) { issues.push(`unsupported subtitle codec: ${stream.codec_name}`); continue; }
    try {
      const { stdout } = await promisify(execFile)(ffmpegPath, ["-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-i", input, "-map", `0:${stream.index}`, "-c:s", "srt", "-f", "srt", "pipe:1"], { timeout: 15_000, maxBuffer: 200_000 });
      texts.push(stdout);
    } catch (error) { issues.push(`subtitle extraction failed: ${error.message}`); }
  }
  return { text: texts.join("\n"), issues };
}

/** @param {string} url @param {Function} ocrImage @param {object} options @returns {Promise<string>} */
async function ocr(url, ocrImage, { name = "media", size = 0, downloadFile = download } = {}) {
  if (!cfg.enabled) throw new Error("frame inspection disabled");
  if (size > cfg.maxBytes) throw new Error("media exceeds byte limit");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wordle-frames-"));
  try {
    const bytes = await downloadFile(url, { maxBytes: cfg.maxBytes });
    const input = path.join(dir, /^GIF8[79]a/.test(bytes.subarray(0, 6).toString()) ? "input.gif" : "input");
    await fs.writeFile(input, bytes);
    const result = await inspectFile(input, ocrImage);
    if (result.issues.length) throw new Error(`${name}: ${result.issues.join("; ")}`);
    return result.text;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

module.exports = { init, cfg, kind, embedMedia, probe, decode, sample, inspectFile, readSubtitles, ocr };
