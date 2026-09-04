if (require.main === module) require("dotenv").config();
const { Client, GatewayIntentBits, Partials, Events, PermissionsBitField, Routes } = require("discord.js");
const detector = require("./detector");
const llm = require("./llm");
const audio = require("./audio");
const gifs = require("./gifs");
const frames = require("./frames");
const { inspectMessage } = require("./inspection");
const { ocrImage } = require("./ocr");
const { SurfaceModerator } = require("./surfaces");
const { Conversation } = require("./conversation");
const { Answers } = require("./answers");
const { InspectionAlerts } = require("./alerts");
const answers = new Answers();
const inspectionAlerts = new InspectionAlerts();
const conversation = new Conversation();
const versions = new Map();

const env = (k, d) => (process.env[k] ?? d).toString().toLowerCase() === "true";
const TOKEN = process.env.DISCORD_TOKEN;
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

if (require.main === module && !TOKEN) { console.error("Missing DISCORD_TOKEN in .env"); process.exit(1); }

// ---------------------------------------------------------------------
// Daily answer from the New York Times
// ---------------------------------------------------------------------
/** @returns {boolean} */
function hasCurrentAnswers() {
  const current = answers.get();
  return current.length > 0 && current.join(",") === detector.getAnswers().join(",");
}

/** @param {boolean} force @returns {Promise<void>} */
async function refreshAnswers(force = false) {
  try { await answers.refresh({ force }); }
  catch (error) { console.error("Failed to refresh Wordle answer:", error.message); }
  const list = answers.get();
  if (list.join(",") === detector.getAnswers().join(",")) return;
  detector.setAnswers(list);
  conversation.channels.clear();
  surfaces.inFlight.clear();
  if (!list.length) { console.warn("Current Wordle answer unavailable; moderation suspended"); return; }
  console.log(`Protected answers updated for ${answers.date} (${answers.timeZone}, ${list.length} words)`);
  sweepMembers().catch((e) => console.error("Member sweep:", e.message));
  for (const guild of client.guilds.cache.values()) surfaces.sweep(guild).catch((e) => console.error("Surface sweep:", e.message));
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
  ocrImage, profiles: POLICE_PROFILES, presences: POLICE_PRESENCES, allowedChannels: ALLOWED_CHANNEL_IDS, isCurrent: hasCurrentAnswers,
  report: async ({ guild, kind, id, status, issues = [] }) => {
    console.warn(`Surface moderation ${guild.id}/${kind}/${id}: ${status}`);
    if (status === "unscanned") { reportIncomplete({ guild, id }, { status, issues }, kind); return; }
    const channel = guild.channels.cache.get(process.env.MOD_LOG_CHANNEL_ID);
    if (channel?.isTextBased() && typeof channel.send === "function") {
      await channel.send({ content: `Wordle moderation: ${kind} ${id}: ${status.startsWith("moderation failed") ? "moderation failed; check bot logs" : status}.`, allowedMentions: { parse: [] } });
    }
  },
});

/** @param {object} target @param {object} result @param {string} kind @returns {void} */
function reportIncomplete(target, result, kind = "message") {
  if (result.status !== "unscanned") return;
  inspectionAlerts.record({ guild: target.guild, id: target.id, kind, issues: result.issues });
  inspectionAlerts.flush().catch((error) => console.error("Inspection alerts:", error.message));
}

/** @param {object} target @param {string} kind @returns {Promise<void>} */
async function checkSurface(target, kind) {
  try {
    await refreshAnswers();
    if (!hasCurrentAnswers()) { reportIncomplete(target, { status: "unscanned", issues: ["current answer unavailable"] }, kind); return; }
    await surfaces.check(target, kind);
  }
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
    conversation.forget(message.channelId, message.id);
    console.log(`Deleted spoiler (${how}) from ${message.author?.tag} in #${message.channel.name} (word: ${hit})`);
    await warn(message);
  } catch (e) { console.error("Failed to delete:", e.message); }
}

async function handleMessage(message, { fromBacklog = false } = {}) {
  if (!message.guild) return;
  if (message.author?.id === client.user?.id) return; // never our own warnings
  if (ALLOWED_CHANNEL_IDS.has(message.channelId)) return;
  const version = Symbol(message.id);
  versions.set(message.id, version);
  try {
    await refreshAnswers();
    if (versions.get(message.id) !== version) return;
    if (!hasCurrentAnswers()) { reportIncomplete(message, { status: "unscanned", issues: ["current answer unavailable"] }); return; }
    const inspectedAnswers = detector.getAnswers().join(",");
    if (!fromBacklog) checkMember(message.member).catch((e) => console.error("Member:", e.message));

    conversation.remember(message, message.content || "");
    const context = conversation.get(message.channelId).filter((row) => row.id !== message.id);
    const result = await inspectMessage(message, { ocrImage, context });
    if (versions.get(message.id) !== version || !hasCurrentAnswers() || inspectedAnswers !== detector.getAnswers().join(",")) return;
    if (result.issues.length) console.warn(`Incomplete inspection ${message.id}: ${result.issues.join("; ")}`);
    reportIncomplete(message, result);
    if (result.status === "spoiler") return removeMessage(message, result.hit, "inspection");
    conversation.remember(message, result.text, result.fragmentText ?? result.text);
    const ids = conversation.fragments(message.channelId, message.id);
    if (ids.length && canManage(message.channel)) {
      try {
        await message.channel.bulkDelete(ids, true);
        for (const id of ids) { conversation.forget(message.channelId, id); versions.delete(id); }
        console.log(`Deleted ${ids.length} fragment messages from ${message.author.tag}`);
        await warn(message);
      } catch (e) { console.error("Bulk delete:", e.message); }
    }
  } finally { if (versions.get(message.id) === version) versions.delete(message.id); }
}

async function scanBacklog() {
  if (!SCAN_BACKLOG) return;
  let scanned = 0;
  for (const guild of client.guilds.cache.values()) {
    for (const ch of guild.channels.cache.values()) {
      if (!ch.isTextBased?.() || !ch.viewable || ALLOWED_CHANNEL_IDS.has(ch.id)) continue;
      try {
        const msgs = await ch.messages.fetch({ limit: 50 });
        for (const m of [...msgs.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)) { scanned++; await handleMessage(m, { fromBacklog: true }); }
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
  if (!hasCurrentAnswers()) return;
  await surfaces.check(member, "profile");
  if (POLICE_PRESENCES && member.presence) await surfaces.check(member.presence, "presence");
  if (!POLICE_NICKNAMES || !hasCurrentAnswers()) return;
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
  setInterval(() => refreshAnswers(), 60_000);
  setInterval(() => inspectionAlerts.flush().catch((error) => console.error("Inspection alerts:", error.message)), 10_000).unref();
  scanBacklog();
});

client.on(Events.MessageCreate, (m) => handleMessage(m).catch((e) => console.error("Message:", e.message)));
client.on(Events.MessageUpdate, async (_o, u) => {
  try { await handleMessage(u.partial ? await u.fetch() : u); } catch (e) { console.error("Edit:", e.message); }
});
client.on(Events.MessageDelete, (message) => {
  conversation.forget(message.channelId, message.id);
  versions.delete(message.id);
});
client.on(Events.MessageBulkDelete, (messages) => {
  for (const message of messages.values()) { conversation.forget(message.channelId, message.id); versions.delete(message.id); }
});

// Reactions spelling the answer, or custom emoji named after it
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    const msg = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    if (!msg.guild || ALLOWED_CHANNEL_IDS.has(msg.channelId) || !canManage(msg.channel)) return;
    await refreshAnswers();
    if (!hasCurrentAnswers()) return;
    const inspectedAnswers = detector.getAnswers().join(",");
    if (reaction.emoji.id) {
      const url = reaction.emoji.imageURL({ size: 256, extension: reaction.emoji.animated ? "gif" : "png" });
      const result = await inspectMessage({ channelId: msg.channelId, content: reaction.emoji.name || "", attachments: [{ url, name: "reaction emoji" }] }, { ocrImage });
      if (!hasCurrentAnswers() || inspectedAnswers !== detector.getAnswers().join(",")) return;
      if (result.status === "spoiler") await reaction.remove();
      else if (result.issues.length) {
        console.warn(`Incomplete reaction inspection ${msg.id}`);
        reportIncomplete(msg, result, "reaction");
      }
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

if (require.main === module) client.login(TOKEN).catch((e) => {
  if (String(e.message).includes("disallowed intents")) {
    console.error("\nDiscord rejected the bot's intents.\nFix: developer portal -> Bot -> Privileged Gateway Intents -> enable MESSAGE CONTENT INTENT; profile scans need SERVER MEMBERS INTENT; presence scans need PRESENCE INTENT" + (POLICE_NICKNAMES ? " and SERVER MEMBERS INTENT" : "") + ", then Save.\n" + (POLICE_NICKNAMES ? "Or set POLICE_NICKNAMES=false in .env.\n" : ""));
    process.exit(1);
  }
  throw e;
});

module.exports = { client, handleMessage, conversation, versions };
