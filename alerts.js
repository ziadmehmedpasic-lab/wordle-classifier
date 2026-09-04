const categories = [
  [/queue/i, "inspection queue"], [/limit|exceeds|truncat/i, "inspection limit"],
  [/disabled/i, "disabled layer"], [/answer unavailable/i, "answer unavailable"],
  [/external|linked pages/i, "external content"], [/unsupported|unscanned|unknown/i, "unsupported content"],
  [/failed|error|timeout/i, "processing failure"],
];

class InspectionAlerts {
  /** @param {object} options */
  constructor({ channelId = process.env.MOD_LOG_CHANNEL_ID, intervalMs = 60_000, now = Date.now } = {}) {
    Object.assign(this, { channelId, intervalMs, now });
    this.guilds = new Map();
  }

  /** @param {object} event @returns {void} */
  record({ guild, kind = "message", id, issues = [] }) {
    if (!this.channelId || !guild) return;
    if (!this.guilds.has(guild.id)) {
      if (this.guilds.size >= 1000) { console.error("Inspection alert guild limit reached"); return; }
      this.guilds.set(guild.id, { guild, count: 0, reasons: new Map(), samples: new Set(), lastAttempt: -Infinity, sending: false });
    }
    const state = this.guilds.get(guild.id);
    state.count++;
    const reasons = new Set(issues.map((issue) => categories.find(([pattern]) => pattern.test(issue))?.[1] || "incomplete coverage"));
    if (!reasons.size) reasons.add("incomplete coverage");
    for (const reason of reasons) state.reasons.set(reason, (state.reasons.get(reason) || 0) + 1);
    if (state.samples.size < 3 && /^\d+$/.test(id)) {
      const label = ["message", "reaction", "profile", "presence", "channel", "role", "emoji", "sticker", "event", "stage", "voice-status"].includes(kind) ? kind : "resource";
      state.samples.add(`${label} ${id}`);
    }
  }

  /** @returns {Promise<void>} */
  async flush() {
    for (const state of this.guilds.values()) {
      if (!state.count || state.sending || this.now() - state.lastAttempt < this.intervalMs) continue;
      const batch = { count: state.count, reasons: state.reasons, samples: state.samples };
      state.count = 0;
      state.reasons = new Map();
      state.samples = new Set();
      state.lastAttempt = this.now();
      state.sending = true;
      try {
        const channel = state.guild.channels.cache.get(this.channelId);
        if (!channel?.isTextBased() || typeof channel.send !== "function") throw new Error("moderator log channel is unavailable");
        const reasons = [...batch.reasons].map(([reason, count]) => `${reason}: ${count}`).join(", ");
        const samples = [...batch.samples].join(", ") || "see bot logs for resource IDs";
        await channel.send({ content: `Wordle inspection incomplete: ${batch.count} scan(s) (${reasons}). Review affected content. Sample IDs: ${samples}.`, allowedMentions: { parse: [] } });
      } catch (error) {
        // retain the batch for retry, including events recorded while delivery was in flight.
        state.count += batch.count;
        for (const [reason, count] of batch.reasons) state.reasons.set(reason, (state.reasons.get(reason) || 0) + count);
        state.samples = new Set([...batch.samples, ...state.samples].slice(0, 3));
        console.error(`Inspection alert delivery failed for guild ${state.guild.id}: ${error.message}`);
      } finally { state.sending = false; }
    }
  }
}

module.exports = { InspectionAlerts };
