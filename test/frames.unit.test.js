// offline checks for frame sampling: attachment/embed classification, ffmpeg sampling with duplicate frames dropped,
// and the frame texts reaching the detector in order. ocr is faked here; test/frames.test.js runs real tesseract.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const frames = require("../frames");
const detector = require("../detector");
const { clip } = require("./fixtures");

let fails = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; } catch (e) { fails++; console.log(`FAIL ${name}: ${e.message}`); }
}

(async () => {
  assert.ok(frames.init(), "ffmpeg available");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wordle-frames-test-"));

  await check("attachment kinds", () => {
    assert.strictEqual(frames.kind({ contentType: "image/gif", name: "a.gif" }), "gif");
    assert.strictEqual(frames.kind({ contentType: null, name: "a.GIF" }), "gif");
    assert.strictEqual(frames.kind({ contentType: "video/mp4", name: "a.mp4" }), "video");
    assert.strictEqual(frames.kind({ contentType: "application/octet-stream", name: "a.mov" }), "video");
    assert.strictEqual(frames.kind({ contentType: "image/png", name: "a.png" }), null);
    assert.strictEqual(frames.kind({ contentType: "text/plain", name: "a.gif.txt" }), null);
  });
  await check("embed media", () => {
    assert.strictEqual(frames.embedMedia({ video: { url: "https://media.tenor.com/x/AAAAPo/tenor.mp4" }, thumbnail: { url: "https://media.tenor.com/x/AAAAe/tenor.png" } }), "https://media.tenor.com/x/AAAAPo/tenor.mp4");
    assert.strictEqual(frames.embedMedia({ thumbnail: { url: "https://media.giphy.com/media/abc/giphy.gif?cid=1" } }), "https://media.giphy.com/media/abc/giphy.gif?cid=1");
    assert.strictEqual(frames.embedMedia({ thumbnail: { url: "https://i.imgur.com/x.png" } }), null);
    assert.strictEqual(frames.embedMedia({}), null);
  });

  // five distinct colour frames, then the last one held for three seconds: five frames after dedupe, not eight
  const five = clip(path.join(dir, "five.gif"), ["red", "blue", "green", "yellow", "black", "black", "black", "black"]);
  const still = clip(path.join(dir, "still.gif"), ["red", "red", "red"]);
  const mp4 = clip(path.join(dir, "two.mp4"), ["red", "blue"]);
  await check("distinct frames kept, held frames dropped", async () => {
    const out = fs.mkdtempSync(path.join(dir, "s1-"));
    const got = await frames.sample(five, out);
    assert.strictEqual(got.length, 5, `got ${got.length} frames`);
  });
  await check("a static gif is one frame", async () => {
    const out = fs.mkdtempSync(path.join(dir, "s2-"));
    assert.strictEqual((await frames.sample(still, out)).length, 1);
  });
  await check("mp4 samples too", async () => {
    const out = fs.mkdtempSync(path.join(dir, "s3-"));
    assert.strictEqual((await frames.sample(mp4, out)).length, 2);
  });
  await check("frame cap", async () => {
    const out = fs.mkdtempSync(path.join(dir, "s4-"));
    const saved = frames.cfg.maxFrames;
    frames.cfg.maxFrames = 3;
    try { assert.strictEqual((await frames.sample(five, out)).length, 3); } finally { frames.cfg.maxFrames = saved; }
  });

  // serve the gif over http and fake the per-frame ocr: frame k reads as the k-th letter of the answer
  const server = http.createServer((req, res) => {
    if (req.url !== "/five.gif") { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "image/gif" });
    fs.createReadStream(five).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/five.gif`;
  let calls = 0;
  const fakeOcr = async () => "wager"[calls++] || "";
  await check("one letter per frame reads as the word", async () => {
    const text = await frames.ocr(url, fakeOcr, { id: "att1", name: "five.gif" });
    assert.strictEqual(text, "w \n a \n g \n e \n r");
    detector.setAnswers(["wager"]);
    assert.strictEqual(detector.scan(text), "wager");
  });
  await check("cached per attachment id", async () => {
    const before = calls;
    await frames.ocr(url, fakeOcr, { id: "att1", name: "five.gif" });
    assert.strictEqual(calls, before);
  });
  await check("oversize is skipped", async () => {
    assert.strictEqual(await frames.ocr(url, fakeOcr, { id: "att2", name: "big.gif", size: 10 ** 9 }), "");
  });
  await check("download failure gives empty text", async () => {
    assert.strictEqual(await frames.ocr(url.replace("five", "missing"), fakeOcr, { id: "att3" }), "");
  });
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`frames unit: ${passed}/${passed + fails} passed`);
  process.exit(fails ? 1 : 0);
})();
