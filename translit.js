// transliteration of other scripts back to latin letters, so وايجر, вейджер, γουέιτζερ and ワゲル
// can be matched by sound. each letter maps to one or more latin spellings and every combination
// is returned (capped, primary spellings first); the detector runs its fuzzy checks over them.
// abjads (arabic, hebrew) write no short vowels, so the detector also compares consonant skeletons.

// arabic has no p, so ba stands in for it
const ARABIC = { "ا": ["a"], "أ": ["a"], "إ": ["i", "e"], "آ": ["a"], "ٱ": ["a"], "ء": [""], "ئ": ["y", "i"], "ؤ": ["w", "o"], "ب": ["b", "p"], "پ": ["p"], "ت": ["t"], "ث": ["th"], "ج": ["j", "g"], "چ": ["ch"], "ح": ["h"], "خ": ["kh"], "د": ["d"], "ذ": ["dh", "z"], "ر": ["r"], "ز": ["z"], "ژ": ["zh"], "س": ["s"], "ش": ["sh"], "ص": ["s"], "ض": ["d"], "ط": ["t"], "ظ": ["z"], "ع": ["a", ""], "غ": ["gh", "g"], "ف": ["f"], "ڤ": ["v"], "ق": ["q", "k"], "ك": ["k"], "ک": ["k"], "گ": ["g"], "ل": ["l"], "م": ["m"], "ن": ["n"], "ه": ["h"], "ة": ["a", "h"], "و": ["w", "o", "u"], "ي": ["y", "i", "e"], "ی": ["y", "i"], "ى": ["a"], "ے": ["e"] };

const HEBREW = { "א": ["a", ""], "ב": ["b", "v"], "ג": ["g"], "ג׳": ["j"], "ג'": ["j"], "ד": ["d"], "ה": ["h", "a"], "ו": ["v", "w", "o", "u"], "וו": ["w", "v"], "ז": ["z"], "ז׳": ["zh"], "ז'": ["zh"], "ח": ["h", "ch"], "ט": ["t"], "י": ["y", "i", "e"], "יי": ["ey", "y", "ay"], "כ": ["k", "ch"], "ך": ["k", "ch"], "ל": ["l"], "מ": ["m"], "ם": ["m"], "נ": ["n"], "ן": ["n"], "ס": ["s"], "ע": ["a", ""], "פ": ["p", "f"], "ף": ["f"], "צ": ["ts"], "ץ": ["ts"], "צ׳": ["ch"], "צ'": ["ch"], "ק": ["k"], "ר": ["r"], "ש": ["sh", "s"], "ת": ["t"], "׳": [""], "'": [""] };

const CYRILLIC = { "а": ["a"], "б": ["b"], "в": ["v", "w"], "г": ["g"], "ґ": ["g"], "д": ["d"], "е": ["e", "ye"], "ё": ["yo", "e"], "є": ["ye", "e"], "ж": ["zh", "j", "g"], "з": ["z"], "и": ["i", "ee"], "і": ["i"], "ї": ["yi"], "й": ["y", "i"], "к": ["k", "c"], "л": ["l"], "м": ["m"], "н": ["n"], "о": ["o"], "п": ["p"], "р": ["r"], "с": ["s"], "т": ["t"], "у": ["u", "w", "oo"], "ў": ["w"], "ф": ["f"], "х": ["h", "kh"], "ц": ["ts"], "ч": ["ch"], "ш": ["sh"], "щ": ["sh"], "ъ": [""], "ы": ["y", "i"], "ь": [""], "э": ["e"], "ю": ["yu", "u"], "я": ["ya"],
  "дж": ["j", "g"], "кс": ["x", "ks"], "ей": ["ey", "ay"], "эй": ["ey", "ay"] };

const GREEK = { "α": ["a"], "β": ["v", "b"], "γ": ["g", "y"], "δ": ["d", "th"], "ε": ["e"], "ζ": ["z"], "η": ["i", "e"], "θ": ["th"], "ι": ["i"], "κ": ["k", "c"], "λ": ["l"], "μ": ["m"], "ν": ["n"], "ξ": ["x"], "ο": ["o"], "π": ["p"], "ρ": ["r"], "σ": ["s"], "ς": ["s"], "τ": ["t"], "υ": ["u", "y", "i"], "φ": ["f"], "χ": ["h", "ch"], "ψ": ["ps"], "ω": ["o"],
  "γου": ["w", "gu"], "ου": ["u", "w", "oo"], "μπ": ["b", "mp"], "ντ": ["d", "nt"], "γκ": ["g", "ng"], "γγ": ["ng", "g"], "τζ": ["j", "g"], "τσ": ["ts", "ch"], "αι": ["e", "ai"], "ει": ["i", "ei", "ey"], "οι": ["i", "oi"], "αυ": ["av", "au"], "ευ": ["ev", "eu"] };

const GEORGIAN = { "ა": ["a"], "ბ": ["b"], "გ": ["g"], "დ": ["d"], "ე": ["e"], "ვ": ["v", "w"], "ზ": ["z"], "თ": ["t"], "ი": ["i"], "კ": ["k"], "ლ": ["l"], "მ": ["m"], "ნ": ["n"], "ო": ["o"], "პ": ["p"], "ჟ": ["zh", "j"], "რ": ["r"], "ს": ["s"], "ტ": ["t"], "უ": ["u", "w"], "ფ": ["p", "f"], "ქ": ["k"], "ღ": ["gh", "g"], "ყ": ["q", "k"], "შ": ["sh"], "ჩ": ["ch"], "ც": ["ts"], "ძ": ["dz"], "წ": ["ts"], "ჭ": ["ch"], "ხ": ["kh", "h"], "ჯ": ["j", "g"], "ჰ": ["h"] };

const ARMENIAN = { "ա": ["a"], "բ": ["b"], "գ": ["g"], "դ": ["d"], "ե": ["e", "ye"], "զ": ["z"], "է": ["e"], "ը": ["e", ""], "թ": ["t"], "ժ": ["zh", "j"], "ի": ["i"], "լ": ["l"], "խ": ["kh", "h"], "ծ": ["ts"], "կ": ["k"], "հ": ["h"], "ձ": ["dz"], "ղ": ["gh", "g"], "ճ": ["ch"], "մ": ["m"], "յ": ["y"], "ն": ["n"], "շ": ["sh"], "ո": ["o", "vo"], "չ": ["ch"], "պ": ["p"], "ջ": ["j", "g"], "ռ": ["r"], "ս": ["s"], "վ": ["v", "w"], "տ": ["t"], "ր": ["r"], "ց": ["ts"], "ւ": ["u", "v"], "փ": ["p"], "ք": ["k"], "օ": ["o"], "ֆ": ["f"], "ու": ["u", "w", "oo"], "և": ["ev"] };

// devanagari: consonants carry an inherent "a" unless a vowel sign or virama follows
const DEVANAGARI_C = { "क": ["k"], "ख": ["kh"], "ग": ["g"], "घ": ["gh"], "ङ": ["ng"], "च": ["ch"], "छ": ["chh"], "ज": ["j", "g"], "झ": ["jh"], "ञ": ["n"], "ट": ["t"], "ठ": ["th"], "ड": ["d"], "ढ": ["dh"], "ण": ["n"], "त": ["t"], "थ": ["th"], "द": ["d"], "ध": ["dh"], "न": ["n"], "प": ["p"], "फ": ["f", "ph"], "ब": ["b"], "भ": ["bh"], "म": ["m"], "य": ["y"], "र": ["r"], "ल": ["l"], "व": ["v", "w"], "श": ["sh"], "ष": ["sh"], "स": ["s"], "ह": ["h"], "ड़": ["r"], "ढ़": ["rh"], "ज़": ["z"], "फ़": ["f"], "क़": ["q", "k"] };
const DEVANAGARI_V = { "अ": ["a"], "आ": ["a"], "इ": ["i"], "ई": ["i", "ee"], "उ": ["u"], "ऊ": ["u", "oo"], "ए": ["e"], "ऐ": ["ai", "e"], "ओ": ["o"], "औ": ["au", "o"], "ऋ": ["ri"], "ा": ["a"], "ि": ["i"], "ी": ["i", "ee"], "ु": ["u"], "ू": ["u", "oo"], "े": ["e"], "ै": ["ai", "e"], "ो": ["o"], "ौ": ["au", "o"], "ृ": ["ri"], "्": [""], "ं": ["n", "m"], "ँ": ["n"], "ः": ["h"], "़": [""] };
const DEVANAGARI_MATRA = /[\u093e-\u094d\u0962\u0963]/;

// hiragana romaji; katakana is shifted down onto it
const KANA = { "あ": ["a"], "い": ["i"], "う": ["u"], "え": ["e"], "お": ["o"], "か": ["ka"], "き": ["ki"], "く": ["ku", "k"], "け": ["ke"], "こ": ["ko"], "さ": ["sa"], "し": ["shi"], "す": ["su", "s"], "せ": ["se"], "そ": ["so"], "た": ["ta"], "ち": ["chi"], "つ": ["tsu", "ts"], "て": ["te"], "と": ["to", "t"], "な": ["na"], "に": ["ni"], "ぬ": ["nu", "n"], "ね": ["ne"], "の": ["no"], "は": ["ha"], "ひ": ["hi"], "ふ": ["fu", "f"], "へ": ["he"], "ほ": ["ho"], "ま": ["ma"], "み": ["mi"], "む": ["mu", "m"], "め": ["me"], "も": ["mo"], "や": ["ya"], "ゆ": ["yu"], "よ": ["yo"], "ら": ["ra", "la"], "り": ["ri", "li"], "る": ["ru", "lu", "r", "l"], "れ": ["re", "le"], "ろ": ["ro", "lo"], "わ": ["wa"], "ゐ": ["wi"], "ゑ": ["we"], "を": ["o", "wo"], "ん": ["n", "m"],
  "が": ["ga"], "ぎ": ["gi"], "ぐ": ["gu", "g"], "げ": ["ge"], "ご": ["go"], "ざ": ["za"], "じ": ["ji"], "ず": ["zu", "z"], "ぜ": ["ze"], "ぞ": ["zo"], "だ": ["da"], "ぢ": ["ji"], "づ": ["zu", "z"], "で": ["de"], "ど": ["do", "d"], "ば": ["ba"], "び": ["bi"], "ぶ": ["bu", "b"], "べ": ["be"], "ぼ": ["bo"], "ぱ": ["pa"], "ぴ": ["pi"], "ぷ": ["pu", "p"], "ぺ": ["pe"], "ぽ": ["po"], "ゔ": ["vu", "v"],
  "ぁ": ["a"], "ぃ": ["i"], "ぅ": ["u"], "ぇ": ["e"], "ぉ": ["o"], "ゃ": ["ya"], "ゅ": ["yu"], "ょ": ["yo"], "ゎ": ["wa"], "っ": [""], "ー": ["", "r"] }; // loanwords drop the vowel after a consonant (スト = st) and write -er as a long vowel (ー)
const SMALL_VOWEL = new Set("ぁぃぅぇぉ"), SMALL_Y = new Set("ゃゅょ");

/** @param {string} word @returns {string[][] | null} */
function kanaRomaji(word) {
  const chars = [...word.normalize("NFKC")].map((c) => { const cp = c.codePointAt(0); return cp >= 0x30a1 && cp <= 0x30f6 ? String.fromCodePoint(cp - 0x60) : c; });
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    const base = KANA[chars[i]];
    if (!base) return null;
    const next = chars[i + 1];
    if (next && SMALL_Y.has(next) && base[0].endsWith("i")) { // きゃ kya, しゃ sha, じゃ ja
      const stem = base[0].slice(0, -1);
      out.push([/[hj]$/.test(stem) ? stem + KANA[next][0].slice(1) : stem + KANA[next][0]]);
      i++;
    } else if (next && SMALL_VOWEL.has(next) && base[0] !== KANA[next][0]) { // ウェ we, ティ ti, ファ fa
      const stem = { u: "w", fu: "f", vu: "v" }[base[0]] ?? base[0].replace(/[aeiou]$/, "");
      out.push([stem + KANA[next][0]]);
      i++;
    } else out.push(base);
  }
  return out;
}

// hangul syllables decompose arithmetically into initial, medial and final jamo; 으 is the vowel loanwords insert after a consonant (스트 = st)
const H_INITIAL = [["g", "k"], ["kk"], ["n"], ["d", "t"], ["tt"], ["r", "l"], ["m"], ["b"], ["pp"], ["s"], ["ss"], [""], ["j", "g", "z"], ["jj"], ["ch"], ["k", "c"], ["t"], ["p", "f"], ["h"]];
const H_MEDIAL = [["a"], ["ae", "e"], ["ya"], ["yae"], ["eo", "o", "u"], ["e"], ["yeo"], ["ye"], ["o"], ["wa"], ["wae", "we"], ["oe", "we"], ["yo"], ["u", "oo"], ["wo"], ["we"], ["wi"], ["yu"], ["eu", "u", ""], ["ui"], ["i", "ee"]];
const H_FINAL = [[""], ["k", "g"], ["k"], ["k"], ["n"], ["n"], ["n"], ["t", "d"], ["l", "r"], ["k"], ["m"], ["p"], ["l"], ["l"], ["l"], ["l"], ["m"], ["p", "b"], ["p"], ["t", "s"], ["t"], ["ng"], ["t", "j"], ["t"], ["k"], ["t"], ["p"], ["h"]];
/** @param {string} word @returns {string[][] | null} */
function hangulRomaji(word) {
  const out = [];
  for (const c of word) {
    const idx = c.codePointAt(0) - 0xac00;
    if (idx < 0 || idx >= 11172) return null;
    out.push(H_INITIAL[Math.floor(idx / 588)], H_MEDIAL[Math.floor((idx % 588) / 28)], H_FINAL[idx % 28]);
  }
  if (out.at(-2)[0] === "eo" && out.at(-1)[0] === "") out[out.length - 2] = ["eo", "er", "o", "u"]; // loanwords write -er as 어
  return out;
}

// longest-key-first lookup through a letter map; null when a character is not in the map
/** @param {string} word @param {Record<string, string[]>} map @param {number} maxKey @returns {string[][] | null} */
function mapRomaji(word, map, maxKey) {
  const out = [];
  for (let i = 0; i < word.length; ) {
    let k = Math.min(maxKey, word.length - i);
    while (k > 0 && !map[word.slice(i, i + k)]) k--;
    if (!k) return null;
    out.push(map[word.slice(i, i + k)]);
    i += k;
  }
  return out;
}

for (const k of Object.keys(DEVANAGARI_C)) if (k.normalize("NFC") !== k) { DEVANAGARI_C[k.normalize("NFC")] = DEVANAGARI_C[k]; delete DEVANAGARI_C[k]; }
/** @param {string} word @returns {string[][] | null} */
function devanagariRomaji(word) {
  const chars = [...word.normalize("NFC")];
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    const pair = chars[i] + (chars[i + 1] || "");
    let c = DEVANAGARI_C[pair] ? (i++, pair) : chars[i];
    if (DEVANAGARI_C[c]) {
      const next = chars[i + 1];
      const bare = next !== undefined && DEVANAGARI_MATRA.test(next);
      out.push(bare || i === chars.length - 1 ? DEVANAGARI_C[c].flatMap((s) => (bare ? [s] : [s, s + "a"])) : DEVANAGARI_C[c].flatMap((s) => [s + "a", s]));
    } else if (DEVANAGARI_V[c]) out.push(DEVANAGARI_V[c]);
    else return null;
  }
  return out;
}

const SCRIPTS = [
  { re: /^[\u0600-\u06ff]+$/, abjad: true, romaji: (w) => mapRomaji(w.normalize("NFC").replace(/[\u064b-\u065f\u0670\u0640]/g, ""), ARABIC, 1) }, // harakat and tatweel dropped
  { re: /^[\u0590-\u05ff']+$/, abjad: true, romaji: (w) => mapRomaji(w.replace(/[\u0591-\u05c7]/g, ""), HEBREW, 2) }, // niqqud dropped
  { re: /^[\u0400-\u04ff]+$/, romaji: (w) => mapRomaji(w, CYRILLIC, 2) },
  { re: /^[\u0370-\u03ff\u1f00-\u1fff]+$/, romaji: (w) => mapRomaji(w.normalize("NFD").replace(/[\u0300-\u036f]/g, ""), GREEK, 3) }, // accents dropped
  { re: /^[\u10a0-\u10ff]+$/, romaji: (w) => mapRomaji(w, GEORGIAN, 1) },
  { re: /^[\u0530-\u058f]+$/, romaji: (w) => mapRomaji(w, ARMENIAN, 2) },
  { re: /^[\u0900-\u097f]+$/, romaji: devanagariRomaji },
  { re: /^[\u3040-\u30ff\uff66-\uff9f]+$/, romaji: kanaRomaji },
  { re: /^[\uac00-\ud7a3]+$/, romaji: hangulRomaji },
];
const SCRIPT_CHAR = /[\u0590-\u06ff\u0370-\u03ff\u1f00-\u1fff\u0400-\u04ff\u0530-\u058f\u10a0-\u10ff\u0900-\u097f\u3040-\u30ff\uff66-\uff9f\uac00-\ud7a3]/;

const CAP = 256;
/** @param {string[][]} options @returns {string[]} */
function expand(options) {
  let vs = [""];
  for (const o of options) {
    const next = [];
    for (const v of vs) for (const s of o) if (next.length < CAP) next.push(v + s);
    vs = next;
  }
  return [...new Set(vs.filter((v) => v.length >= 3))];
}

// every token written in one of the scripts above -> { variants, abjad }; a run of consecutive
// script tokens is also joined so letters spaced out ("و ا ي ج ر") read as one word
/** @param {string} text @returns {{variants: string[], abjad: boolean, joined: boolean}[]} */
function transliterate(text) {
  const out = [];
  const seen = new Set();
  const push = (word, script, joined = false) => {
    // bound candidate expansion for a five-letter target, including exaggerated loanword spellings.
    if (word.length > 20) return;
    if (seen.has(word)) return;
    seen.add(word);
    const options = script.romaji(word);
    const variants = options ? expand(options) : [];
    if (variants.length) out.push({ variants, abjad: Boolean(script.abjad), joined });
  };
  const tokens = String(text).toLowerCase().split(/\s+/).map((t) => t.replace(/^[^\p{L}\p{M}]+|[^\p{L}\p{M}]+$/gu, "")).filter(Boolean);
  let run = [], runScript = null;
  const flush = () => { if (run.length > 1 && run.join("").length <= 10) push(run.join(""), runScript, true); run = []; runScript = null; };
  for (const t of tokens) {
    const script = SCRIPT_CHAR.test(t) ? SCRIPTS.find((s) => s.re.test(t)) : null;
    if (!script) { flush(); continue; }
    push(t, script);
    if (script !== runScript) flush();
    run.push(t);
    runScript = script;
  }
  flush();
  return out;
}

module.exports = { transliterate };
