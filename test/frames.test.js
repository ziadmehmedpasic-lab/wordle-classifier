// real tesseract over ffmpeg-built fixtures: text on a later frame, one letter per frame, and an mp4. needs a font
// on the machine (see test/fixtures.js) and downloads tesseract's english data on first run. not part of npm test.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const frames = require("../frames");
const detector = require("../detector");
const { clip, font } = require("./fixtures");

(async () => {
  if (!font) { console.log("frames live: no font for drawtext fixtures, skipping"); process.exit(0); }
  assert.ok(frames.init());
  const { createWorker } = require("tesseract.js");
  const worker = await createWorker("eng");
  const ocrImage = async (f) => (await worker.recognize(f)).data.text || "";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wordle-frames-live-"));
  detector.setAnswers(["wager"]);
  const cases = [
    ["two_frame.gif", ["hello", "WAGER"]],
    ["per_letter.gif", ["W", "A", "G", "E", "R"]],
    ["two_frame.mp4", ["hello", "WAGER"]],
    ["late.gif", ["nothing", "to", "see", "here", "wager"]],
  ];
  let fails = 0;
  for (const [name, texts] of cases) {
    const file = clip(path.join(dir, name), texts, { text: true });
    const { text, issues } = await frames.inspectFile(file, ocrImage);
    assert.deepStrictEqual(issues, []);
    const hit = detector.scan(text);
    console.log(`${hit === "wager" ? "ok  " : "MISS"} ${name}: ${JSON.stringify(text.replace(/\s+/g, " "))}`);
    if (hit !== "wager") fails++;
  }
  // a gif with no text on any frame must not hit
  const blank = clip(path.join(dir, "blank.gif"), ["red", "blue", "green"]);
  const { text: blankText } = await frames.inspectFile(blank, ocrImage);
  if (detector.scan(blankText)) { fails++; console.log("MISS blank.gif hit:", JSON.stringify(blankText)); }
  await worker.terminate();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`frames live: ${cases.length + 1 - fails}/${cases.length + 1} passed`);
  process.exit(fails ? 1 : 0);
})();
