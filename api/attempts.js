// storage for the playground: one json record per attempt in redis, indexed by time.
// GET  -> newest attempts, up to WINDOW
// POST -> save one attempt, returns its id
// PATCH -> attach a decode note to an existing attempt
const { Redis } = require("@upstash/redis");
const crypto = require("crypto");

const WINDOW = 500;
const LIMITS = { word: 5, text: 2000, decode: 300, nickname: 24 };

function redis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("redis env vars missing: KV_REST_API_URL and KV_REST_API_TOKEN");
  return new Redis({ url, token });
}

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

function parseAttempt(body) {
  const word = typeof body.word === "string" ? body.word.toLowerCase() : "";
  const text = str(body.text, LIMITS.text);
  if (!/^[a-z]{5}$/.test(word) || !text.trim()) return null;
  return {
    word,
    text,
    intent: body.intent === "innocent" ? "innocent" : "leak",
    caught: body.caught === true,
    hit: str(body.hit, LIMITS.word),
    messages: Number.isInteger(body.messages) && body.messages >= 1 && body.messages <= 12 ? body.messages : 1,
    decode: str(body.decode, LIMITS.decode),
    nickname: str(body.nickname, LIMITS.nickname).trim(),
  };
}

async function list(db) {
  const ids = await db.zrange("attempts:byts", 0, WINDOW - 1, { rev: true });
  if (!ids.length) return [];
  const rows = await db.mget(...ids.map((id) => `attempt:${id}`));
  return rows.filter(Boolean);
}

module.exports = async (req, res) => {
  const db = redis();
  if (req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ attempts: await list(db) });
  }
  if (req.method === "POST") {
    const attempt = parseAttempt(req.body || {});
    if (!attempt) return res.status(400).json({ error: "word must be five letters and text must not be empty" });
    const id = crypto.randomUUID();
    const doc = { id, ...attempt, ts: Date.now() };
    await db.set(`attempt:${id}`, doc);
    await db.zadd("attempts:byts", { score: doc.ts, member: id });
    return res.status(201).json({ id, ts: doc.ts });
  }
  if (req.method === "PATCH") {
    const { id, decode } = req.body || {};
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return res.status(400).json({ error: "bad id" });
    const doc = await db.get(`attempt:${id}`);
    if (!doc) return res.status(404).json({ error: "no such attempt" });
    doc.decode = str(decode, LIMITS.decode).trim();
    await db.set(`attempt:${id}`, doc);
    return res.status(200).json({ ok: true });
  }
  res.setHeader("Allow", "GET, POST, PATCH");
  return res.status(405).json({ error: "method not allowed" });
};
