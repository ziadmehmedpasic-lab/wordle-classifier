require("dotenv").config();
const { Client, GatewayIntentBits, Partials, Events, PermissionsBitField, ChannelType } = require("discord.js");
const detector = require("./detector");
const llm = require("./llm");
const audio = require("./audio");
const gifs = require("./gifs");

const env = (k, d) => (process.env[k] ?? d).toString().toLowerCase() === "true";
const TOKEN = process.env.DISCORD_TOKEN;
const CHECK_YESTERDAY = env("CHECK_YESTERDAY", "true");
const POLICE_NICKNAMES = env("POLICE_NICKNAMES", "true");
const OCR_IMAGES = env("OCR_IMAGES", "true");
const SCAN_BACKLOG = env("SCAN_BACKLOG", "true");
const ALLOWED_CHANNEL_IDS = new Set((process.env.ALLOWED_CHANNEL_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));

detector.configure({
  suffixes: env("CATCH_SUFFIXES", "true"),
  phonetic: env("CATCH_PHONETIC", "true"),
  acrostics: env("CATCH_ACROSTICS", "true"),
  ciphers: env("CATCH_CIPHERS", "true"),
  fuzzy: env("CATCH_FUZZY", "true"),
});

if (!TOKEN) { console.error("Missing DISCORD_TOKEN in .env"); process.exit(1); }

// ---------------------------------------------------------------------
// Daily answer from the New York Times
// ---------------------------------------------------------------------
let lastFetchedDate = "";
function dateString(offset = 0) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
async function fetchAnswer(date) {
  const res = await fetch(`https://www.nytimes.com/svc/wordle/v2/${date}.json`, { headers: { "User-Agent": "Mozilla/5.0 (wordle-spoiler-bot)" } });
  if (!res.ok) throw new Error(`NYT returned ${res.status} for ${date}`);
  const data = await res.json();
  if (!data.solution) throw new Error(`No solution for ${date}`);
  return data.solution.toLowerCase();
}
async function refreshAnswers(force = false) {
  const today = dateString(0);
  if (!force && today === lastFetchedDate) return;
  try {
    const list = [await fetchAnswer(today)];
    if (CHECK_YESTERDAY) { try { list.push(await fetchAnswer(dateString(-1))); } catch (e) { console.warn("Yesterday:", e.message); } }
    try { list.push(await fetchAnswer(dateString(1))); } catch { /* not yet published */ }
    detector.setAnswers(list);
    lastFetchedDate = today;
    console.log(`[${new Date().toISOString()}] Banned words updated (${list.length} words) for ${today}`);
  } catch (e) { console.error("Failed to refresh Wordle answer:", e.message); }
}

// ---------------------------------------------------------------------
// OCR for screenshots (tesseract.js, lazy-loaded)
// ---------------------------------------------------------------------
let ocrWorker = null;
async function getOcr() {
  if (!OCR_IMAGES) return null;
  if (!ocrWorker) {
    try {
      const { createWorker } = require("tesseract.js");
      ocrWorker = await createWorker("eng");
      console.log("OCR ready");
    } catch (e) { console.error("OCR unavailable:", e.message); OCR_IMAGES_FAILED = true; return null; }
  }
  return ocrWorker;
}
let OCR_IMAGES_FAILED = false;
async function ocrImage(url) {
  if (OCR_IMAGES_FAILED) return "";
  const w = await getOcr();
  if (!w) return "";
  try {
    const { data } = await w.recognize(url);
    return data.text || "";
  } catch (e) { console.warn("OCR failed:", e.message); return ""; }
}

// ---------------------------------------------------------------------
// Collect every piece of text a message can carry
// ---------------------------------------------------------------------
function collectText(message) {
  const bits = [message.content || ""];
  for (const e of message.embeds || []) {
    bits.push(e.title, e.description, e.url, e.author?.name, e.footer?.text, e.provider?.name);
    for (const f of e.fields || []) bits.push(f.name, f.value);
  }
  for (const a of message.attachments?.values?.() || []) bits.push(a.name, a.description, a.title);
  for (const s of message.stickers?.values?.() || []) bits.push(s.name, s.description);
  if (message.poll) {
    bits.push(message.poll.question?.text);
    for (const ans of message.poll.answers?.values?.() || []) bits.push(ans.text);
  }
  for (const snap of message.messageSnapshots?.values?.() || []) bits.push(snap.content);
  for (const c of message.components || []) for (const r of c.components || []) bits.push(r.label, r.content);
  return bits.filter(Boolean).join(" \n ");
}

async function collectSlowText(message) {
  const bits = [];
  for (const a of message.attachments?.values?.() || []) {
    const type = a.contentType || "";
    if ((type.startsWith("text/") || /\.(txt|md|csv|json|log)$/i.test(a.name || "")) && a.size < 200_000) {
      try { const r = await fetch(a.url); bits.push(await r.text()); } catch { /* ignore */ }
    } else if (/^image\/(png|jpe?g|webp|bmp|gif)/.test(type) && a.size < 8_000_000) {
      bits.push(await ocrImage(a.url));
    }
  }
  for (const e of message.embeds || []) {
    const img = e.image?.url || e.thumbnail?.url;
    if (img && OCR_IMAGES) bits.push(await ocrImage(img));
  }
  return bits.filter(Boolean).join(" \n ");
}

// Voice messages, audio files and video soundtracks, as text. Link-preview videos are
// skipped: their embed url is a player page, not a media file.
async function collectTranscripts(message) {
  const bits = [];
  for (const a of message.attachments?.values?.() || []) if (audio.kind(a)) bits.push(await audio.transcribe(a));
  return bits.filter(Boolean).join(" \n ");
}

// ---------------------------------------------------------------------
// Multi-message spelling: "w" "a" "g" "e" "r" or "wa" "ger" as separate messages
// ---------------------------------------------------------------------
const recent = new Map();
const WINDOW_MS = 3 * 60 * 1000;
function trackFragments(message) {
  const text = detector.normalize(message.content || "").replace(/[^a-z0-9]/g, "");
  if (!text || text.length > 3) return [];
  const key = `${message.channelId}:${message.author.id}`;
  const now = Date.now();
  const list = (recent.get(key) || []).filter((m) => now - m.at < WINDOW_MS);
  list.push({ id: message.id, text, at: now });
  while (list.length > 12) list.shift();
  recent.set(key, list);
  const joined = list.map((m) => m.text).join("");
  if (detector.scan(joined) || detector.scan(list.map((m) => m.text).join(" "))) {
    recent.delete(key);
    return list.map((m) => m.id);
  }
  return [];
}

// ---------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    ...(POLICE_NICKNAMES ? [GatewayIntentBits.GuildMembers] : []),
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const canManage = (ch) => { const me = ch.guild?.members?.me; return me && ch.permissionsFor(me)?.has(PermissionsBitField.Flags.ManageMessages); };

async function warn(channel, user) {
  try {
    const m = await channel.send({ content: `${user}, your message was removed because it contained today's Wordle answer. No spoilers please!`, allowedMentions: { users: [user.id] } });
    setTimeout(() => m.delete().catch(() => {}), 10_000);
  } catch { /* ignore */ }
}

async function removeMessage(message, hit, how) {
  if (!canManage(message.channel)) { console.warn(`No Manage Messages permission in #${message.channel.name}`); return; }
  try {
    await message.delete();
    console.log(`Deleted spoiler (${how}) from ${message.author?.tag} in #${message.channel.name} (word: ${hit})`);
    if (!message.author?.bot) await warn(message.channel, message.author);
  } catch (e) { console.error("Failed to delete:", e.message); }
}

// Recent messages per channel, fed to the LLM as context so multi-message hints are visible
const channelHistory = new Map();
function remember(message, text) {
  const list = channelHistory.get(message.channelId) || [];
  list.push({ author: message.author?.username || "user", text: text.slice(0, 300), at: Date.now() });
  while (list.length > llm.cfg.maxContextMessages) list.shift();
  channelHistory.set(message.channelId, list);
}

async function warnHint(channel, user, verdict) {
  try {
    const what = verdict === "spoiler" ? "gave away" : "hinted at";
    const m = await channel.send({ content: `${user}, your message was removed because it ${what} today's Wordle answer. No spoilers please!`, allowedMentions: { users: [user.id] } });
    setTimeout(() => m.delete().catch(() => {}), 10_000);
  } catch { /* ignore */ }
}

async function handleMessage(message, { fromBacklog = false } = {}) {
  if (!message.guild) return;
  if (message.author?.id === client.user?.id) return; // never our own warnings
  if (ALLOWED_CHANNEL_IDS.has(message.channelId)) return;
  await refreshAnswers();
  if (!detector.getAnswers().length) return;

  const text = collectText(message);

  // Fast path: text
  const hit = detector.scan(text);
  if (hit) return removeMessage(message, hit, "text");

  // GIF links: tags and descriptions from the Tenor/Giphy APIs, before any pixels are looked at
  const gifText = await gifs.describe(text);
  if (gifText) {
    const hitGif = detector.scan(gifText);
    if (hitGif) return removeMessage(message, hitGif, "gif tags");
  }

  // Slow path: text attachments, image OCR, speech-to-text
  const imageUrls = [...(message.attachments?.values?.() || [])].filter((a) => /^image\/(png|jpe?g|webp|gif)/.test(a.contentType || "")).map((a) => a.url);
  let transcript = "";
  if (message.attachments?.size || message.embeds?.some((e) => e.image || e.thumbnail)) {
    const slow = await collectSlowText(message);
    const hit2 = detector.scan(slow);
    if (hit2) return removeMessage(message, hit2, "attachment/ocr");
    transcript = await collectTranscripts(message);
    const hit3 = detector.scan(transcript);
    if (hit3) return removeMessage(message, hit3, "audio");
  }

  // LLM layer: meaning-based hints, riddles, synonyms, translations, solved-grid screenshots, spoken hints
  if (!fromBacklog && !message.author?.bot) {
    const llmText = [text, transcript && `[voice transcript]: ${transcript}`, gifText && `[gif tags]: ${gifText}`].filter(Boolean).join("\n");
    llm.noteContext(message.channelId, llmText);
    const context = (channelHistory.get(message.channelId) || []).slice();
    remember(message, llmText);
    if (llm.shouldCheck(message.channelId, llmText, imageUrls.length > 0, Boolean(transcript))) {
      const result = await llm.classify({ text: llmText, answers: detector.getAnswers(), context, imageUrls: llm.cfg.vision ? imageUrls : [] });
      if (result) {
        const u = result.usage || {};
        console.log(`LLM verdict: ${result.verdict} (${result.confidence}) "${llmText.slice(0, 60)}" — ${result.reason} [in ${u.input_tokens ?? "?"} / cached ${u.cache_read_input_tokens ?? 0} / out ${u.output_tokens ?? "?"}]`);
        if (llm.shouldDelete(result) && canManage(message.channel)) {
          try {
            await message.delete();
            console.log(`Deleted ${result.verdict} (LLM) from ${message.author?.tag} in #${message.channel.name}`);
            await warnHint(message.channel, message.author, result.verdict);
          } catch (e) { console.error("Failed to delete:", e.message); }
          return;
        }
      }
    }
  }

  if (fromBacklog || message.author?.bot) return;
  const ids = trackFragments(message);
  if (ids.length && canManage(message.channel)) {
    try {
      await message.channel.bulkDelete(ids, true);
      console.log(`Deleted ${ids.length} fragment messages from ${message.author.tag}`);
      await warn(message.channel, message.author);
    } catch (e) { console.error("Bulk delete:", e.message); }
  }
}

async function scanBacklog() {
  if (!SCAN_BACKLOG) return;
  let scanned = 0;
  for (const guild of client.guilds.cache.values()) {
    for (const ch of guild.channels.cache.values()) {
      if (!ch.isTextBased?.() || !ch.viewable || ALLOWED_CHANNEL_IDS.has(ch.id)) continue;
      try {
        const msgs = await ch.messages.fetch({ limit: 50 });
        for (const m of msgs.values()) { scanned++; await handleMessage(m, { fromBacklog: true }); }
      } catch { /* no access */ }
    }
  }
  console.log(`Backlog scan complete (${scanned} messages)`);
}

async function checkName(target, kind) {
  await refreshAnswers();
  const name = target.name || target.nickname;
  if (!name || !detector.scan(name)) return;
  try {
    if (kind === "nickname") await target.setNickname(null, "Wordle spoiler");
    else await target.setName("spoiler-removed", "Wordle spoiler");
    console.log(`Renamed ${kind} "${name}"`);
  } catch (e) { console.error(`${kind} rename failed:`, e.message); }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  await refreshAnswers(true);
  setInterval(() => refreshAnswers(), 15 * 60 * 1000);
  llm.init();
  audio.init();
  gifs.init();
  getOcr(); // warm up in background
  scanBacklog();
});

client.on(Events.MessageCreate, (m) => handleMessage(m).catch((e) => console.error("Message:", e.message)));
client.on(Events.MessageUpdate, async (_o, u) => {
  try { await handleMessage(u.partial ? await u.fetch() : u); } catch (e) { console.error("Edit:", e.message); }
});

// Reactions spelling the answer, or custom emoji named after it
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;
    const msg = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    if (!msg.guild || ALLOWED_CHANNEL_IDS.has(msg.channelId) || !canManage(msg.channel)) return;
    await refreshAnswers();
    const letters = [];
    for (const r of msg.reactions.cache.values()) {
      const n = detector.normalize(r.emoji.name || "");
      if (/^[a-z]$/.test(n)) letters.push({ r, n });
    }
    const spelled = letters.map((l) => l.n).join("");
    if (detector.scan(spelled)) { for (const l of letters) await l.r.remove().catch(() => {}); console.log(`Removed reactions spelling the answer on ${msg.id}`); }
    if (detector.scan(reaction.emoji.name || "")) await reaction.remove().catch(() => {});
  } catch (e) { console.error("Reaction:", e.message); }
});

client.on(Events.GuildMemberUpdate, (_o, m) => POLICE_NICKNAMES && m.nickname && m.manageable && checkName(m, "nickname"));
client.on(Events.ThreadCreate, (t) => t.manageable && checkName(t, "thread"));
client.on(Events.ThreadUpdate, (_o, t) => t.manageable && checkName(t, "thread"));
client.on(Events.ChannelCreate, (ch) => ch.manageable && checkName(ch, "channel"));
client.on(Events.ChannelUpdate, (_o, ch) => ch.manageable && ch.type !== ChannelType.DM && checkName(ch, "channel"));
client.on(Events.GuildRoleCreate, (r) => r.editable && checkName(r, "role"));
client.on(Events.GuildRoleUpdate, (_o, r) => r.editable && checkName(r, "role"));
client.on(Events.GuildEmojiCreate, async (e) => { await refreshAnswers(); if (detector.scan(e.name) && e.deletable) e.delete("Wordle spoiler").catch(() => {}); });
client.on(Events.GuildStickerCreate, async (s) => { await refreshAnswers(); if (detector.scan(`${s.name} ${s.description || ""}`) && s.deletable) s.delete("Wordle spoiler").catch(() => {}); });
client.on(Events.Error, (e) => console.error("Client error:", e.message));

client.login(TOKEN).catch((e) => {
  if (String(e.message).includes("disallowed intents")) {
    console.error("\nDiscord rejected the bot's intents.\nFix: developer portal -> Bot -> Privileged Gateway Intents -> enable MESSAGE CONTENT INTENT" + (POLICE_NICKNAMES ? " and SERVER MEMBERS INTENT" : "") + ", then Save.\n" + (POLICE_NICKNAMES ? "Or set POLICE_NICKNAMES=false in .env.\n" : ""));
    process.exit(1);
  }
  throw e;
});
