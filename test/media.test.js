const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { execFileSync } = require("node:child_process");
const frames = require("../frames");
const llm = require("../llm");
const { clip } = require("./fixtures");
const { extractAsset } = require("../inspection");

test("a single-frame change and a repeated letter separated by another frame survive", async () => {
  frames.init();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wordle-media-test-"));
  try {
    const input = path.join(dir, "flash.mkv");
    execFileSync(require("ffmpeg-static"), ["-v", "error", "-f", "lavfi", "-i", "color=white:s=320x120:r=5:d=0.6", "-vf", "drawbox=color=black:t=fill:enable='eq(n,1)'", "-c:v", "ffv1", input]);
    const colors = [];
    const result = await frames.decode(input, async (png) => { colors.push((await sharp(png).raw().toBuffer())[0]); });
    assert.equal(colors.length, 3);
    assert.ok(colors[0] > 245 && colors[1] < 10);
    assert.equal(colors[2], colors[0]);
    assert.deepEqual(result.issues, []);
    assert.equal(result.count, 3);
    const cap = frames.cfg.maxFrames;
    frames.cfg.maxFrames = 2;
    try { assert.ok((await frames.decode(input, async () => {})).issues.includes("video frame limit exceeded")); }
    finally { frames.cfg.maxFrames = cap; }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("a silent video is visually inspected without a spurious audio failure", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wordle-media-test-"));
  const original = global.fetch;
  try {
    const file = clip(path.join(dir, "silent.mp4"), ["white", "black"]);
    const bytes = await fs.readFile(file);
    global.fetch = async () => new Response(bytes);
    const result = await extractAsset({ url: "https://cdn.discordapp.com/attachments/test", name: "silent.mp4" }, { ocrImage: async () => "hello" });
    assert.match(result.text, /hello/);
    assert.ok(result.images.length >= 2);
    assert.deepEqual(result.issues, []);
  } finally { global.fetch = original; await fs.rm(dir, { recursive: true, force: true }); }
});

test("later vision batches are checked even if an earlier request fails", async () => {
  const enabled = llm.cfg.enabled;
  llm.cfg.enabled = true;
  let requests = 0;
  try {
    const client = { beta: { messages: { create: async () => {
      requests++;
      if (requests === 1) throw new Error("temporary failure");
      return { content: [{ type: "text", text: JSON.stringify({ verdict: "spoiler", confidence: 1, reason: "visible answer" }) }] };
    } } } };
    const result = await llm.classify({ text: "", answers: ["wager"], imageUrls: Array.from({ length: 21 }, (_, i) => `https://example.com/${i}.png`) }, client);
    assert.equal(requests, 2);
    assert.equal(result.verdict, "spoiler");
  } finally { llm.cfg.enabled = enabled; }
});
