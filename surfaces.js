const { createHash } = require("node:crypto");
const { PermissionsBitField } = require("discord.js");
const detector = require("./detector");
const { inspectMessage } = require("./inspection");

/** @param {object} presence @returns {string} */
function presenceText(presence) {
  return (presence?.activities || []).flatMap((activity) => [activity.name, activity.state, activity.details, activity.emoji?.name, activity.assets?.largeText, activity.assets?.smallText]).filter(Boolean).join("\n");
}

/** @param {object} member @returns {object[]} */
function profileAssets(member) {
  const urls = [member.displayAvatarURL?.({ size: 1024 }), member.bannerURL?.({ size: 1024 }), member.user?.avatarURL?.({ size: 1024 }), member.user?.bannerURL?.({ size: 1024 })];
  return [...new Set(urls.filter(Boolean))].map((url) => ({ url, name: "profile image" }));
}

class SurfaceModerator {
  /** @param {object} options */
  constructor({ ocrImage, inspect = inspectMessage, report = async (event) => console.warn("Surface moderation:", event.kind, event.id, event.status), allowedChannels = new Set(), profiles = false, presences = false, isCurrent = () => true }) {
    this.ocrImage = ocrImage;
    this.inspect = inspect;
    this.report = report;
    this.isCurrent = isCurrent;
    this.allowedChannels = allowedChannels;
    this.profiles = profiles;
    this.presences = presences;
    this.seen = new Map();
    this.inFlight = new Map();
  }

  /** @param {object} target @param {string} kind @returns {Promise<object | null>} */
  async check(target, kind) {
    if (!target?.guild || !detector.getAnswers().length || !this.isCurrent()) return null;
    if (kind === "profile" && !this.profiles) return null;
    if (kind === "presence" && !this.presences) return null;
    if ([target.id, target.channelId, target.parentId].some((id) => this.allowedChannels.has(id))) return null;
    const texts = [];
    const attachments = [];
    if (kind === "presence") texts.push(presenceText(target));
    else if (kind === "profile") {
      texts.push(target.user?.username, target.user?.globalName);
      attachments.push(...profileAssets(target));
    }
    else {
      texts.push(target.name, target.topic, target.description, target.entityMetadata?.location);
      for (const tag of target.availableTags || []) texts.push(tag.name);
      const url = kind === "emoji" ? target.imageURL?.({ size: 256, extension: target.animated ? "gif" : "png" }) : kind === "sticker" ? target.url : kind === "event" ? target.coverImageURL?.({ size: 1024 }) : kind === "role" ? target.iconURL?.({ size: 256 }) : null;
      if (url) attachments.push({ url, name: `${kind} image`, unsupported: kind === "sticker" && target.format === 3 ? "Lottie sticker rendering unsupported" : undefined });
    }
    const content = texts.filter(Boolean).join("\n");
    if (!content && !attachments.length) return null;
    const key = `${target.guild.id}:${kind}:${target.id || target.userId}`;
    const fingerprint = createHash("sha256").update(JSON.stringify([content, attachments, detector.getAnswers()])).digest("hex");
    if (this.seen.get(key) === fingerprint || this.inFlight.get(key) === fingerprint) return null;
    this.inFlight.set(key, fingerprint);
    let result;
    try {
      result = await this.inspect({ id: target.id || target.userId, channelId: key, content, attachments }, { ocrImage: this.ocrImage, forceJudge: true });
      if (this.inFlight.get(key) !== fingerprint || !this.isCurrent()) return null;
    } finally { if (this.inFlight.get(key) === fingerprint) this.inFlight.delete(key); }
    if (result.status !== "unscanned") {
      this.seen.set(key, fingerprint);
      if (this.seen.size > 1000) this.seen.delete(this.seen.keys().next().value);
    }
    if (result.status !== "spoiler") {
      if (result.issues.length) await this.report({ guild: target.guild, kind, id: target.id || target.userId, status: "unscanned", issues: result.issues });
      return result;
    }
    let status = "requires moderator action";
    try {
      const replacement = ["redacted", "hidden", "00000"].find((name) => !detector.scan(name));
      if (!replacement) throw new Error("no safe replacement name");
      if (["emoji", "sticker"].includes(kind) && target.deletable) {
        await target.delete("Wordle spoiler");
        status = "removed";
      } else if (kind === "channel" && target.manageable) {
        const patch = { name: replacement, reason: "Wordle spoiler" };
        if ("topic" in target) patch.topic = null;
        if ("availableTags" in target) patch.availableTags = [];
        await target.edit(patch);
        status = "cleared";
      } else if (kind === "role" && target.editable) {
        await target.edit({ name: replacement, icon: null, unicodeEmoji: null, reason: "Wordle spoiler" });
        status = "cleared";
      } else if (kind === "event" && target.guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageEvents)) {
        const patch = { name: replacement, description: null, image: null, reason: "Wordle spoiler" };
        if (target.entityMetadata?.location) patch.entityMetadata = { location: replacement };
        await target.edit(patch);
        status = "cleared";
      } else if (kind === "stage" && target.channel?.permissionsFor(target.guild.members.me)?.has(PermissionsBitField.Flags.ManageChannels)) {
        await target.edit({ topic: replacement, reason: "Wordle spoiler" });
        status = "cleared";
      } else if (kind === "voice-status" && target.channel?.permissionsFor(target.guild.members.me)?.has(PermissionsBitField.Flags.ManageChannels)) {
        await target.clear();
        status = "cleared";
      }
    } catch (error) {
      this.seen.delete(key);
      status = `moderation failed: ${error.message}`;
    }
    if (status === "requires moderator action" && !["profile", "presence"].includes(kind)) this.seen.delete(key);
    // profiles and statuses cannot be rewritten by another user's bot token.
    await this.report({ guild: target.guild, kind, id: target.id || target.userId, status });
    return result;
  }

  /** @param {object} guild @returns {Promise<void>} */
  async sweep(guild) {
    for (const [kind, collection] of [["channel", guild.channels.cache], ["role", guild.roles.cache], ["emoji", guild.emojis.cache], ["sticker", guild.stickers.cache], ["event", guild.scheduledEvents.cache], ["stage", guild.stageInstances.cache]]) {
      for (const target of collection.values()) await this.check(target, kind);
    }
    for (const member of guild.members.cache.values()) await this.check(member, "profile");
    for (const presence of guild.presences.cache.values()) await this.check(presence, "presence");
  }
}

module.exports = { SurfaceModerator, presenceText, profileAssets };
