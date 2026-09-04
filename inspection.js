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

/** @param {object} message @returns {{text: string, assets: object[], issues: string[]}} */
function collectContent(message) {
  const texts = [];
  const assets = new Map();
  const issues = [];
  const seen = new Set();
  const pending = [{ value: message, depth: 0 }];
  while (pending.length) {
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
    for (const s of value.stickers?.values?.() || []) texts.push(s.name, s.description);
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
async function extractAsset(asset, { ocrImage }) {
  const bytes = await download(asset.url);
  const result = await extractDocument(bytes, { name: asset.name, ocrImage });
  const texts = [result.text];
  for (const clip of result.clips) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wordle-attachment-"));
    try {
      const input = path.join(dir, "input");
      await fs.writeFile(input, clip.bytes);
      if (clip.contentType.startsWith("video/") || clip.contentType === "image/gif") {
        if (!frames.cfg.enabled) result.issues.push("frame inspection disabled");
        else {
          for (const frame of await frames.sample(input, dir)) texts.push(await ocrImage(frame));
          result.issues.push("animation inspected by sampling only");
        }
      }
      if (audio.kind(clip)) {
        if (!audio.cfg.enabled) result.issues.push("audio inspection disabled");
        else {
          texts.push(await audio.transcribeFile(input, { name: clip.name }));
          result.issues.push("audio inspected within duration cap only");
        }
      }
    } catch (error) { result.issues.push(`media inspection failed: ${error.message}`); }
    finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
  return { text: texts.filter(Boolean).join("\n"), images: result.images, issues: result.issues };
}

/** @param {object} message @param {object} options @returns {Promise<object>} */
async function inspectMessage(message, { ocrImage, context = [], extract = extractAsset, judge = llm, describe = gifs.describe }) {
  const content = collectContent(message);
  const texts = [content.text];
  const images = [];
  const issues = [...content.issues];
  let hit = detector.scan(content.text);
  if (hit) return { status: "spoiler", hit, text: content.text, issues };
  const tags = await describe(content.text);
  if (tags) texts.push(tags);
  for (const asset of content.assets) {
    try {
      const result = await extract(asset, { ocrImage });
      texts.push(result.text);
      images.push(...result.images);
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
  judge.noteContext(message.channelId, text);
  if (judge.shouldCheck(message.channelId, text, images.length > 0, content.assets.length > 0)) {
    const result = await judge.classify({ text, answers: detector.getAnswers(), context, imageUrls: judge.cfg.vision ? images : [] });
    if (!result) issues.push("meaning classifier failed");
    else if (judge.shouldDelete(result)) return { status: "spoiler", hit: result.verdict, text, issues };
  } else if (!judge.cfg.enabled) issues.push("meaning classifier disabled");
  return { status: issues.length ? "unscanned" : "clean", text, issues };
}

module.exports = { collectContent, extractAsset, inspectMessage };
