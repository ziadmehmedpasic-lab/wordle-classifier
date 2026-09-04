// =====================================================================
// Frame sampling: animated GIFs, gifv link previews and videos are split
// into frames with ffmpeg so OCR reads every frame, not just the first.
// tesseract on an animated gif returns frame one only.
// =====================================================================
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

const cfg = {
  enabled: false,
  maxFrames: Number(process.env.OCR_MAX_FRAMES || 20), // per clip, after dropping near-duplicate frames
  maxSeconds: 120, // only the first two minutes of a video are sampled
  maxBytes: 50_000_000, // skip huge uploads before downloading
  minFps: 0.25,
  maxFps: 4,
};

let ffmpegPath = null;

function init() {
  if ((process.env.OCR_FRAMES || "true").toLowerCase() !== "true") { console.log("Frame OCR: off (OCR_FRAMES=false)"); return false; }
  try {
    ffmpegPath = process.env.FFMPEG_PATH || require("ffmpeg-static");
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) throw new Error(`ffmpeg binary not found at ${ffmpegPath}`);
  } catch (e) { console.error("Frame OCR: unavailable:", e.message); return false; }
  cfg.enabled = true;
  console.log(`Frame OCR: on (up to ${cfg.maxFrames} frames per gif or video)`);
  return true;
}

// ---------------------------------------------------------------------
// Which attachments and embeds have frames
// ---------------------------------------------------------------------
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|gifv)$/i;

function kind(attachment) {
  const type = attachment.contentType || "";
  const name = attachment.name || "";
  if (type.startsWith("image/gif") || (!type.startsWith("image/") && /\.gif$/i.test(name))) return "gif";
  if (type.startsWith("video/") || ((!type || type === "application/octet-stream") && VIDEO_EXT.test(name))) return "video";
  return null;
}

// a link preview for a gif (tenor, giphy, a direct .gif link) carries a direct media url in embed.video or embed.thumbnail
function embedMedia(embed) {
  for (const url of [embed.video?.url, embed.thumbnail?.url, embed.image?.url]) {
    if (url && /\.(gif|mp4|webm)(\?|$)/i.test(url)) return url;
  }
  return null;
}

// ---------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: 60_000, maxBuffer: 4_000_000 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error("ffmpeg: " + (stderr || err.message).trim().split("\n").pop()));
      resolve(stderr);
    });
  });
}

async function duration(input) {
  const stderr = await ffmpeg(["-i", input, "-f", "null", "-t", "0", "-"]).catch((e) => e.message);
  const m = /Duration: (\d+):(\d+):(\d+\.?\d*)/.exec(stderr);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

// png frames of a gif or video, in order: sampled at a rate that spreads maxFrames over the clip, near-duplicates dropped,
// small frames scaled up so text is legible to ocr
async function sample(input, outDir) {
  const seconds = Math.min(await duration(input) || 5, cfg.maxSeconds);
  const fps = Math.min(cfg.maxFps, Math.max(cfg.minFps, cfg.maxFrames / seconds));
  const filters = [`fps=${fps.toFixed(3)}`, "mpdecimate", "scale=w='if(lt(iw,640),640,iw)':h=-2"].join(",");
  await ffmpeg(["-y", "-t", String(cfg.maxSeconds), "-i", input, "-vf", filters, "-fps_mode", "vfr", "-frames:v", String(cfg.maxFrames), path.join(outDir, "frame_%03d.png")]);
  return (await fs.promises.readdir(outDir)).filter((f) => f.startsWith("frame_")).sort().map((f) => path.join(outDir, f));
}

// ---------------------------------------------------------------------
// OCR over frames
// ---------------------------------------------------------------------
// edits and resolving embeds re-run the pipeline on the same message; never sample twice
const cache = new Map(); // attachment id or media url -> text

// text of every sampled frame in order, joined so a word spelled one letter per frame still reads as a letter stream
async function ocr(url, ocrImage, { id = url, name = url, size = 0 } = {}) {
  if (!cfg.enabled) return "";
  if (cache.has(id)) return cache.get(id);
  if (size > cfg.maxBytes) { console.warn(`Skipping frames of ${name}: ${size} bytes is over the cap`); return ""; }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wordle-frames-"));
  try {
    const input = path.join(dir, "input" + (path.extname(String(name).split("?")[0]).toLowerCase() || ".bin"));
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`download returned ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(input));
    const frames = await sample(input, dir);
    const texts = [];
    for (const f of frames) texts.push((await ocrImage(f)).trim());
    const text = texts.filter(Boolean).join(" \n ");
    cache.set(id, text);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    console.log(`Frame OCR ${path.basename(String(name).split("?")[0])}: ${frames.length} frames, "${text.replace(/\s+/g, " ").slice(0, 60)}"`);
    return text;
  } catch (e) {
    console.warn("Frame OCR failed:", e.message);
    return "";
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { init, cfg, kind, embedMedia, sample, ocr, cache };
