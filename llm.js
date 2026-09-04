// =====================================================================
// LLM layer: judges MEANING, which pattern matching cannot.
// Catches hints, riddles, synonyms, definitions, rhymes, translations,
// letter-position clues, and screenshots of solved grids.
// Runs only after detector.js finds nothing.
// =====================================================================
const Anthropic = require("@anthropic-ai/sdk");

const cfg = {
  enabled: false,
  model: process.env.LLM_MODEL || "claude-opus-5",
  mode: (process.env.LLM_MODE || "suspicious").toLowerCase(), // all | suspicious | off
  hintThreshold: Number(process.env.LLM_HINT_THRESHOLD || 0.7),
  vision: (process.env.LLM_VISION || "true").toLowerCase() === "true",
  contextWindowMs: 10 * 60 * 1000, // after a Wordle mention, scan every message in that channel for this long
  maxContextMessages: 6,
  effort: process.env.LLM_EFFORT || "low",
};

let client = null;
function init() {
  if (cfg.mode === "off") { console.log("LLM layer: off (LLM_MODE=off)"); return false; }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log("LLM layer: disabled (no ANTHROPIC_API_KEY in .env). Hints and riddles will not be caught.");
    return false;
  }
  client = new Anthropic();
  cfg.enabled = true;
  console.log(`LLM layer: on (model ${cfg.model}, mode ${cfg.mode}, hint threshold ${cfg.hintThreshold})`);
  return true;
}

// ---------------------------------------------------------------------
// Cheap gate: is this message worth an API call?
// ---------------------------------------------------------------------
const SUSPICIOUS = /\b(wordle|word of the day|today'?s word|the word|answer|solution|hint|clue|guess|rhymes?|synonym|means|meaning|definition|starts? with|ends? with|begins? with|letters?|vowels?|consonants?|first letter|last letter|spell|puzzle|streak|\d\/6|green|yellow|grey|gray)\b|[🟩🟨⬛⬜]{3,}/i;
const channelHot = new Map(); // channelId -> timestamp of last Wordle-related message

function noteContext(channelId, text) {
  if (SUSPICIOUS.test(text || "")) channelHot.set(channelId, Date.now());
}
function shouldCheck(channelId, text, hasImage) {
  if (!cfg.enabled) return false;
  if (cfg.mode === "all") return true;
  if (SUSPICIOUS.test(text || "")) return true;
  const hot = channelHot.get(channelId);
  if (hot && Date.now() - hot < cfg.contextWindowMs) return true;
  if (hasImage && hot) return true;
  return false;
}

// ---------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "reason"],
  properties: {
    verdict: { type: "string", enum: ["spoiler", "hint", "clean"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
};

function systemPrompt(answers) {
  return `You moderate a Discord server that plays the daily Wordle. Your only job is to decide whether a message gives away the Wordle answer.

The current answers (today, and yesterday/tomorrow for other timezones) are: ${answers.map((a) => a.toUpperCase()).join(", ")}.
Treat each of these as protected. Anything that lets a reader work out one of these words without playing counts.

Verdicts:
- "spoiler": the message states or unmistakably reveals a protected word. Includes the word itself in any disguise, its translation into another language, its plural or verb form, a definition that fits almost only that word, a screenshot or description of a solved grid showing the word, an anagram or cipher with the key given, or spelling the word out through initials, emoji, or a sequence of clues.
- "hint": the message narrows the answer substantially but does not fully reveal it. Includes rhymes, synonyms, "starts with W", "double letter", "it's a gambling term", letter positions, "same as yesterday's answer but one letter off", or naming a category that contains only a few five-letter words.
- "clean": normal conversation. Includes standard share grids (coloured squares with no letters), scores like 4/6, saying it was hard or easy, and discussion that does not narrow the answer. A message that uses a protected word's meaning coincidentally, with no Wordle framing and no way to infer the puzzle answer, is clean.

Be strict about spoilers and hints that reference Wordle, the puzzle, "the word", or the day's answer. Be lenient with ordinary chat that has nothing to do with the puzzle. Consider the recent messages provided as context: a sequence of innocent-looking messages can together spell or hint at the word.

Confidence is how sure you are of the verdict, from 0 to 1. Keep the reason to one sentence.`;
}

async function classify({ text, answers, context = [], imageUrls = [] }) {
  if (!cfg.enabled || !client) return null;
  const content = [];
  if (context.length) {
    content.push({ type: "text", text: "Recent messages in this channel, oldest first:\n" + context.map((c) => `- ${c.author}: ${c.text}`).join("\n") });
  }
  for (const url of imageUrls.slice(0, 3)) content.push({ type: "image", source: { type: "url", url } });
  content.push({ type: "text", text: `Message to judge:\n${text || "(no text, see attached image)"}` });

  try {
    const response = await client.beta.messages.create({
      model: cfg.model,
      max_tokens: 400,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: cfg.effort, format: { type: "json_schema", schema: SCHEMA } },
      system: [{ type: "text", text: systemPrompt(answers), cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content }],
    });
    if (response.stop_reason === "refusal") return { verdict: "clean", confidence: 0, reason: "model refused" };
    const block = response.content.find((b) => b.type === "text");
    if (!block) return null;
    const parsed = JSON.parse(block.text);
    parsed.usage = response.usage;
    return parsed;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) { console.error("LLM layer: invalid ANTHROPIC_API_KEY, disabling."); cfg.enabled = false; }
    else if (e instanceof Anthropic.RateLimitError) console.warn("LLM layer: rate limited, skipping this message.");
    else console.error("LLM layer error:", e.message);
    return null;
  }
}

// Decide whether to delete based on verdict + confidence
function shouldDelete(result) {
  if (!result) return false;
  if (result.verdict === "spoiler" && result.confidence >= 0.5) return true;
  if (result.verdict === "hint" && result.confidence >= cfg.hintThreshold) return true;
  return false;
}

module.exports = { init, cfg, noteContext, shouldCheck, classify, shouldDelete, systemPrompt, SUSPICIOUS };
