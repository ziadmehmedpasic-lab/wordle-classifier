// runs generated ml data through the pattern detector: recall per style on direct records,
// false-positive rate on everything else. usage: node test/eval_data.js [--write] [file.jsonl ...]
// --write adds a boolean "detector_hit" field to every record in place, so the ml side can
// score the classifier on the traffic that actually reaches it (layer 1 deletes the rest first).
const fs = require("fs");
const path = require("path");
const d = require("../detector");

const args = process.argv.slice(2);
const write = args.includes("--write");
const dataDir = path.join(__dirname, "../ml/data/generated");
const files = args.filter((a) => a !== "--write");
if (!files.length) files.push(...fs.readdirSync(dataDir).map((f) => path.join(dataDir, f)));
const byFile = files.map((f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const records = byFile.flat();

const byStyle = {};
const misses = [];
const fps = [];
for (const r of records) {
  d.setAnswers([r.answer]);
  const hit = d.scan(r.text);
  r.detector_hit = Boolean(hit);
  if (r.label === "direct") {
    const s = (byStyle[r.style] ||= { n: 0, hit: 0 });
    s.n++;
    if (hit) s.hit++; else misses.push(r);
  } else if (hit) fps.push({ ...r, hit });
}
const direct = records.filter((r) => r.label === "direct").length;
console.log(`direct recall: ${direct - misses.length}/${direct}`);
for (const [style, s] of Object.entries(byStyle).sort((a, b) => a[1].hit / a[1].n - b[1].hit / b[1].n)) console.log(`  ${style.padEnd(16)} ${s.hit}/${s.n}`);
console.log(`false positives on non-direct: ${fps.length}/${records.length - direct}`);
for (const r of fps) console.log(`  FP [${r.label}/${r.style}] ${r.answer} <- ${JSON.stringify(r.text)} (hit ${r.hit})`);
if (process.env.SHOW_MISSES) for (const r of misses) console.log(`  MISS [${r.style}] ${r.answer} <- ${JSON.stringify(r.text)}`);

// what the classifier actually sees: everything layer 1 lets through
const passed = records.filter((r) => !r.detector_hit);
console.log(`reaches the classifier: ${passed.length}/${records.length}`);
for (const label of ["direct", "strong_hint", "weak_hint", "benign"]) {
  const n = records.filter((r) => r.label === label).length;
  console.log(`  ${label.padEnd(12)} ${passed.filter((r) => r.label === label).length}/${n}`);
}

// python's json.dumps layout, so a restamp only touches the field it adds
function fmt(v) {
  if (Array.isArray(v)) return `[${v.map(fmt).join(", ")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${fmt(x)}`).join(", ")}}`;
  return JSON.stringify(v);
}
if (write) {
  files.forEach((f, i) => fs.writeFileSync(f, byFile[i].map(fmt).join("\n") + "\n"));
  console.log(`wrote detector_hit to ${files.length} file(s)`);
}

// pair mode: every non-direct text against a fixed sample of past answers. a rule's collision
// rate with ordinary chat shows up here even when no record was written for that answer.
if (process.env.PAIRS) {
  const answers = fs.readFileSync(path.join(__dirname, "../ml/data/answers.txt"), "utf8").split("\n").filter(Boolean);
  const sample = answers.filter((_, i) => i % Math.ceil(answers.length / +process.env.PAIRS) === 0);
  const texts = records.filter((r) => r.label === "benign").map((r) => r.text);
  const hits = [];
  for (const a of sample) { d.setAnswers([a]); for (const t of texts) if (d.scan(t)) hits.push([a, t]); }
  console.log(`benign pairs flagged: ${hits.length}/${sample.length * texts.length} (${sample.length} answers x ${texts.length} texts)`);
  for (const [a, t] of hits) console.log(`  ${a} <- ${JSON.stringify(t)}`);
  // benign chat in other scripts (test/foreign_chat.json) against every answer: what the transliteration rule collides with
  const foreign = JSON.parse(fs.readFileSync(path.join(__dirname, "foreign_chat.json"), "utf8"));
  let n = 0;
  for (const a of answers) { d.setAnswers([a]); for (const t of foreign) if (d.scan(t)) n++; }
  console.log(`foreign chat pairs flagged: ${n}/${answers.length * foreign.length} (${answers.length} answers x ${foreign.length} texts)`);
}
