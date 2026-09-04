// =====================================================================
// Wordle spoiler detector — pure text logic, no Discord dependency.
// Every check below corresponds to a documented filter-evasion technique.
// =====================================================================
const { doubleMetaphone } = require("double-metaphone");
const ENGLISH = new Set(require("an-array-of-english-words"));

let confusablesRemove = (s) => s;
try { confusablesRemove = require("confusables").remove; } catch { /* optional */ }
let EMOJI = {};
try { EMOJI = require("unicode-emoji-json"); } catch { /* optional */ }

const opts = {
  suffixes: true,
  phonetic: true,
  acrostics: true,
  ciphers: true,
  fuzzy: true, // anagrams, 1-letter typos, vowel removal, interleaving (non-dictionary words only)
  boundary: true, // answer straddling a word boundary: "help lane" for plane
  arithmetic: true, // near-miss dictionary word plus an edit instruction: "wage but add an r"
  caesarJoin: true, // caesar shift split across tokens: "f u d q h", "xbh fs"
  fillerJoin: true, // two non-word pieces around one filler token: "cr lol ane"
  capitals: true, // capitals inside a mixed-case message: "hoWie sAid the biG onE was Right"
  streams: true, // single letters with anything between, line initials, columns and diagonals
};
function configure(o) { Object.assign(opts, o); }

// ---------------------------------------------------------------------
// Answer set + derived encodings
// ---------------------------------------------------------------------
let derived = [];
let targets = new Set(); // plain answers
let maxLen = 5;

const MORSE = { a: ".-", b: "-...", c: "-.-.", d: "-..", e: ".", f: "..-.", g: "--.", h: "....", i: "..", j: ".---", k: "-.-", l: ".-..", m: "--", n: "-.", o: "---", p: ".--.", q: "--.-", r: ".-.", s: "...", t: "-", u: "..-", v: "...-", w: ".--", x: "-..-", y: "-.--", z: "--.." };

const rot = (s, n) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + n) % 26) + 97));
const atbash = (s) => s.replace(/[a-z]/g, (c) => String.fromCharCode(219 - c.charCodeAt(0)));
const dedupe = (s) => s.replace(/([a-z])\1+/g, "$1");
const sorted = (s) => [...s].sort().join("");
const skeleton = (s) => s.replace(/[aeiou]/g, "");
const isWord = (s) => ENGLISH.has(s);
const reverse = (s) => [...s].reverse().join("");

// pig latin: leading consonant cluster moved to the end plus "ay"; vowel-initial words get way/yay/ay
function pigLatin(a) {
  const m = a.match(/^[^aeiou]+/);
  if (!m) return [a + "way", a + "yay", a + "ay"];
  return Array.from({ length: m[0].length }, (_, k) => a.slice(k + 1) + a.slice(0, k + 1) + "ay");
}
// typed one key to the left or right on a qwerty keyboard
const QWERTY = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const KEYPAD = Object.fromEntries([..."abcdefghijklmnopqrstuvwxyz"].map((c) => [c, "22233344455566677778889999"["abcdefghijklmnopqrstuvwxyz".indexOf(c)]]));
function keyboardShifts(a) {
  const out = [];
  for (const delta of [-1, 1]) {
    let s = "";
    for (const c of a) {
      const row = QWERTY.find((r) => r.includes(c));
      const i = row ? row.indexOf(c) + delta : -1;
      if (!row || i < 0 || i >= row.length) { s = null; break; }
      s += row[i];
    }
    if (s) out.push(s);
  }
  return out;
}

function setAnswers(list) {
  targets = new Set(list.map((a) => a.toLowerCase()));
  maxLen = Math.max(...[...targets].map((t) => t.length));
  derived = [...targets].map((a) => ({
    word: a,
    exact: new Set([
      a,
      reverse(a),
      rot(a, 13),
      atbash(a),
      Buffer.from(a).toString("base64").replace(/=+$/, "").toLowerCase(),
      Buffer.from(a).toString("hex"),
      Buffer.from(a.toUpperCase()).toString("hex").toLowerCase(),
      ...pigLatin(a),
      ...keyboardShifts(a),
      [...a].map((c) => KEYPAD[c]).join(""), // phone keypad digits
    ]),
    caesar: new Set(Array.from({ length: 26 }, (_, n) => rot(a, n))),
    morse: [...a].map((c) => MORSE[c]).join(" "),
    deduped: dedupe(a),
    sorted: sorted(a),
    skeleton: skeleton(a),
    phonetic: new Set(doubleMetaphone(a)),
  }));
}
function getAnswers() { return [...targets]; }

// ---------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD\u034F\u061C\u180E\u115F\u1160\u3164\uFFA0\u2800]/g; // zero-width, bidi overrides, hangul filler, braille blank
const COMBINING = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/g; // accents + zalgo

const SMALL_CAPS = { "ᴀ": "a", "ʙ": "b", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ꜰ": "f", "ɢ": "g", "ʜ": "h", "ɪ": "i", "ᴊ": "j", "ᴋ": "k", "ʟ": "l", "ᴍ": "m", "ɴ": "n", "ᴏ": "o", "ᴩ": "p", "ᴘ": "p", "ǫ": "q", "ʀ": "r", "ꜱ": "s", "ᴛ": "t", "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ʏ": "y", "ᴢ": "z" };
const UPSIDE = { "ɐ": "a", "q": "b", "ɔ": "c", "p": "d", "ǝ": "e", "ɟ": "f", "ƃ": "g", "ɥ": "h", "ᴉ": "i", "ı": "i", "ɾ": "j", "ʞ": "k", "l": "l", "ɯ": "m", "u": "n", "o": "o", "d": "p", "b": "q", "ɹ": "r", "s": "s", "ʇ": "t", "n": "u", "ʌ": "v", "ʍ": "w", "x": "x", "ʎ": "y", "z": "z" };
// glyphs used by "fancy font" generators (cjk strokes, thai-looking, ipa) that confusables does not map
const FANCY_FONTS = { "卂": "a", "乃": "b", "匚": "c", "ᗪ": "d", "乇": "e", "千": "f", "Ꮆ": "g", "卄": "h", "丨": "i", "ﾌ": "j", "Ҝ": "k", "ㄥ": "l", "爪": "m", "几": "n", "ㄖ": "o", "卩": "p", "Ɋ": "q", "尺": "r", "丂": "s", "ㄒ": "t", "ㄩ": "u", "ᐯ": "v", "山": "w", "乂": "x", "ㄚ": "y", "乙": "z",
  "ค": "a", "๒": "b", "ς": "c", "๔": "d", "є": "e", "Ŧ": "f", "ﻮ": "g", "ђ": "h", "เ": "i", "ן": "j", "๓": "m", "ภ": "n", "๏": "o", "թ": "p", "ợ": "q", "я": "r", "ร": "s", "Շ": "t", "ย": "u", "ש": "v", "ฬ": "w", "א": "x", "ץ": "y", "չ": "z",
  "ꮆ": "g", // lowercase form of Ꮆ, since the text is lowercased first
  "ʍ": "w", "ɑ": "a", "ɠ": "g", "ɛ": "e", "ɽ": "r", "ʀ": "r", "ɪ": "i", "ʊ": "u", "ʃ": "s", "ʒ": "z", "ŋ": "n", "ð": "d", "θ": "t", "ß": "ss" }; // no ɔ: it is upside-down c
const BRAILLE = Object.fromEntries("⠁⠃⠉⠙⠑⠋⠛⠓⠊⠚⠅⠇⠍⠝⠕⠏⠟⠗⠎⠞⠥⠧⠺⠭⠽⠵".split("").map((c, i) => [c, String.fromCharCode(97 + i)]));
const HOMOGLYPHS = { "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ɡ": "g", "һ": "h", "к": "k", "м": "m", "т": "t", "в": "b", "н": "h", "ԛ": "q", "ԝ": "w", "г": "r", "л": "n", "п": "n", "ц": "u", "ш": "w", "ь": "b", "ъ": "b", "з": "3", "ч": "4", "α": "a", "β": "b", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w", "γ": "y", "η": "n", "μ": "u", "ℓ": "l", "ⅰ": "i", "ⅴ": "v", "ⅹ": "x" };

function mapFancyLetters(text) {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) out += String.fromCharCode(97 + cp - 0x1f1e6); // 🇦-🇿
    else if (cp >= 0x1f130 && cp <= 0x1f149) out += String.fromCharCode(97 + cp - 0x1f130); // 🄰
    else if (cp >= 0x1f150 && cp <= 0x1f169) out += String.fromCharCode(97 + cp - 0x1f150); // 🅐
    else if (cp >= 0x1f170 && cp <= 0x1f189) out += String.fromCharCode(97 + cp - 0x1f170); // 🅰
    else if (cp >= 0x1d400 && cp <= 0x1d7cb) out += String.fromCharCode(97 + (((cp - 0x1d400) % 52) % 26)); // 𝐰 (bold digits 1d7ce+ are left to NFKD)
    else out += SMALL_CAPS[ch] ?? HOMOGLYPHS[ch] ?? BRAILLE[ch] ?? FANCY_FONTS[ch] ?? ch;
  }
  return out;
}

// Emoji -> " name " so 🐳 becomes "spouting whale" (used for emoji-name acrostics)
function expandEmojiNames(text) {
  if (!Object.keys(EMOJI).length) return text;
  return text.replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, (m) => {
    const e = EMOJI[m] || EMOJI[m.replace(/\uFE0F/g, "")];
    return e?.name ? ` ${e.name} ` : m;
  });
}

const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu;
const HAS_EMOJI = new RegExp(EMOJI_RE.source, "u");
// custom emoji whose name is a single letter with a prefix or suffix: <:letter_l:1>, <:blue_c:2>
const LETTER_EMOJI = /<a?:(?:[a-z0-9]+_)?([a-z])(?:_[a-z0-9]+)?:\d+>/gi;

function normalize(text, { emojiNames = false, confusables = true } = {}) {
  let t = String(text)
    .replace(INVISIBLE, "")
    .replace(/:regional_indicator_([a-z]):/gi, " $1 ") // shortcode shown literally
    .replace(LETTER_EMOJI, " $1 ")
    .replace(/<a?:(\w+):\d+>/g, " $1 ") // custom emoji -> name
    .replace(/<(@!?|#|@&)\d+>/g, " ") // mentions
    .replace(/<t:\d+(:\w)?>/g, " ") // timestamps
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, " $1 $2 ") // masked links [text](url)
    .replace(/```/g, " ") // code fences; a language tag just becomes a token
    .replace(/\*\*|__|~~|\|\||`/g, "") // markdown wrappers
    .replace(/^(#{1,3}|-#)\s/gm, "") // headers / subtext
    .replace(/^>{1,3}\s?/gm, "") // quotes
    .replace(/^\s*(?:[-*+•]|\d{1,2}[.)])\s+/gm, ""); // list markers
  if (emojiNames) t = expandEmojiNames(t);
  t = t.toLowerCase();
  t = mapFancyLetters(t).replace(EMOJI_RE, " ").normalize("NFKD").replace(COMBINING, "");
  if (confusables) t = confusablesRemove(t).toLowerCase();
  return mapFancyLetters(t);
}

// Upside-down text: flip characters and reverse
function unflip(text) {
  return [...text].reverse().map((c) => UPSIDE[c] ?? c).join("");
}

// ---------------------------------------------------------------------
// Candidate matching
// ---------------------------------------------------------------------
const SUFFIXES = ["s", "es", "ed", "d", "ing", "er", "ers", "ly", "y", "ier", "iest", "est", "ish", "ness", "ful", "less"];

function exactHit(word) {
  if (!word) return null;
  for (const d of derived) {
    if (d.exact.has(word)) return d.word;
    if (opts.suffixes && word.length > d.word.length) {
      if (word.startsWith(d.word) && SUFFIXES.includes(word.slice(d.word.length))) return d.word;
      if (d.word.endsWith("e") && word.startsWith(d.word.slice(0, -1)) && ["ing", "ed", "er", "ers"].includes(word.slice(d.word.length - 1))) return d.word;
      if (d.word.endsWith("y") && word.startsWith(d.word.slice(0, -1)) && ["ies", "ied", "ier", "iest"].includes(word.slice(d.word.length - 1))) return d.word;
    }
  }
  return null;
}

// Letters must match; digits/symbols are wildcards; need >= 3 real letters
function wildcardMatch(cand, answer) {
  if (cand.length !== answer.length) return false;
  let letters = 0;
  for (let i = 0; i < answer.length; i++) {
    const c = cand[i];
    if (/[a-z]/.test(c)) { if (c !== answer[i]) return false; letters++; }
  }
  return letters >= 3;
}
function wildcardHit(tok) {
  for (const d of derived) if (wildcardMatch(tok, d.word)) return d.word;
  return null;
}

const LEET = { "0": "o", "1": "il", "2": "z", "3": "e", "4": "a", "5": "s", "6": "g", "7": "t", "8": "b", "9": "g", "@": "a", "$": "s", "!": "i", "|": "l", "+": "t", "(": "c", "€": "e", "£": "l", "¢": "c" };
function leetVariants(tok) {
  if (!/[0-9@$!|+(€£¢]/.test(tok) || !/[a-z]/.test(tok)) return [];
  let vs = [""];
  for (const ch of tok) {
    const o = LEET[ch] ?? ch;
    const next = [];
    for (const v of vs) for (const c of o) next.push(v + c);
    vs = next;
    if (vs.length > 64) return [];
  }
  return vs.filter((v) => /^[a-z]+$/.test(v));
}

function visualVariants(w) {
  const v = w.replace(/vv/g, "w").replace(/rn/g, "m").replace(/cl/g, "d").replace(/lj/g, "y").replace(/nn/g, "m");
  return v === w ? [w] : [w, v];
}

function damerau1(a, b) {
  // true if edit distance (with transposition) <= 1
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    const diff = [];
    for (let i = 0; i < la; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 1) return true;
    if (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]) return true;
    return false;
  }
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0, j = 0, skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; }
    else if (skipped) return false;
    else { skipped = true; j++; }
  }
  return true;
}

// Non-dictionary tokens only: sounds like, anagram, one typo, vowel removal, doubled letters, ciphers
function fuzzyHit(word) {
  if (!/^[a-z]+$/.test(word) || word.length < 3 || word.length > 12) return null;
  if (isWord(word)) return null;
  for (const d of derived) {
    const L = d.word.length;
    if (opts.fuzzy) {
      if (word.length === L && sorted(word) === d.sorted) return d.word; // anagram
      if (damerau1(word, d.word)) return d.word; // one typo / transposition / missing / extra letter
      if (dedupe(word) === d.deduped) return d.word; // wwaaggeerr, waager
      if (word.length >= 3 && word.length <= L && skeleton(word) === d.skeleton && d.skeleton.length >= 3 && word === d.skeleton) return d.word; // wgr
      if (word.length >= 2 * L - 1 && word.length <= 2 * L + 1) {
        // interleaved with noise: wxaxgxexr / wtaogdear
        const even = [...word].filter((_, i) => i % 2 === 0).join("");
        const odd = [...word].filter((_, i) => i % 2 === 1).join("");
        if (exactHit(even) === d.word || exactHit(odd) === d.word) return d.word;
      }
    }
    if (opts.ciphers && word.length === L && d.caesar.has(word)) return d.word; // any Caesar shift
  }
  return phoneticHit(word);
}

function phoneticHit(word) {
  if (!opts.phonetic) return null;
  const codes = doubleMetaphone(word);
  for (const d of derived) {
    if (word.length < d.word.length - 1 || word.length > d.word.length + 3) continue;
    if (codes.some((c) => c && d.phonetic.has(c))) return d.word;
  }
  return null;
}

// rfc 4648 base32 without padding checks
function base32(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.replace(/=+$/, "")) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  let out = "";
  for (let i = 0; i + 8 <= bits.length; i += 8) out += String.fromCharCode(parseInt(bits.slice(i, i + 8), 2));
  return out;
}

// the answer inside a longer token that is not itself a dictionary word: wagerbros, itscrane, xxlightxx
function substringHit(word) {
  if (!/^[a-z]+$/.test(word) || isWord(word)) return null;
  for (const d of derived) if (word.length > d.word.length && word.includes(d.word)) return d.word;
  return null;
}

function tokenHit(raw) {
  // raw: trimmed token, lowercase, may contain digits/symbols
  const stripped = raw.replace(/[^a-z0-9]/g, "");
  const pieces = new Set([raw, stripped, ...raw.split(/[^a-z]+/).filter(Boolean)]);
  for (const p of pieces) {
    for (const v of visualVariants(p)) {
      const h = exactHit(v) || exactHit(reverse(v)) || fuzzyHit(v) || substringHit(v) || (v !== p ? null : wildcardHit(v));
      if (h) return h;
      if (v.length === stripped.length || v === raw) { const wh = wildcardHit(v); if (wh) return wh; }
      for (const lv of leetVariants(v)) { const h2 = exactHit(lv) || fuzzyHit(lv); if (h2) return h2; }
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Sequence decoders: numbers, NATO, letter names, morse, acrostics
// ---------------------------------------------------------------------
const NATO = { alfa: "a", alpha: "a", bravo: "b", charlie: "c", delta: "d", echo: "e", foxtrot: "f", golf: "g", hotel: "h", india: "i", juliet: "j", juliett: "j", kilo: "k", lima: "l", mike: "m", november: "n", oscar: "o", papa: "p", quebec: "q", romeo: "r", sierra: "s", tango: "t", uniform: "u", victor: "v", whiskey: "w", whisky: "w", xray: "x", yankee: "y", zulu: "z" };
const LETTER_NAMES = { a: "a", ay: "a", bee: "b", be: "b", cee: "c", see: "c", dee: "d", de: "d", e: "e", ee: "e", eff: "f", ef: "f", gee: "g", aitch: "h", haitch: "h", aych: "h", eye: "i", i: "i", jay: "j", kay: "k", el: "l", ell: "l", em: "m", en: "n", oh: "o", o: "o", pee: "p", pe: "p", cue: "q", queue: "q", ar: "r", are: "r", arr: "r", ess: "s", es: "s", tee: "t", tea: "t", you: "u", u: "u", yu: "u", yoo: "u", vee: "v", doubleu: "w", doubleyou: "w", dubya: "w", dubs: "w", ex: "x", eks: "x", why: "y", wye: "y", zee: "z", zed: "z",
  // spanish and german letter names
  ce: "c", efe: "f", ge: "g", hache: "h", jota: "j", ka: "k", ele: "l", eme: "m", ene: "n", cu: "q", erre: "r", ese: "s", te: "t", uve: "v", equis: "x", zeta: "z",
  ah: "a", beh: "b", tseh: "c", deh: "d", eh: "e", geh: "g", hah: "h", ih: "i", yot: "j", kah: "k", emm: "m", enn: "n", peh: "p", kuh: "q", err: "r", teh: "t", uh: "u", fau: "v", veh: "w", weh: "w", iks: "x", ypsilon: "y", tsett: "z" };

const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
// "twenty three one seven five eighteen" -> "23 1 7 5 18"; null when fewer than three number words
function numberWordsToDigits(text) {
  const words = text.split(/[\s,]+/);
  const out = [];
  let count = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w in TENS) {
      const next = UNITS[words[i + 1]];
      if (next !== undefined && next < 10) { out.push(String(TENS[w] + next)); i++; } else out.push(String(TENS[w]));
      count++;
    } else if (w in UNITS) { out.push(String(UNITS[w])); count++; } else out.push(w);
  }
  return count >= 3 ? out.join(" ") : null;
}

function decodeNumbers(text) {
  const out = [];
  const groups = text.replace(/(\d)(?:st|nd|rd|th)\b/g, "$1").split(/[^0-9a-f%\s\-.,:;|\/+_#]+/i);
  for (const g of groups) {
    const nums = g.match(/\d+/g);
    if (nums && nums.length >= 3) {
      // a=1..z=26, ignoring zeros and tolerating up to two other filler numbers; and a=0..z=25
      const nonZero = nums.filter((n) => +n !== 0);
      const inRange = nonZero.filter((n) => +n >= 1 && +n <= 26);
      if (inRange.length >= 3 && nonZero.length - inRange.length <= 2) out.push(inRange.map((n) => String.fromCharCode(96 + +n)).join(""));
      if (nums.every((n) => +n >= 0 && +n <= 25)) out.push(nums.map((n) => String.fromCharCode(97 + +n)).join(""));
      // ASCII decimal and octal
      if (nums.every((n) => +n >= 65 && +n <= 122)) out.push(nums.map((n) => String.fromCharCode(+n)).join("").toLowerCase());
      if (nums.every((n) => /^1[0-7][0-7]$/.test(n))) out.push(nums.map((n) => String.fromCharCode(parseInt(n, 8))).join("").toLowerCase());
      // binary bytes
      if (nums.every((n) => /^[01]{7,8}$/.test(n))) out.push(nums.map((n) => String.fromCharCode(parseInt(n, 2))).join("").toLowerCase());
    }
    // hex bytes "77 61 67 65 72" / "0x77"
    const hexes = g.match(/\b(?:0x)?[0-9a-f]{2}\b/gi);
    if (hexes && hexes.length >= 3) out.push(hexes.map((h) => String.fromCharCode(parseInt(h.replace(/^0x/i, ""), 16))).join("").toLowerCase());
  }
  // URL-encoded %77%61%67%65%72
  for (const m of text.match(/(?:%[0-9a-f]{2}){3,}/gi) || []) {
    try { out.push(decodeURIComponent(m).toLowerCase()); } catch { /* ignore */ }
  }
  // code point escapes, with or without spaces between: \u0077 \x77 U+0077 %u0077 &#119; &#x77; and 0x + a whole hex string
  const fromHex = (m, re) => (m.match(re) || []).map((h) => String.fromCharCode(parseInt(h, 16))).join("").toLowerCase();
  for (const m of text.match(/(?:\\u[0-9a-f]{4}\s*){3,}/gi) || []) out.push(fromHex(m, /(?<=\\u)[0-9a-f]{4}/gi));
  for (const m of text.match(/(?:\\x[0-9a-f]{2}\s*){3,}/gi) || []) out.push(fromHex(m, /(?<=\\x)[0-9a-f]{2}/gi));
  for (const m of text.match(/(?:u\+[0-9a-f]{4}\s*){3,}/gi) || []) out.push(fromHex(m, /(?<=u\+)[0-9a-f]{4}/gi));
  for (const m of text.match(/(?:%u[0-9a-f]{4}\s*){3,}/gi) || []) out.push(fromHex(m, /(?<=%u)[0-9a-f]{4}/gi));
  for (const m of text.match(/(?:&#x[0-9a-f]+;?\s*){3,}/gi) || []) out.push(fromHex(m, /(?<=&#x)[0-9a-f]+/gi));
  for (const m of text.match(/(?:&#\d+;?\s*){3,}/g) || []) out.push(m.match(/\d+/g).map((n) => String.fromCharCode(+n)).join("").toLowerCase());
  for (const m of text.match(/\b0x((?:[0-9a-f]{2}){3,})\b/gi) || []) out.push(Buffer.from(m.slice(2), "hex").toString("latin1").toLowerCase());
  // Binary without separators
  for (const m of text.match(/\b[01]{24,}\b/g) || []) {
    for (const width of [8, 7]) if (m.length % width === 0) out.push(m.match(new RegExp(`.{${width}}`, "g")).map((b) => String.fromCharCode(parseInt(b, 2))).join("").toLowerCase());
  }
  // decoded strings may carry spaces or punctuation ("w a g e r", "wager!"); the caller rescans them
  return out.map((s) => s.replace(/[^a-z\s]/g, " ").trim()).filter((s) => /[a-z]{3}/.test(s.replace(/\s/g, "")));
}

function decodeSpokenLetters(words) {
  // Runs of NATO words or letter names -> letters; "double u" / "double you" is one letter
  const outs = [];
  let cur = "";
  const flush = () => { if (cur.length >= 3) outs.push(cur); cur = ""; };
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    if (["double", "doble"].includes(w) && ["u", "you", "yu", "ve"].includes(words[i + 1])) { w = "doubleu"; i++; }
    const l = NATO[w] ?? LETTER_NAMES[w];
    if (l) cur += l; else flush();
  }
  flush();
  return outs;
}

// morse written with unicode dots and dashes, letters split by , / | or double spaces, or spoken dit/dah
function morseForms(text) {
  let t = text.replace(/[·•∙⋅]/g, ".").replace(/[−–—_]/g, "-");
  if ((t.match(/\b(?:dit|dah|di|da)\b/g) || []).length >= 3) t = t.replace(/\b(?:dit|di)\b/g, ".").replace(/\b(?:dah|da)\b/g, "-");
  const forms = [t];
  for (const run of t.match(/[.\-\s,/|]{5,}/g) || []) {
    if (!/[.-]{1}[\s,/|]+[.-]/.test(run) || (run.match(/[.-]/g) || []).length < 5) continue;
    const letters = run.split(/\s*[,/|]\s*|\s{2,}/).map((l) => l.replace(/\s+/g, "")).filter(Boolean);
    forms.push(letters.join(" "));
  }
  return forms;
}

// single letters with anything between them: "w then a then g then e then r", "l1 i2 g3 h4 t5", "w for whiskey a for apple"
function letterStream(tokens) {
  let s = "";
  for (const t of tokens) {
    const m = t.match(/^(?:[a-z]|[a-z]\d{1,2}|\d{1,2}[a-z])$/);
    if (m) s += t.replace(/\d/g, "");
  }
  return s;
}

// capital letters inside a mixed-case message read in order: "hoWie sAid the biG onE was Right", "#WeAllGetEmRight"
function capitalStreams(text) {
  const t = String(text).replace(/https?:\/\/\S+/g, " ");
  if ((t.match(/[a-z]/g) || []).length < 3) return [];
  const caps = (t.match(/[A-Z]/g) || []).join("").toLowerCase();
  if (caps.length < 3 || caps.length > 12) return [];
  const noSentenceStart = (t.replace(/(^|[.!?]\s+)[A-Z]/g, "$1").match(/[A-Z]/g) || []).join("").toLowerCase();
  const noI = (t.replace(/\bI\b/g, "").match(/[A-Z]/g) || []).join("").toLowerCase();
  return [...new Set([caps, noSentenceStart, noI])];
}

// answer read down a column or diagonal of a multi-line block
function gridStreams(lines) {
  if (lines.length < 3) return [];
  const rows = lines.map((l) => l.replace(/\s+/g, ""));
  const width = Math.max(...rows.map((r) => r.length));
  const out = [];
  for (let j = 0; j < width; j++) out.push(rows.map((r) => r[j] || "").join(""));
  out.push(rows.map((r, i) => r[i] || "").join(""));
  out.push(rows.map((r, i) => r[r.length - 1 - i] || "").join(""));
  return out.filter((s) => s.length >= 3);
}

// exact answer, reversed, or contained in a short stream of letters
function streamHit(s) {
  if (!s || s.length < 3) return null;
  const h = exactHit(s);
  if (h) return h;
  if (s.length <= 12) for (const d of derived) if (s.includes(d.word) || s.includes(reverse(d.word))) return d.word;
  return null;
}

// ---------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------
const INSTRUCTION = /\b(?:add|drop|remove|without|minus|plus|swap|switch|replace|instead|change|delete|lose|take (?:off|away|out))\b/;

function scan(text, depth = 0) {
  if (!text || !derived.length) return null;
  const raw = String(text);

  // base64 / base32 blobs in the raw (case-sensitive) text; the decoded text is rescanned once
  if (depth === 0) {
    const blobs = [];
    for (const m of raw.match(/[A-Za-z0-9+/]{6,}={0,2}/g) || []) blobs.push(Buffer.from(m, "base64").toString("utf8"));
    for (const m of raw.match(/\b[A-Z2-7]{8,}=*\b/g) || []) blobs.push(base32(m));
    for (const dec of blobs) if (/^[\x20-\x7e\s]+$/.test(dec)) { const h = scan(dec, 1); if (h) return h; }
  }

  const norm = normalize(text);
  const lines = norm.split("\n").map((l) => l.trim()).filter(Boolean);

  // Morse; also on the raw text, since markdown stripping eats "__" in underscore morse
  for (const form of [...morseForms(norm), ...morseForms(raw.toLowerCase())]) for (const d of derived) if (form.includes(d.morse)) return d.word;

  // Number / escape encodings; decoded strings ("wager", "w a g e r") are rescanned once
  const spelled = numberWordsToDigits(norm);
  for (const cand of [...decodeNumbers(norm), ...(spelled ? decodeNumbers(spelled) : [])]) {
    const h = depth < 2 ? scan(cand, depth + 1) : exactHit(cand);
    if (h) return h;
  }

  const trimmed = norm.split(/\s+/).filter(Boolean).map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")).filter(Boolean);

  // Individual tokens
  for (const t of trimmed) { const h = tokenHit(t); if (h) return h; }

  // Spoken letters (NATO / letter names)
  const words = trimmed.map((t) => t.replace(/[^a-z]/g, "")).filter(Boolean);
  for (const cand of decodeSpokenLetters(words)) { const h = exactHit(cand) || wildcardHit(cand); if (h) return h; }

  // Word split across tokens: "wa ger", "w a g e r", "w 8 g 3 r", "f u d q h" (caesar)
  const parts = trimmed.map((t) => t.replace(/[^a-z0-9@$!|+(€£¢]/g, "")).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    let joined = "";
    for (let j = i; j < parts.length && j < i + 12; j++) {
      joined += parts[j];
      if (joined.length > maxLen + 3) break;
      if (j === i) continue;
      for (const v of visualVariants(joined)) { const h = exactHit(v); if (h) return h; }
      if (joined.length <= maxLen) { const wh = wildcardHit(joined); if (wh) return wh; }
      for (const lv of leetVariants(joined)) { const h = exactHit(lv); if (h) return h; }
      // no sounds-like check here: "is it" sounds like arise, "so tight i" like essay
      if (opts.caesarJoin && parts.slice(i, j + 1).every((p) => p.length <= 2 || !isWord(p))) for (const d of derived) if (joined.length === d.word.length && d.caesar.has(joined)) return d.word;
    }
  }
  // Two non-word pieces around one filler token: "cr lol ane"
  if (opts.fillerJoin) {
    for (let i = 0; i + 2 < parts.length; i++) {
      const a = parts[i], b = parts[i + 2];
      if (!/^[a-z]+$/.test(a + b) || isWord(a) || isWord(b) || a.length + b.length > maxLen) continue;
      const h = exactHit(a + b);
      if (h) return h;
    }
  }

  if (opts.streams) {
    // Single letters with anything between them: "w then a then g then e then r", "l1 i2 g3 h4 t5", "w-a-g-e-and-then-r"
    const stream = letterStream(norm.split(/[\s\-]+/).map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")).filter(Boolean));
    const h = streamHit(stream) || fuzzyHit(stream);
    if (h) return h;
    // First letters of lines, columns and diagonals of a block
    if (lines.length >= 3) { const h = streamHit(lines.map((l) => (l.match(/[a-z]/) || [""])[0]).join("")); if (h) return h; }
    for (const s of gridStreams(lines)) { const h = streamHit(s.replace(/[^a-z]/g, "")); if (h) return h; }
  }
  // Capitals inside a mixed-case message
  if (opts.capitals) for (const s of capitalStreams(raw)) { const h = streamHit(s); if (h) return h; }

  // The answer straddling a word boundary: "help lane" for plane, "saw a german" for wager
  if (opts.boundary) {
    let flat = "";
    const bounds = [];
    for (const w of words) { flat += w; bounds.push(flat.length); }
    for (const d of derived) {
      for (let k = flat.indexOf(d.word); k >= 0; k = flat.indexOf(d.word, k + 1)) {
        if (bounds.some((b) => b > k && b < k + d.word.length)) return d.word;
      }
    }
  }

  // A near-miss dictionary word plus an instruction naming a letter: "its wage but add an r", "planet without the t"
  if (opts.arithmetic && INSTRUCTION.test(norm) && /(?<!['’])\b(?:[b-hj-z]|letter)\b/.test(norm)) {
    for (const w of words) if (w.length >= 4 && isWord(w)) for (const d of derived) if (w !== d.word && damerau1(w, d.word)) return d.word;
  }

  // Acrostics: initials, or whole words + initials, skipping up to 2 fillers; also reversed initials with no skips
  if (opts.acrostics) {
    const wordLists = [parts.filter((p) => /^[a-z]+$/.test(p))];
    if (HAS_EMOJI.test(raw)) wordLists.push(normalize(text, { emojiNames: true }).split(/\s+/).filter((p) => /^[a-z]+$/.test(p)));
    for (const ws of wordLists) {
      const search = (i, acc, usedInitial, skips) => {
        if (acc.length > maxLen) return null;
        if (usedInitial && targets.has(acc)) return acc;
        if (i >= ws.length) return null;
        return search(i + 1, acc + ws[i][0], true, skips) || search(i + 1, acc + ws[i], usedInitial, skips) || (acc && skips > 0 ? search(i + 1, acc, usedInitial, skips - 1) : null);
      };
      for (let i = 0; i < ws.length; i++) { const h = search(i, "", false, 2); if (h) return h; }
      const initials = ws.map((w) => w[0]).join("");
      for (const d of derived) if (initials.includes(reverse(d.word))) return d.word;
    }

    // Emoji-name acrostics: 🐳🍎🦒🥚🌈 -> (spouting) whale, (red) apple, giraffe, egg, rainbow -> wager
    // Each emoji offers the initial of every word in its name; one distractor emoji may be skipped.
    if (Object.keys(EMOJI).length && HAS_EMOJI.test(raw)) {
      const emojis = raw.match(EMOJI_RE) || [];
      const options = emojis.map((e) => {
        const name = (EMOJI[e] || EMOJI[e.replace(/️/g, "")])?.name || "";
        return [...new Set(name.toLowerCase().split(/[^a-z]+/).filter(Boolean).map((w) => w[0]))];
      }).filter((o) => o.length);
      const dfs = (i, acc, skips) => {
        if (acc.length > maxLen) return null;
        if (targets.has(acc)) return acc;
        if (i >= options.length) return null;
        for (const c of options[i]) { const h = dfs(i + 1, acc + c, skips); if (h) return h; }
        return acc && skips > 0 ? dfs(i + 1, acc, skips - 1) : null;
      };
      for (let i = 0; i + 3 <= options.length; i++) { const h = dfs(i, "", 1); if (h) return h; }
    }
  }

  // Upside-down text, whole or one letter per token
  const plain = normalize(text, { confusables: false });
  const flipped = unflip(plain);
  if (flipped !== plain) {
    const toks = flipped.split(/\s+/).filter(Boolean);
    for (const t of toks) { const h = exactHit(t.replace(/[^a-z]/g, "")); if (h) return h; }
    const h = streamHit(letterStream(toks));
    if (h) return h;
  }

  return null;
}

module.exports = { scan, setAnswers, getAnswers, normalize, configure, exactHit, isWord };
