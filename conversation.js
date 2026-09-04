const assert = require("node:assert/strict");
const detector = require("./detector");

class Conversation {
  /** @param {object} options */
  constructor({ maxMessages = 24, windowMs = 600_000, fragmentWindowMs = 180_000, maxText = 4000 } = {}) {
    Object.assign(this, { maxMessages, windowMs, fragmentWindowMs, maxText });
    this.channels = new Map();
    this.answers = "";
  }

  /** @param {string} channelId @param {number} now @returns {object[]} */
  get(channelId, now = Date.now()) {
    const answers = detector.getAnswers().join(",");
    if (answers !== this.answers) { this.channels.clear(); this.answers = answers; }
    const rows = (this.channels.get(channelId) || []).filter((row) => now - row.at < this.windowMs);
    if (rows.length) this.channels.set(channelId, rows);
    else this.channels.delete(channelId);
    return rows;
  }

  /** @param {object} message @param {string} text @param {string} fragmentText @param {number} now @returns {void} */
  remember(message, text, fragmentText = text, now = Date.now()) {
    assert.match(message.id, /^\d+$/);
    const rows = this.get(message.channelId, now).filter((row) => row.id !== message.id);
    const fragment = detector.normalize(fragmentText).replace(/[^a-z]/g, "");
    rows.push({ id: message.id, author: message.author?.id || "unknown", text: text.slice(0, this.maxText), truncated: text.length > this.maxText, fragment: /^[a-z]{1,4}$/.test(fragment) ? fragment : "", at: message.createdTimestamp ?? now });
    rows.sort((a, b) => a.at - b.at || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    this.channels.set(message.channelId, rows.slice(-this.maxMessages));
    if (this.channels.size > 1000) this.channels.delete(this.channels.keys().next().value);
  }

  /** @param {string} channelId @param {string} id @returns {void} */
  forget(channelId, id) {
    const rows = (this.channels.get(channelId) || []).filter((row) => row.id !== id);
    if (rows.length) this.channels.set(channelId, rows);
    else this.channels.delete(channelId);
  }

  /** @param {string} channelId @param {string} triggerId @param {number} now @returns {string[]} */
  fragments(channelId, triggerId, now = Date.now()) {
    const rows = this.get(channelId, now);
    const answers = detector.getAnswers();
    for (let end = 0; end < rows.length; end++) {
      let text = "";
      const ids = [];
      for (let start = end; start >= 0; start--) {
        const row = rows[start];
        if (!/^[a-z]{1,4}$/.test(row.fragment) || now - row.at >= this.fragmentWindowMs || rows[end].at - row.at >= this.fragmentWindowMs) break;
        text = row.fragment + text;
        ids.unshift(row.id);
        if (text.length > 5) break;
        // exact spelling only: unrelated short replies must not trigger fuzzy matches.
        if (ids.length > 1 && ids.includes(triggerId) && answers.includes(text)) return ids;
      }
    }
    return [];
  }
}

module.exports = { Conversation };
