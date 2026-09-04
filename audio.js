// =====================================================================
// Audio layer: turns voice messages, audio files and video soundtracks
// into text so the pattern and LLM checks apply to speech too.
// Transcription is done by the OpenAI speech-to-text API; ffmpeg first
// strips video and downsamples so uploads stay small.
// =====================================================================
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

const cfg = {
  enabled: false,
  model: process.env.AUDIO_MODEL || "gpt-4o-transcribe",
  maxSeconds: Number(process.env.AUDIO_MAX_SECONDS || 600), // clips are cut here, not skipped
  maxBytes: 100_000_000, // skip huge uploads before downloading
  pricePerMinute: 0.006, // for the log line only
};

let client = null;
let ffmpegPath = null;
let OpenAI = null;

function init() {
  if ((process.env.TRANSCRIBE_AUDIO || "true").toLowerCase() !== "true") { console.log("Audio layer: off (TRANSCRIBE_AUDIO=false)"); return false; }
  if (!process.env.OPENAI_API_KEY) {
    console.log("Audio layer: disabled (no OPENAI_API_KEY in .env). Voice messages and audio/video files will not be transcribed.");
    return false;
  }
  try {
    ffmpegPath = process.env.FFMPEG_PATH || require("ffmpeg-static");
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) throw new Error(`ffmpeg binary not found at ${ffmpegPath}`);
    OpenAI = require("openai");
    client = new OpenAI();
  } catch (e) { console.error("Audio layer: unavailable:", e.message); return false; }
  cfg.enabled = true;
  console.log(`Audio layer: on (model ${cfg.model}, first ${cfg.maxSeconds}s of each clip)`);
  return true;
}

// ---------------------------------------------------------------------
// Which attachments carry sound
// ---------------------------------------------------------------------
const AUDIO_EXT = /\.(mp3|ogg|oga|opus|wav|m4a|aac|flac|weba|wma|aiff?)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;

function kind(attachment) {
  const type = attachment.contentType || "";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type && type !== "application/octet-stream") return null;
  const name = attachment.name || "";
  if (AUDIO_EXT.test(name)) return "audio";
  if (VIDEO_EXT.test(name)) return "video";
  return null;
}

// ---------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------
// edits and resolving embeds re-run the whole pipeline on the same message; never pay twice
const cache = new Map(); // attachment id -> transcript

async function transcribe(attachment) {
  if (!cfg.enabled) return "";
  if (cache.has(attachment.id)) return cache.get(attachment.id);
  if (attachment.size > cfg.maxBytes) { console.warn(`Skipping ${attachment.name}: ${attachment.size} bytes is over the audio cap`); return ""; }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wordle-audio-"));
  try {
    const input = path.join(dir, "input" + path.extname(attachment.name || "").toLowerCase());
    const res = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`download returned ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(input));
    const text = await transcribeFile(input, { name: attachment.name, duration: attachment.duration });
    cache.set(attachment.id, text);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return text;
  } catch (e) {
    if (OpenAI && e instanceof OpenAI.AuthenticationError) { console.error("Audio layer: invalid OPENAI_API_KEY, disabling."); cfg.enabled = false; }
    else if (OpenAI && e instanceof OpenAI.RateLimitError) console.warn("Audio layer: rate limited, skipping this clip.");
    else console.warn("Transcription failed:", e.message);
    return "";
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

// mono 16 kHz opus, first maxSeconds only: strips video, keeps uploads far under the api's 25 MB cap
async function transcribeFile(inputPath, { name = path.basename(inputPath), duration = null } = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wordle-audio-"));
  const out = path.join(dir, "audio.ogg");
  try {
    const stderr = await ffmpeg(["-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-t", String(cfg.maxSeconds), out]);
    const seconds = duration ?? parseDuration(stderr);
    const result = await client.audio.transcriptions.create({ file: fs.createReadStream(out), model: cfg.model });
    const text = (result.text || "").trim();
    const billed = Math.min(seconds, cfg.maxSeconds);
    const cut = seconds > cfg.maxSeconds ? `, cut from ${seconds.toFixed(0)}s` : "";
    console.log(`Transcribed ${name} (${billed.toFixed(1)}s${cut}, ~$${((billed / 60) * cfg.pricePerMinute).toFixed(4)}): "${text.slice(0, 60)}"`);
    return text;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: 60_000, maxBuffer: 4_000_000 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error("ffmpeg: " + (stderr || err.message).trim().split("\n").pop()));
      resolve(stderr);
    });
  });
}

function parseDuration(stderr) {
  const m = /Duration: (\d+):(\d+):(\d+\.?\d*)/.exec(stderr);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

module.exports = { init, cfg, kind, transcribe, transcribeFile };
