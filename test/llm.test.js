// Live test of the LLM layer. Needs ANTHROPIC_API_KEY in .env. Costs a few cents.
require("dotenv").config();
const llm = require("../llm");
if (!llm.init()) process.exit(1);
const answers = ["wager"];
const cases = [
  // should be spoiler/hint
  ["rhymes with pager", "hint"], ["it's a gambling term, five letters", "hint"], ["starts with W and ends with R", "hint"],
  ["today's word means a bet", "spoiler"], ["la palabra de hoy es apuesta", "spoiler"], ["wette (german)", "spoiler"],
  ["the word is what you place at a casino before the roulette spins", "spoiler"], ["same as yesterday's but swap the first letter for W", "hint"],
  ["think Pascal's famous argument for believing in god", "hint"], ["put your money where your mouth is, 5 letters", "hint"],
  // should be clean
  ["Wordle 1,238 4/6\n⬛🟨⬛⬛⬛\n🟩🟩🟩🟩🟩", "clean"], ["that one was brutal today", "clean"], ["got it in 3!", "clean"],
  ["anyone want pizza tonight", "clean"], ["I bet the game goes to overtime", "clean"], ["the weather is nice today", "clean"],
];
(async () => {
  let ok = 0, inTok = 0, outTok = 0, cached = 0;
  for (const [text, expected] of cases) {
    const r = await llm.classify({ text, answers });
    if (!r) { console.log("ERROR", JSON.stringify(text)); continue; }
    const del = llm.shouldDelete(r);
    const expectDelete = expected !== "clean";
    const pass = del === expectDelete;
    if (pass) ok++;
    inTok += r.usage?.input_tokens || 0; outTok += r.usage?.output_tokens || 0; cached += r.usage?.cache_read_input_tokens || 0;
    console.log(pass ? "PASS" : "FAIL", `${r.verdict}(${r.confidence})`, del ? "DELETE" : "keep  ", JSON.stringify(text.slice(0, 50)), "-", r.reason);
  }
  const cost = (inTok * 5 + cached * 0.5 + outTok * 25) / 1e6;
  console.log(`\n${ok}/${cases.length} correct. Tokens in ${inTok} (cached ${cached}) out ${outTok}. Approx cost $${cost.toFixed(4)} for ${cases.length} messages (~$${(cost / cases.length).toFixed(4)} each)`);
})();
