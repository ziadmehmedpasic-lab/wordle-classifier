// =====================================================================
// LLM layer: judges MEANING, which pattern matching cannot.
// Catches hints, riddles, synonyms, definitions, rhymes, translations,
// letter-position clues, and screenshots of solved grids.
// Runs only after detector.js finds nothing.
// =====================================================================
const Anthropic = require("@anthropic-ai/sdk");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const prompt = readFileSync(path.join(__dirname, "prompts/moderation.md"), "utf8");

const cfg = {
  enabled: false,
  model: process.env.LLM_MODEL || "claude-opus-5",
  mode: (process.env.LLM_MODE || "suspicious").toLowerCase(), // all | suspicious | off
  hintThreshold: Number(process.env.LLM_HINT_THRESHOLD || 0.7),
  vision: (process.env.LLM_VISION || "true").toLowerCase() === "true",
  contextWindowMs: 10 * 60 * 1000, // after a Wordle mention, scan every message in that channel for this long
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
  if (channelHot.size > 1000) channelHot.delete(channelHot.keys().next().value);
}
function shouldCheck(channelId, text, hasImage, hasTranscript = false) {
  if (!cfg.enabled) return false;
  if (cfg.mode === "all") return true;
  if (hasImage || hasTranscript) return true; // extracted media must reach the meaning check
  if (SUSPICIOUS.test(text || "")) return true;
  const hot = channelHot.get(channelId);
  if (hot && Date.now() - hot < cfg.contextWindowMs) return true;
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
  return prompt.replace("{{answers}}", answers.map((answer) => answer.toUpperCase()).join(", "));
}

async function classify({ text, answers, context = [], imageUrls = [] }, judgeClient = client) {
  if (!cfg.enabled || !judgeClient) return null;
  if (imageUrls.length > 20) {
    let failed = false;
    let result = null;
    for (let start = 0; start < imageUrls.length; start += 20) {
      const batch = await classify({ text, answers, context, imageUrls: imageUrls.slice(start, start + 20) }, judgeClient);
      if (!batch) failed = true;
      else if (shouldDelete(batch)) return batch;
      else result = batch;
    }
    return failed ? null : { ...result, issues: ["vision evaluated in separate batches; cross-batch visual clues may be missed"] };
  }
  const content = [];
  if (context.length) {
    content.push({ type: "text", text: JSON.stringify({ recent_messages: context }) });
  }
  for (const url of imageUrls) {
    const data = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(url);
    const source = data ? { type: "base64", media_type: data[1], data: data[2] } : { type: "url", url };
    content.push({ type: "image", source });
  }
  content.push({ type: "text", text: JSON.stringify({ message: text || "(no text, see attached image)" }) });

  try {
    const response = await judgeClient.beta.messages.create({
      model: cfg.model,
      max_tokens: 400,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: cfg.effort, format: { type: "json_schema", schema: SCHEMA } },
      system: [{ type: "text", text: systemPrompt(answers), cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "user", content }],
    }, { timeout: 30_000, maxRetries: 0 });
    if (["refusal", "max_tokens"].includes(response.stop_reason)) return null;
    const block = response.content.find((b) => b.type === "text");
    if (!block) return null;
    const parsed = JSON.parse(block.text);
    if (!parsed || !["spoiler", "hint", "clean"].includes(parsed.verdict) || typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1 || typeof parsed.reason !== "string" || Object.keys(parsed).some((key) => !["verdict", "confidence", "reason"].includes(key))) throw new Error("invalid judge response");
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
