// red-team ledger. attacks.json must all be caught (regression gate); attacks_open.json are known
// gaps, reported only. an open attack that becomes caught is flagged so it can be promoted.
const fs = require("fs");
const path = require("path");
const d = require("../detector");

const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), "utf8"));
const check = (a) => { d.setAnswers([a.answer]); return d.scan(a.text) === a.answer; };

const closed = load("attacks.json");
const open = load("attacks_open.json");

let fails = 0;
for (const a of closed) if (!check(a)) { fails++; console.log(`FAIL [${a.technique}] ${a.answer} <- ${JSON.stringify(a.text)}`); }
console.log(`attacks: ${closed.length - fails}/${closed.length} caught`);

const byTechnique = {};
for (const a of open) {
  (byTechnique[a.technique] ||= []).push(a);
  if (check(a)) console.log(`NOW CAUGHT (promote to attacks.json) [${a.technique}] ${a.answer} <- ${JSON.stringify(a.text)}`);
}
console.log(`open gaps: ${open.length} attacks across ${Object.keys(byTechnique).length} techniques`);
if (process.env.SHOW_OPEN) for (const [t, as] of Object.entries(byTechnique)) console.log(`  ${t}: ${JSON.stringify(as[0].text)}${as.length > 1 ? ` (+${as.length - 1})` : ""}`);
process.exit(fails ? 1 : 0);
