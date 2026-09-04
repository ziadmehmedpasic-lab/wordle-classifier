// Live test of the audio layer. Needs OPENAI_API_KEY in .env and macOS `say` to synthesise the clips.
// Costs under a cent of transcription, plus a few LLM cents when ANTHROPIC_API_KEY is set.
require("dotenv").config();
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const audio = require("../audio");
const llm = require("../llm");
const detector = require("../detector");

if (!audio.init()) process.exit(1);
if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/say")) { console.log("skipped: macOS say not available"); process.exit(0); }
const llmOn = llm.init();
detector.setAnswers(["wager"]);
const ffmpeg = process.env.FFMPEG_PATH || require("ffmpeg-static");

// [sentence, expected outcome, containers]; "detector" = pattern layer must hit, "hint"/"clean" = LLM verdict
const cases = [
  ["The answer is wager.", "detector", ["ogg", "mp4"]],
  ["W. A. G. E. R.", "detector", ["ogg"]],
  ["Whiskey, Alpha, Golf, Echo, Romeo.", "detector", ["ogg"]],
  ["Today's word rhymes with pager.", "hint", ["ogg"]],
  ["It's a gambling term, five letters.", "hint", ["ogg"]],
  ["Got it in four today, that was rough.", "clean", ["ogg"]],
  ["Anyone want pizza tonight?", "clean", ["ogg"]],
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wordle-audio-test-"));
const tmpBefore = new Set(fs.readdirSync(os.tmpdir()));

function synth(i, sentence, ext) {
  const aiff = path.join(dir, `${i}.aiff`);
  if (!fs.existsSync(aiff)) execFileSync("say", ["-v", "Samantha", "-o", aiff, sentence]);
  const out = path.join(dir, `${i}.${ext}`);
  const args = ext === "mp4"
    ? ["-y", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=5", "-i", aiff, "-shortest", "-c:v", "libx264", "-c:a", "aac", out] // phone video
    : ["-y", "-i", aiff, "-c:a", "libopus", "-ar", "48000", "-ac", "1", out]; // discord voice message
  execFileSync(ffmpeg, args, { stdio: "ignore" });
  return out;
}

(async () => {
  let ok = 0, total = 0;
  try {
    for (const [i, [sentence, expected, exts]] of cases.entries()) {
      for (const ext of exts) {
        total++;
        const t = await audio.transcribeFile(synth(i, sentence, ext), { name: `${i}.${ext}` });
        const hit = detector.scan(t);
        let pass, detail;
        if (expected === "detector") { pass = hit !== null; detail = `detector -> ${hit}`; }
        else if (hit) { pass = false; detail = `detector false positive -> ${hit}`; }
        else if (!llmOn) { pass = true; detail = "detector clean (LLM off, verdict not checked)"; }
        else {
          const r = await llm.classify({ text: "[voice transcript]: " + t, answers: ["wager"] });
          const del = llm.shouldDelete(r);
          pass = del === (expected !== "clean");
          detail = `${r?.verdict}(${r?.confidence}) ${del ? "DELETE" : "keep"} - ${r?.reason}`;
        }
        if (pass) ok++;
        console.log(pass ? "PASS" : "FAIL", ext, JSON.stringify(sentence), "->", JSON.stringify(t), "|", detail);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const leftovers = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("wordle-audio-") && !tmpBefore.has(n));
  if (leftovers.length) { console.log("FAIL temp dirs left behind:", leftovers.join(", ")); total++; }
  console.log(`\n${ok}/${total} correct.`);
  process.exit(ok === total ? 0 : 1);
})();
