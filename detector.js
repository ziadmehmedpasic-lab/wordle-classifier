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

function setAnswers(list) {
  targets = new Set(list.map((a) => a.toLowerCase()));
  maxLen = Math.max(...[...targets].map((t) => t.length));
  derived = [...targets].map((a) => ({
    word: a,
    exact: new Set([
      a,
      [...a].reverse().join(""),
      rot(a, 13),
      atbash(a),
      Buffer.from(a).toString("base64").replace(/=+$/, "").toLowerCase(),
      Buffer.from(a).toString("hex"),
      Buffer.from(a.toUpperCase()).toString("hex").toLowerCase(),
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
const HOMOGLYPHS = { "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ɡ": "g", "һ": "h", "к": "k", "м": "m", "т": "t", "в": "b", "н": "h", "ԛ": "q", "ԝ": "w", "г": "r", "л": "n", "п": "n", "ц": "u", "ш": "w", "ь": "b", "ъ": "b", "з": "3", "ч": "4", "α": "a", "β": "b", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w", "γ": "y", "η": "n", "μ": "u", "ℓ": "l", "ⅰ": "i", "ⅴ": "v", "ⅹ": "x" };

function mapFancyLetters(text) {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) out += String.fromCharCode(97 + cp - 0x1f1e6); // 🇦-🇿
    else if (cp >= 0x1f130 && cp <= 0x1f149) out += String.fromCharCode(97 + cp - 0x1f130); // 🄰
    else if (cp >= 0x1f150 && cp <= 0x1f169) out += String.fromCharCode(97 + cp - 0x1f150); // 🅐
    else if (cp >= 0x1f170 && cp <= 0x1f189) out += String.fromCharCode(97 + cp - 0x1f170); // 🅰
    else if (cp >= 0x1d400 && cp <= 0x1d7ff) out += String.fromCharCode(97 + (((cp - 0x1d400) % 52) % 26)); // 𝐰
    else out += SMALL_CAPS[ch] ?? HOMOGLYPHS[ch] ?? ch;
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

function normalize(text, { emojiNames = false, confusables = true } = {}) {
  let t = String(text)
    .replace(INVISIBLE, "")
    .replace(/<a?:(\w+):\d+>/g, " $1 ") // custom emoji -> name
    .replace(/<(@!?|#|@&)\d+>/g, " ") // mentions
    .replace(/<t:\d+(:\w)?>/g, " ") // timestamps
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, " $1 $2 ") // masked links [text](url)
    .replace(/```\w*\n?/g, " ") // code fence + language
    .replace(/\*\*|__|~~|\|\||`/g, "") // markdown wrappers
    .replace(/^(#{1,3}|-#)\s/gm, "") // headers / subtext
    .replace(/^>{1,3}\s?/gm, ""); // quotes
  if (emojiNames) t = expandEmojiNames(t);
  t = t.toLowerCase();
  t = mapFancyLetters(t).normalize("NFKD").replace(COMBINING, "");
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
        if (even === d.word || odd === d.word) return d.word;
      }
    }
    if (opts.ciphers && word.length === L && d.caesar.has(word)) return d.word; // any Caesar shift
    if (opts.phonetic && word.length >= L - 1 && word.length <= L + 3) {
      const codes = doubleMetaphone(word);
      if (codes.some((c) => c && d.phonetic.has(c))) return d.word;
    }
  }
  return null;
}

function tokenHit(raw) {
  // raw: trimmed token, lowercase, may contain digits/symbols
  const stripped = raw.replace(/[.\-_*'’`~^,:;"\/\\()\[\]{}<>]/g, "");
  const pieces = new Set([raw, stripped, ...raw.split(/[^a-z]+/).filter(Boolean)]);
  for (const p of pieces) {
    for (const v of visualVariants(p)) {
      const h = exactHit(v) || fuzzyHit(v) || (v !== p ? null : wildcardHit(v));
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
const LETTER_NAMES = { a: "a", ay: "a", bee: "b", be: "b", cee: "c", see: "c", dee: "d", de: "d", e: "e", ee: "e", eff: "f", ef: "f", gee: "g", aitch: "h", haitch: "h", eye: "i", i: "i", jay: "j", kay: "k", el: "l", ell: "l", em: "m", en: "n", oh: "o", o: "o", pee: "p", pe: "p", cue: "q", queue: "q", ar: "r", are: "r", ess: "s", es: "s", tee: "t", tea: "t", you: "u", u: "u", yu: "u", vee: "v", doubleu: "w", doubleyou: "w", dubya: "w", ex: "x", eks: "x", why: "y", wye: "y", zee: "z", zed: "z" };

function decodeNumbers(text) {
  const out = [];
  const groups = text.split(/[^0-9a-f%\s\-.,:;|]+/i);
  for (const g of groups) {
    const nums = g.match(/\d+/g);
    if (nums && nums.length >= 3) {
      // a=1..z=26
      if (nums.every((n) => +n >= 1 && +n <= 26)) out.push(nums.map((n) => String.fromCharCode(96 + +n)).join(""));
      // ASCII decimal
      if (nums.every((n) => +n >= 65 && +n <= 122)) out.push(nums.map((n) => String.fromCharCode(+n)).join("").toLowerCase());
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
  // Unicode escapes \u0077 or &#119;
  for (const m of text.match(/(?:\\u00[0-9a-f]{2}){3,}/gi) || []) out.push(m.split(/\\u/).filter(Boolean).map((h) => String.fromCharCode(parseInt(h, 16))).join("").toLowerCase());
  for (const m of text.match(/(?:&#\d+;){3,}/g) || []) out.push(m.match(/\d+/g).map((n) => String.fromCharCode(+n)).join("").toLowerCase());
  // Binary without separators
  for (const m of text.match(/\b[01]{24,}\b/g) || []) {
    for (const width of [8, 7]) if (m.length % width === 0) out.push(m.match(new RegExp(`.{${width}}`, "g")).map((b) => String.fromCharCode(parseInt(b, 2))).join("").toLowerCase());
  }
  // Base64 blobs (mixed case, so decode the raw text separately in containsSpoiler)
  return out.filter((s) => /^[a-z]+$/.test(s));
}

function decodeSpokenLetters(words) {
  // Runs of NATO words or letter names -> letters
  const outs = [];
  let cur = "";
  const flush = () => { if (cur.length >= 3) outs.push(cur); cur = ""; };
  for (const w of words) {
    const l = NATO[w] ?? LETTER_NAMES[w];
    if (l) cur += l; else flush();
  }
  flush();
  return outs;
}

// ---------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------
function scan(text) {
  if (!text || !derived.length) return null;
  const rawLower = String(text).toLowerCase();

  // Base64 blobs in the raw (case-sensitive) text
  for (const m of String(text).match(/[A-Za-z0-9+/]{6,}={0,2}/g) || []) {
    try {
      const dec = Buffer.from(m, "base64").toString("utf8").toLowerCase();
      if (/^[a-z\s]+$/.test(dec)) for (const w of dec.split(/\s+/)) { const h = exactHit(w); if (h) return h; }
    } catch { /* ignore */ }
  }

  const norm = normalize(text);

  // Morse
  for (const d of derived) if (norm.includes(d.morse)) return d.word;

  // Number / escape encodings
  for (const cand of decodeNumbers(norm)) { const h = exactHit(cand) || fuzzyHit(cand); if (h) return h; }

  const rawTokens = norm.split(/\s+/).filter(Boolean);
  const trimmed = rawTokens.map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")).filter(Boolean);

  // Individual tokens
  for (const t of trimmed) { const h = tokenHit(t); if (h) return h; }

  // Spoken letters (NATO / letter names)
  const letterWords = trimmed.map((t) => t.replace(/[^a-z]/g, "")).filter(Boolean);
  for (const cand of decodeSpokenLetters(letterWords)) { const h = exactHit(cand) || wildcardHit(cand); if (h) return h; }

  // Word split across tokens: "wa ger", "w a g e r", "w 8 g 3 r"
  const parts = trimmed.map((t) => t.replace(/[.\-_*'’`~^,:;"\/\\]/g, "")).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    let joined = "";
    for (let j = i; j < parts.length && j < i + 12; j++) {
      joined += parts[j];
      if (joined.length > maxLen + 3) break;
      if (j > i) {
        for (const v of visualVariants(joined)) { const h = exactHit(v); if (h) return h; }
        if (joined.length <= maxLen) { const wh = wildcardHit(joined); if (wh) return wh; }
        for (const lv of leetVariants(joined)) { const h = exactHit(lv); if (h) return h; }
      }
    }
  }

  // Acrostics: initials, or whole words + initials, skipping up to 2 fillers
  if (opts.acrostics) {
    const ws = parts.filter((p) => /^[a-z]+$/.test(p));
    const search = (i, acc, usedInitial, skips) => {
      if (acc.length > maxLen) return null;
      if (usedInitial && targets.has(acc)) return acc;
      if (i >= ws.length) return null;
      return search(i + 1, acc + ws[i][0], true, skips) || search(i + 1, acc + ws[i], usedInitial, skips) || (acc && skips > 0 ? search(i + 1, acc, usedInitial, skips - 1) : null);
    };
    for (let i = 0; i < ws.length; i++) { const h = search(i, "", false, 2); if (h) return h; }

    // Emoji-name acrostics: 🐳🍎🦒🥚🌈 -> (spouting) whale, (red) apple, giraffe, egg, rainbow -> wager
    // Each emoji offers the initial of every word in its name.
    if (Object.keys(EMOJI).length && /\p{Extended_Pictographic}/u.test(rawLower)) {
      const emojis = String(text).match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu) || [];
      const options = emojis.map((e) => {
        const name = (EMOJI[e] || EMOJI[e.replace(/\uFE0F/g, "")])?.name || "";
        return [...new Set(name.toLowerCase().split(/[^a-z]+/).filter(Boolean).map((w) => w[0]))];
      }).filter((o) => o.length);
      const dfs = (i, acc) => {
        if (acc.length > maxLen) return null;
        if (targets.has(acc)) return acc;
        if (i >= options.length) return null;
        for (const c of options[i]) { const h = dfs(i + 1, acc + c); if (h) return h; }
        return null;
      };
      for (let i = 0; i + 3 <= options.length; i++) { const h = dfs(i, ""); if (h) return h; }
    }
  }

  // Upside-down text
  const plain = normalize(text, { confusables: false });
  const flipped = unflip(plain);
  if (flipped !== plain) {
    for (const t of flipped.split(/\s+/).filter(Boolean)) { const h = exactHit(t.replace(/[^a-z]/g, "")); if (h) return h; }
  }

  return null;
}

module.exports = { scan, setAnswers, getAnswers, normalize, configure, exactHit, isWord };
