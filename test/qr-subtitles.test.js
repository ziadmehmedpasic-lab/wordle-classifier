const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const QRCode = require("qrcode");
const { execFileSync } = require("node:child_process");
const { decodeQr } = require("../qr");
const { inspectFile, cfg, readSubtitles } = require("../frames");
const detector = require("../detector");

test("QR payloads decode exactly across rotation/inversion and multiple codes", async () => {
  detector.setAnswers(["wager"]);
  const spoiler = await QRCode.toBuffer("WAGER", { width: 240 });
  const benign = await QRCode.toBuffer("coffee", { width: 240 });
  for (const bytes of [spoiler, await sharp(spoiler).rotate(90).png().toBuffer(), await sharp(spoiler).negate({ alpha: false }).png().toBuffer()]) assert.deepEqual(await decodeQr(bytes), ["WAGER"]);
  assert.deepEqual(await decodeQr(benign), ["coffee"]);
  const combined = await sharp({ create: { width: 520, height: 260, channels: 3, background: "white" } }).composite([{ input: benign, left: 10, top: 10 }, { input: spoiler, left: 270, top: 10 }]).png().toBuffer();
  assert.ok((await decodeQr(combined)).includes("WAGER"));
});

test("text subtitle streams reach inspection even when every video frame is blank", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wordle-subtitle-test-"));
  const input = path.join(directory, "video.mkv");
  cfg.enabled = true;
  try {
    const srt = path.resolve("eval/fixtures/subtitle.srt");
    execFileSync(require("ffmpeg-static"), ["-v", "error", "-f", "lavfi", "-i", "color=white:s=320x100:r=5:d=1", "-i", srt, "-map", "0:v:0", "-map", "1:s:0", "-c:v", "ffv1", "-c:s", "srt", input]);
    const result = await inspectFile(input, async () => "");
    assert.match(result.text, /WAGER/);
    assert.deepEqual(result.issues, []);
    const unsupported = await readSubtitles(input, [{ index: 1, codec_name: "hdmv_pgs_subtitle" }]);
    assert.ok(unsupported.issues[0].includes("unsupported subtitle codec"));
    const failed = await readSubtitles(input, [{ index: 99, codec_name: "subrip" }]);
    assert.ok(failed.issues[0].includes("subtitle extraction failed"));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
