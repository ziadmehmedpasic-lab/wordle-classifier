require("dotenv").config();
const { Client, GatewayIntentBits, Partials, Events, PermissionsBitField, Routes } = require("discord.js");
const detector = require("./detector");
const llm = require("./llm");
const audio = require("./audio");
const gifs = require("./gifs");
const frames = require("./frames");
const { inspectMessage } = require("./inspection");
const { ocrImage } = require("./ocr");
const { SurfaceModerator } = require("./surfaces");

const env = (k, d) => (process.env[k] ?? d).toString().toLowerCase() === "true";
const TOKEN = process.env.DISCORD_TOKEN;
const CHECK_YESTERDAY = env("CHECK_YESTERDAY", "true");
const POLICE_NICKNAMES = env("POLICE_NICKNAMES", "true");
const POLICE_PROFILES = env("POLICE_PROFILES", "false");
const POLICE_PRESENCES = env("POLICE_PRESENCES", "false");
const OCR_IMAGES = env("OCR_IMAGES", "true");
const SCAN_BACKLOG = env("SCAN_BACKLOG", "true");
// repeat offenders: this many removals inside the window and the member is timed out. 0 disables
const TIMEOUT_AFTER = Number(process.env.TIMEOUT_AFTER ?? 3);
const TIMEOUT_WINDOW_MIN = Number(process.env.TIMEOUT_WINDOW_MIN ?? 10);
const TIMEOUT_MINUTES = Number(process.env.TIMEOUT_MINUTES ?? 10);
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
    sweepMembers().catch((e) => console.error("Member sweep:", e.message));
    for (const guild of client.guilds.cache.values()) surfaces.sweep(guild).catch((e) => console.error("Surface sweep:", e.message)); // names set before today's word was known
  } catch (e) { console.error("Failed to refresh Wordle answer:", e.message); }
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
    GatewayIntentBits.GuildExpressions,
    GatewayIntentBits.GuildScheduledEvents,
    GatewayIntentBits.GuildVoiceStates,
    ...(POLICE_NICKNAMES || POLICE_PROFILES ? [GatewayIntentBits.GuildMembers] : []),
    ...(POLICE_PRESENCES ? [GatewayIntentBits.GuildPresences] : []),
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const surfaces = new SurfaceModerator({
  ocrImage, profiles: POLICE_PROFILES, presences: POLICE_PRESENCES, allowedChannels: ALLOWED_CHANNEL_IDS,
  report: async ({ guild, kind, id, status }) => {
    console.warn(`Surface moderation ${guild.id}/${kind}/${id}: ${status}`);
    const channel = guild.channels.cache.get(process.env.MOD_LOG_CHANNEL_ID);
    if (channel?.isTextBased() && typeof channel.send === "function") {
      await channel.send({ content: `Wordle moderation: ${kind} ${id}: ${status.startsWith("moderation failed") ? "moderation failed; check bot logs" : status}.`, allowedMentions: { parse: [] } });
    }
  },
});

/** @param {object} target @param {string} kind @returns {Promise<void>} */
async function checkSurface(target, kind) {
  try { await refreshAnswers(); await surfaces.check(target, kind); }
  catch (error) { console.error(`Surface ${kind}:`, error.message); }
}

const canManage = (ch) => { const me = ch.guild?.members?.me; return me && ch.permissionsFor(me)?.has(PermissionsBitField.Flags.ManageMessages); };

// every removal is a strike; enough strikes inside the window and the member is timed out,
// which also stops them feeding the ocr and llm layers
const strikes = new Map();
async function strike(message) {
  if (!TIMEOUT_AFTER) return;
  const key = `${message.guildId}:${message.author.id}`;
  const now = Date.now();
  const list = (strikes.get(key) || []).filter((t) => now - t < TIMEOUT_WINDOW_MIN * 60_000);
  list.push(message.createdTimestamp || now); // posting time, so a startup backlog scan does not stack strikes
  strikes.set(key, list);
  if (list.length < TIMEOUT_AFTER) return;
  strikes.delete(key);
  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member?.moderatable) { console.warn(`Cannot time out ${message.author.tag}: needs Moderate Members and a role above theirs`); return; }
  try {
    await member.timeout(TIMEOUT_MINUTES * 60_000, `${list.length} Wordle spoilers in ${TIMEOUT_WINDOW_MIN} minutes`);
    console.log(`Timed out ${message.author.tag} for ${TIMEOUT_MINUTES} min`);
    await message.channel.send({ content: `${message.author} is timed out for ${TIMEOUT_MINUTES} minutes: ${list.length} spoilers removed in ${TIMEOUT_WINDOW_MIN} minutes.`, allowedMentions: { users: [message.author.id] } });
  } catch (e) { console.error("Timeout failed:", e.message); }
}

// tell the author, then count the strike. `what` is how the message spoiled: "contained", "gave away", "hinted at"
async function warn(message, what = "contained") {
  if (message.author?.bot) return;
  try {
    const m = await message.channel.send({ content: `${message.author}, your message was removed because it ${what} today's Wordle answer. No spoilers please!`, allowedMentions: { users: [message.author.id] } });
    setTimeout(() => m.delete().catch(() => {}), 10_000);
  } catch { /* ignore */ }
  await strike(message);
}

async function removeMessage(message, hit, how) {
  if (!canManage(message.channel)) { console.warn(`No Manage Messages permission in #${message.channel.name}`); return; }
  try {
    await message.delete();
    console.log(`Deleted spoiler (${how}) from ${message.author?.tag} in #${message.channel.name} (word: ${hit})`);
    await warn(message);
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

async function handleMessage(message, { fromBacklog = false } = {}) {
  if (!message.guild) return;
  if (message.author?.id === client.user?.id) return; // never our own warnings
  if (ALLOWED_CHANNEL_IDS.has(message.channelId)) return;
  await refreshAnswers();
  if (!detector.getAnswers().length) return;
  if (!fromBacklog) checkMember(message.member).catch((e) => console.error("Member:", e.message));

  const context = (channelHistory.get(message.channelId) || []).slice();
  const result = await inspectMessage(message, { ocrImage, context });
  if (result.issues.length) console.warn(`Incomplete inspection ${message.id}: ${result.issues.join("; ")}`);
  if (result.status === "spoiler") return removeMessage(message, result.hit, "inspection");
  if (!fromBacklog) remember(message, result.text);

  if (fromBacklog || message.author?.bot) return;
  const ids = trackFragments(message);
  if (ids.length && canManage(message.channel)) {
    try {
      await message.channel.bulkDelete(ids, true);
      console.log(`Deleted ${ids.length} fragment messages from ${message.author.tag}`);
      await warn(message);
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

// what shows next to a member's messages is the nickname, else the global display name,
// else the username. only the nickname is ours to change, so a bad global name or
// username gets a nickname set over it
async function checkMember(member) {
  if (!member) return;
  await refreshAnswers();
  await surfaces.check(member, "profile");
  if (POLICE_PRESENCES && member.presence) await surfaces.check(member.presence, "presence");
  if (!POLICE_NICKNAMES) return;
  const shown = member.displayName;
  if (!detector.scan(shown)) return;
  if (!member.manageable) { console.warn(`Cannot rename ${member.user.tag} ("${shown}"): the bot's role must be above theirs`); return; }
  const replacement = detector.scan(member.user.displayName) ? "spoiler-removed" : null;
  try {
    await member.setNickname(replacement, "Wordle spoiler");
    console.log(`Renamed member "${shown}" -> "${replacement ?? member.user.displayName}"`);
  } catch (e) { console.error("Member rename failed:", e.message); }
}

async function sweepMembers() {
  if (!POLICE_NICKNAMES && !POLICE_PROFILES && !POLICE_PRESENCES) return;
  for (const guild of client.guilds.cache.values()) {
    const members = await guild.members.fetch({ withPresences: POLICE_PRESENCES });
    for (const m of members.values()) await checkMember(m);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  llm.init();
  audio.init();
  gifs.init();
  if (OCR_IMAGES) frames.init();
  await refreshAnswers(true);
  setInterval(() => refreshAnswers(), 15 * 60 * 1000);
  scanBacklog();
});

client.on(Events.MessageCreate, (m) => handleMessage(m).catch((e) => console.error("Message:", e.message)));
client.on(Events.MessageUpdate, async (_o, u) => {
  try { await handleMessage(u.partial ? await u.fetch() : u); } catch (e) { console.error("Edit:", e.message); }
});

// Reactions spelling the answer, or custom emoji named after it
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    const msg = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    if (!msg.guild || ALLOWED_CHANNEL_IDS.has(msg.channelId) || !canManage(msg.channel)) return;
    await refreshAnswers();
    if (reaction.emoji.id) {
      const url = reaction.emoji.imageURL({ size: 256, extension: reaction.emoji.animated ? "gif" : "png" });
      const result = await inspectMessage({ channelId: msg.channelId, content: reaction.emoji.name || "", attachments: [{ url, name: "reaction emoji" }] }, { ocrImage });
      if (result.status === "spoiler") await reaction.remove();
      else if (result.issues.length) console.warn(`Incomplete reaction inspection ${msg.id}`);
    }
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

client.on(Events.GuildMemberUpdate, (_o, m) => checkMember(m).catch((e) => console.error("Member:", e.message)));
client.on(Events.GuildMemberAdd, (m) => checkMember(m).catch((e) => console.error("Member:", e.message)));
client.on(Events.UserUpdate, async (_o, u) => {
  // global display name or username changed: recheck the member in every server we share
  for (const guild of client.guilds.cache.values()) {
    try { await checkMember(await guild.members.fetch(u.id)); } catch (e) { console.error("User:", e.message); }
  }
});
for (const [create, update, kind] of [
  [Events.ThreadCreate, Events.ThreadUpdate, "channel"],
  [Events.ChannelCreate, Events.ChannelUpdate, "channel"],
  [Events.GuildRoleCreate, Events.GuildRoleUpdate, "role"],
  [Events.GuildEmojiCreate, Events.GuildEmojiUpdate, "emoji"],
  [Events.GuildStickerCreate, Events.GuildStickerUpdate, "sticker"],
  [Events.GuildScheduledEventCreate, Events.GuildScheduledEventUpdate, "event"],
  [Events.StageInstanceCreate, Events.StageInstanceUpdate, "stage"],
]) {
  client.on(create, (target) => checkSurface(target, kind));
  client.on(update, (_old, target) => checkSurface(target, kind));
}
client.on(Events.PresenceUpdate, (_old, presence) => checkSurface(presence, "presence"));
client.on(Events.Raw, (packet) => {
  if (packet.t !== "VOICE_CHANNEL_STATUS_UPDATE") return;
  const guild = client.guilds.cache.get(packet.d.guild_id);
  if (!guild) return;
  checkSurface({ id: packet.d.id, guild, topic: packet.d.status, channel: guild.channels.cache.get(packet.d.id), clear: () => client.rest.put(Routes.channelVoiceStatus(packet.d.id), { body: { status: null } }) }, "voice-status");
});
client.on(Events.Error, (e) => console.error("Client error:", e.message));

client.login(TOKEN).catch((e) => {
  if (String(e.message).includes("disallowed intents")) {
    console.error("\nDiscord rejected the bot's intents.\nFix: developer portal -> Bot -> Privileged Gateway Intents -> enable MESSAGE CONTENT INTENT; profile scans need SERVER MEMBERS INTENT; presence scans need PRESENCE INTENT" + (POLICE_NICKNAMES ? " and SERVER MEMBERS INTENT" : "") + ", then Save.\n" + (POLICE_NICKNAMES ? "Or set POLICE_NICKNAMES=false in .env.\n" : ""));
    process.exit(1);
  }
  throw e;
});
