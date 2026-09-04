const detector = require("./detector");
const llm = require("./llm");
const audio = require("./audio");
const frames = require("./frames");
const gifs = require("./gifs");
const { download } = require("./download");
const { extractDocument } = require("./documents");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const limits = { assets: 32, text: 200_000, images: 100, imageBytes: 24_000_000, concurrent: 2, waiting: 16, waitMs: 30_000 };
let active = 0;
const waiting = [];

/** @param {object} message @returns {{text: string, assets: object[], issues: string[]}} */
function collectContent(message) {
  const texts = [];
  const assets = new Map();
  const issues = [];
  const seen = new Set();
  const pending = [{ value: message, depth: 0 }];
  while (pending.length) {
    if (seen.size >= 1000) { issues.push("content node limit exceeded"); break; }
    const { value, depth } = pending.pop();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (depth > 8) { issues.push("nested content exceeds depth limit"); continue; }
    texts.push(value.content);
    for (const a of value.attachments?.values?.() || []) {
      texts.push(a.name, a.description, a.title);
      assets.set(a.url, a);
    }
    for (const e of value.embeds || []) {
      texts.push(e.title, e.description, e.url, e.author?.name, e.footer?.text, e.provider?.name);
      for (const f of e.fields || []) texts.push(f.name, f.value);
      const video = frames.embedMedia(e);
      if (video) assets.set(video, { url: video, name: video.split("?")[0], contentType: "video/mp4" });
      for (const image of [e.image, e.thumbnail]) {
        if (image?.url && image.url !== video) assets.set(image.url, { url: image.url, contentType: "image/png" });
      }
    }
    for (const s of value.stickers?.values?.() || []) {
      texts.push(s.name, s.description);
      if (s.url) assets.set(s.url, { url: s.url, name: s.name, unsupported: s.format === 3 ? "Lottie sticker rendering unsupported" : undefined });
    }
    for (const match of (value.content || "").matchAll(/<(a?):[a-z0-9_]+:(\d+)>/gi)) {
      const url = `https://cdn.discordapp.com/emojis/${match[2]}.${match[1] ? "gif" : "png"}?size=256`;
      assets.set(url, { url, name: "custom emoji" });
    }
    if (value.poll) {
      texts.push(value.poll.question?.text);
      for (const a of value.poll.answers?.values?.() || []) texts.push(a.text);
    }
    // reversed pushes preserve the visible order of forwarded content and components.
    const children = [...(value.messageSnapshots?.values?.() || []), ...(value.components || [])];
    for (let i = children.length - 1; i >= 0; i--) pending.push({ value: children[i], depth: depth + 1 });
    const data = value.data || value;
    if (data !== value) {
      for (const child of data.components || []) pending.push({ value: child, depth: depth + 1 });
    }
    if (data.accessory) pending.push({ value: data.accessory, depth: depth + 1 });
    texts.push(data.label, data.description, data.placeholder, data.url);
    if (data !== value) texts.push(data.content);
    for (const option of data.options || []) texts.push(option.label, option.description, option.value);
    if (value.component) pending.push({ value: value.component, depth: depth + 1 });
    for (const item of data.items || []) {
      texts.push(item.description);
      if (item.media?.url) assets.set(item.media.url, { url: item.media.url, contentType: "image/png" });
    }
    for (const media of [data.media, data.file]) {
      if (media?.url && !media.url.startsWith("attachment://")) assets.set(media.url, { url: media.url, contentType: data.file ? "application/octet-stream" : "image/png" });
    }
  }
  return { text: texts.filter((t) => typeof t === "string" && t).join("\n"), assets: [...assets.values()], issues };
}

/** @param {object} asset @param {object} options @returns {Promise<{text: string, images: string[], issues: string[]}>} */
async function extractAsset(asset, { ocrImage, downloadFile = download }) {
  if (asset.unsupported) return { text: "", images: [], issues: [asset.unsupported] };
  const bytes = await downloadFile(asset.url);
  const result = await extractDocument(bytes, { name: asset.name, ocrImage });
  const texts = [result.text];
  for (const clip of result.clips) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wordle-attachment-"));
    try {
      const input = path.join(dir, clip.contentType === "image/gif" ? "input.gif" : "input");
      await fs.writeFile(input, clip.bytes);
      if (clip.contentType.startsWith("video/") || ["image/gif", "image/apng"].includes(clip.contentType)) {
        if (!frames.cfg.enabled) result.issues.push("frame inspection disabled");
        else {
          const visual = await frames.inspectFile(input, ocrImage);
          texts.push(visual.text);
          result.images.push(...visual.images);
          result.issues.push(...visual.issues);
        }
      }
      const metadata = await frames.probe(input);
      const tracks = metadata.streams.filter((stream) => stream.codec_type === "audio");
      if (tracks.length) {
        if (!audio.cfg.enabled) result.issues.push("audio inspection disabled");
        else {
          const duration = Number(metadata.format.duration);
          texts.push(await audio.transcribeFile(input, { name: clip.name, duration }));
          if (!Number.isFinite(duration) || duration > audio.cfg.maxSeconds) result.issues.push("audio duration exceeds limit or is unknown");
          if (tracks.length > 1) result.issues.push("additional audio tracks are unscanned");
        }
      }
    } catch (error) { result.issues.push(`media inspection failed: ${error.message}`); }
    finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
  return { text: texts.filter(Boolean).join("\n"), images: result.images, issues: result.issues };
}

/** @param {object} message @param {object} options @returns {Promise<object>} */
async function inspectMessage(message, { ocrImage, context = [], extract = extractAsset, judge = llm, describe = gifs.describe, forceJudge = false }) {
  const content = collectContent(message);
  const texts = [content.text];
  const fragments = [message.content || ""];
  const images = [];
  const issues = [...content.issues];
  let hit = detector.scan(content.text);
  if (hit) return { status: "spoiler", hit, text: content.text, issues };
  if (active >= limits.concurrent) {
    if (waiting.length >= limits.waiting) return { status: "unscanned", text: content.text, issues: [...issues, "inspection queue full"] };
    const admitted = await new Promise((resolve) => {
      const grant = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => {
        const index = waiting.indexOf(grant);
        if (index >= 0) { waiting.splice(index, 1); resolve(false); }
      }, limits.waitMs);
      waiting.push(grant);
    });
    if (!admitted) return { status: "unscanned", text: content.text, issues: [...issues, "inspection queue wait expired"] };
  } else active++;
  try {
    let textLength = content.text.length;
    let imageBytes = 0;
    if (content.text.length > limits.text) { texts[0] = content.text.slice(0, limits.text); issues.push("message text limit exceeded"); }
    if (context.some((row) => row.truncated)) issues.push("context text was truncated");
    if (/https?:\/\/\S+/i.test(content.text)) issues.push("external linked pages are not certified by media inspection");
    if (content.assets.length > limits.assets) issues.push("message attachment limit exceeded");
    const tags = await describe(content.text);
    if (tags) { texts.push(tags.slice(0, Math.max(0, limits.text - textLength))); textLength += tags.length; }
    for (const asset of content.assets.slice(0, limits.assets)) {
      try {
        const result = await extract(asset, { ocrImage });
        const assetHit = detector.scan(result.text);
        if (assetHit) return { status: "spoiler", hit: assetHit, text: result.text, issues: [...issues, ...result.issues] };
        const remaining = Math.max(0, limits.text - textLength);
        texts.push(result.text.slice(0, remaining));
        fragments.push(result.text.slice(0, remaining));
        textLength += result.text.length;
        if (result.text.length > remaining) issues.push("combined extracted text limit exceeded");
        for (const image of result.images) {
          imageBytes += Buffer.byteLength(image);
          if (images.length >= limits.images || imageBytes > limits.imageBytes) {
            issues.push("message vision limit exceeded");
            break;
          }
          images.push(image);
        }
        issues.push(...result.issues.map((issue) => `${asset.id || asset.name || "media"}: ${issue}`));
      } catch (error) {
        issues.push(`media inspection failed: ${error.message}`);
      }
      // check the combined caption, files, OCR and speech after each asset.
      hit = detector.scan(texts.filter(Boolean).join("\n"));
      if (hit) return { status: "spoiler", hit, text: texts.filter(Boolean).join("\n"), issues };
    }
    const text = texts.filter(Boolean).join("\n");
    hit = detector.scan(text);
    if (hit) return { status: "spoiler", hit, text, issues };
    if (images.length && !judge.cfg.vision) issues.push("vision inspection disabled");
    judge.noteContext(message.channelId, text);
    if ((forceJudge && judge.cfg.enabled) || judge.shouldCheck(message.channelId, text, images.length > 0, content.assets.length > 0)) {
      const result = await judge.classify({ text, answers: detector.getAnswers(), context, imageUrls: judge.cfg.vision ? images : [] });
      if (!result) issues.push("meaning classifier failed");
      else if (judge.shouldDelete(result)) return { status: "spoiler", hit: result.verdict, text, issues };
      else if (result.issues) issues.push(...result.issues);
    } else if (!judge.cfg.enabled) issues.push("meaning classifier disabled");
    return { status: issues.length ? "unscanned" : "clean", text, fragmentText: fragments.filter(Boolean).join("\n"), issues: [...new Set(issues)] };
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

module.exports = { collectContent, extractAsset, inspectMessage, limits };
