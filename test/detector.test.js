const d = require("../detector");
d.setAnswers(["wager"]);
const C = "wager", N = null;
const cases = [
  // plain / markdown
  ["today's answer is wager", C], ["WAGER!!", C], ["#wager", C], ["||wager||", C], ["`wager`", C], ["> wager", C], ["# wager", C], ["-# wager", C],
  ["```js\nwager\n```", C], ["[click](https://x.com/wager)", C], ["[wager](https://x.com)", C],
  // leet / wildcard / symbols
  ["W8g3r", C], ["w4g3r lol", C], ["w@ger", C], ["wa*er", C], ["w$g3r", C], ["vv8g3r", C], ["spa[m] w[a]ger", C],
  // separators / spacing / splitting
  ["w.a.g.e.r", C], ["w_a_g_e_r", C], ["w-a-g-e-r", C], ["w/a/g/e/r", C], ["w a g e r", C], ["w 8 g 3 r", C], ["w - a - g - e - r", C], ["wa ger", C], ["w ag er", C], ["wag er", C],
  // unicode
  ["wаger", C], ["wa​ger", C], ["wagér", C], ["ｗａｇｅｒ", C], ["🇼🇦🇬🇪🇷", C], ["🅦🅐🅖🅔🅡", C], ["𝐰𝐚𝐠𝐞𝐫", C], ["Ⓦⓐⓖⓔⓡ", C], ["ᴡᴀɢᴇʀ", C],
  ["‮regaw", C], ["w̶a̶g̶e̶r̶", C], ["ɹǝƃɐʍ", C], ["ẘåĝêŕ", C], ["ᵂᵃᵍᵉʳ", C],
  // encodings
  ["regaw", C], ["jntre", C], ["d2FnZXI=", C], ["7761676572", C], [".-- .- --. . .-.", C], ["23-1-7-5-18", C], ["23 1 7 5 18", C], ["119 97 103 101 114", C],
  ["77 61 67 65 72", C], ["01110111 01100001 01100111 01100101 01110010", C], ["%77%61%67%65%72", C], ["&#119;&#97;&#103;&#101;&#114;", C], ["\\u0077\\u0061\\u0067\\u0065\\u0072", C],
  ["xbhfs", C /* caesar +1 */], ["dztvi", C /* atbash */],
  // spoken letters
  ["whiskey alpha golf echo romeo", C], ["double-u ay gee ee ar", C], ["doubleyou a gee e are", C],
  // transcript-shaped (what speech-to-text emits for spoken letters, the audio layer relies on these)
  ["W-A-G-E-R", C], ["W, A, G, E, R.", C], ["Whiskey, Alpha, Golf, Echo, Romeo.", C], ["The answer is Wager.", C],
  // stretching / suffixes / typos / anagrams / vowels / interleave
  ["waaaager", C], ["wwaaggeerr", C], ["waager", C], ["wagers", C], ["wagered", C], ["wagering", C],
  ["wgaer", C], ["wager" .split("").reverse().join(""), C], ["wagr", C], ["wagger", N /* real word */], ["wsger", C], ["wgr", C], ["wxaxgxexr", C], ["wtaogdear", C],
  // visual pairs / phonetic
  ["vvager", C], ["Wayjer", C], ["wajer", C], ["waygur", C], ["VVAYJER", C],
  // acrostics
  ["wife angle grey ear red", C], ["wage real", C], ["wage and real", C], ["wage and then real", C], ["wag ever ring", C], ["🐳🍎🦒🥚🌈", C],
  // hidden in other content
  ["https://example.com/wager", C], ["wager123", C], ["<:wager:12345>", C], ["xx-wager-xx", C], ["https://www.merriam-webster.com/dictionary/wager", C],
  // ---- should NOT be caught ----
  ["hello everyone", N], ["got it in 3, so happy", N], ["mouse house", N], ["12345", N], ["w1234", N], ["my score is 3/6 today", N], ["a b c d e f g", N],
  ["water", N], ["I bet on it", N], ["Wordle 1,238 4/6\n⬛🟨⬛⬛⬛\n🟩🟩🟩🟩🟩", N], ["what a game", N], ["we are going", N], ["wicker", N], ["washer", N], ["wagon", N],
  ["wage", N], ["eager", N], ["vague", N], ["wife angle grey", N], ["lol", N], ["brb", N], ["l8r", N], ["2nite", N], ["gg ez 4/6", N], ["10:30", N], ["2024", N],
  ["see you at 5", N], ["call me at 555 1234", N], ["the meeting is 1 2 3 pm", N], ["https://discord.com/channels/123/456", N], ["😂😂😂", N], ["🟩🟩🟩🟩🟩", N],
  ["I got it in 4 today, that was rough", N], ["anyone else struggle", N], ["good morning all", N], ["water is wet", N], ["aged", N], ["wages", N],
];
let fails = 0;
for (const [i, exp] of cases) {
  const r = d.scan(i);
  const pass = r === exp; if (!pass) fails++;
  if (!pass) console.log("FAIL", JSON.stringify(i), "->", r, "(expected " + exp + ")");
}
console.log(`${cases.length - fails}/${cases.length} passed`);

// Generic sweep across other answers
const words = ["crane","light","piano","ghost","frown","jumbo","quilt","zebra","mirth","abbey","house","stare","plane","great","tiger"];
const leet = { a:"4",e:"3",i:"1",o:"0",s:"5",t:"7",b:"8",g:"9" };
const morse = {a:".-",b:"-...",c:"-.-.",d:"-..",e:".",f:"..-.",g:"--.",h:"....",i:"..",j:".---",k:"-.-",l:".-..",m:"--",n:"-.",o:"---",p:".--.",q:"--.-",r:".-.",s:"...",t:"-",u:"..-",v:"...-",w:".--",x:"-..-",y:"-.--",z:"--.."};
let tot=0, ok=0;
for (const w of words) { d.setAnswers([w]);
  const tricks=[w, w.toUpperCase()+"!!", "||"+w+"||", [...w].join("."), [...w].join(" "), [...w].map(c=>leet[c]||c).join(""), [...w].reverse().join(""), w+"s", "https://x.com/"+w,
    w[0]+w[0]+w[0]+w.slice(1), [...w].map(c=>String.fromCodePoint(0x1f1e6+c.charCodeAt(0)-97)).join(""), [...w].map(c=>(c.charCodeAt(0)-96)).join("-"), Buffer.from(w).toString("base64"), w.split("").map(c=>c+"x").join(""), [...w].map(c=>String.fromCharCode(((c.charCodeAt(0)-97+3)%26)+97)).join(""),
    // red-team round 1 (test/attacks.json has the originals)
    [...w].join(" then "), [...w].map((c,i)=>c+(i+1)).join(" "), [...w].map(c=>c+" for "+c+"ap").join(" "), [...w].join("🔥"), [...w].join("·"), [...w].join("?"), "xx"+w+"xx", "its"+w, w+"maxxing",
    [...w].map(c=>c+"ok").join("\n"), [...w].map((c,i)=>"x".repeat(i)+c+"x".repeat(4-i)).join("\n"), [...w].map(c=>c.toUpperCase()+"ab").join(" "),
    Buffer.from(w+"!").toString("base64"), Buffer.from([...w].join(" ")).toString("base64"), [...w].map(c=>(c.charCodeAt(0)-96)).join("/"), [...w].map(c=>(c.charCodeAt(0)-97)).join(" "), [...w].map(c=>c.charCodeAt(0).toString(8)).join(" "),
    [...w].map(c=>"\\x"+c.charCodeAt(0).toString(16)).join(""), "0x"+Buffer.from(w).toString("hex"), [...w].map(c=>"&#"+c.charCodeAt(0)).join(""), [...w].map(c=>"U+00"+c.charCodeAt(0).toString(16)).join(" "),
    [...w].map(c=>"22233344455566677778889999"[c.charCodeAt(0)-97]).join(""), [...w].map(c=>"⠁⠃⠉⠙⠑⠋⠛⠓⠊⠚⠅⠇⠍⠝⠕⠏⠟⠗⠎⠞⠥⠧⠺⠭⠽⠵"[c.charCodeAt(0)-97]).join(""),
    [...w].map(c=>morse[c].replace(/\./g,"·").replace(/-/g,"–")).join(" "), [...w].map(c=>morse[c]).join("/"), [...w].map(c=>String.fromCharCode(((c.charCodeAt(0)-97+5)%26)+97)).join(" "),
    // red-team round 2
    [...w].map(c=>"ho**"+c+"**ie").join(" "), [...w].map(c=>"ho*"+c+"*ie").join(" "), "ho**"+w.slice(0,2)+"**ii is **"+w.slice(2)+"**man", [...w].map(c=>"ho"+String.fromCodePoint(0x1d41a+c.charCodeAt(0)-97)+"ie").join(" "),
    "LMAO OMG "+[...w].map(c=>"ho"+c.toUpperCase()+"ie").join(" "), [...w].map(c=>"HO"+c+"IE").join(" "), [...w].map(c=>(c.charCodeAt(0)-96)).join(" • "), [...w].map(c=>"("+(c.charCodeAt(0)-96)+")").join(""), [...w].map(c=>(c.charCodeAt(0)-96)).join(" then "),
    [...w].map(c=>morse[c]).join("\n"), [...w].map(c=>morse[c].replace(/\./g,"dot ").replace(/-/g,"dash ").trim()).join(", "), [...w].map(c=>morse[c].replace(/\./g,"🔴").replace(/-/g,"➖")).join(" "),
    [...w].map(c=>"<:blue_letter_"+c+":1>").join(""), [...w].map(c=>":letter_"+c+":").join(""), [...w].map(c=>String.fromCharCode(((c.charCodeAt(0)-97+13)%26)+97)).join("")+"f",
    "```\nday 5\n"+[...w].map((c,i)=>"x".repeat(i+1)+c+"x".repeat(5-i)).join("\n")+"\n```", [...w].map(c=>c+" then").join(" ")];
  for (const t of tricks) { tot++; if (d.scan(t)===w) ok++; else console.log("MISS", w, JSON.stringify(t), "->", d.scan(t)); }
}
console.log(`generic tricks: ${ok}/${tot}`);

// False positive sweep on realistic chat
const chat = ["I saw a star every night this week","we plan everything on sundays","lets grab lunch at noon tomorrow","did you get it today","i got it in three guesses","so close today","anyone else struggle today","that was a hard one","my streak is alive","lol that was tough","gg everyone","anyone want to play something later","brb getting food","who is online right now","this bot is annoying","can we talk about the game","i love this server","the weather is nice today","hows everyone doing","good morning all","see you at 5","meeting at 10:30","my number ends in 1234","happy birthday!!","🎉🎉🎉 congrats","nice one","ok cool","idk tbh","im so tired","what time is the game","brb 5 min","the code is 1 2 3 4 5 6","lets go team","that movie was great","i live in a big house","turn on the light","i hate mondays","pizza tonight?","who won","same here"];
const fp = {};
for (const w of ["crane","light","piano","ghost","frown","jumbo","quilt","zebra","mirth","abbey","house","stare","plane","great","tiger","wager","later","today","nicer"]) { d.setAnswers([w]); const hits = chat.filter(s=>d.scan(s)); if (hits.length) fp[w]=hits; }
console.log("false positives:", JSON.stringify(fp, null, 1));
process.exit(fails ? 1 : 0);
