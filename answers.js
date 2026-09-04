const assert = require("node:assert/strict");

/** @param {Date} now @param {string} timeZone @param {number} windowDays @returns {string[]} */
function selectedDates(now = new Date(), timeZone = "UTC", windowDays = 0) {
  assert.ok(Number.isSafeInteger(windowDays) && windowDays >= 0 && windowDays <= 31, "ANSWER_WINDOW_DAYS must be an integer from 0 to 31");
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const day = Date.UTC(Number(fields.year), Number(fields.month) - 1, Number(fields.day));
  // move between calendar dates in UTC after finding the server's local date; DST cannot skip a day.
  return Array.from({ length: windowDays + 1 }, (_, offset) => new Date(day - offset * 86_400_000).toISOString().slice(0, 10));
}

class Answers {
  /** @param {object} options */
  constructor({ timeZone = process.env.TIMEZONE || "UTC", windowDays = Number(process.env.ANSWER_WINDOW_DAYS || 0), fetchImpl = (...args) => fetch(...args), retryMs = 60_000 } = {}) {
    selectedDates(new Date(), timeZone, windowDays);
    Object.assign(this, { timeZone, windowDays, fetchImpl, retryMs });
    this.records = new Map();
    this.date = "";
    this.pending = null;
    this.retryDate = "";
    this.retryAt = 0;
  }

  /** @param {Date} now @returns {string[]} */
  get(now = new Date()) {
    const dates = selectedDates(now, this.timeZone, this.windowDays);
    if (dates.some((date) => !this.records.has(date))) return [];
    return [...new Set(dates.map((date) => this.records.get(date)))];
  }

  /** @param {object} options @returns {Promise<void>} */
  async refresh({ now = new Date(), force = false } = {}) {
    const dates = selectedDates(now, this.timeZone, this.windowDays);
    const today = dates[0];
    if (this.pending && this.pending.date !== today) this.pending = null;
    if (this.pending) return this.pending.promise;
    if (!force && (this.date === today || (this.retryDate === today && now.getTime() < this.retryAt))) return;
    const job = { date: today, promise: null };
    this.pending = job;
    job.promise = (async () => {
      const rows = await Promise.all(dates.map(async (date) => {
        const response = await this.fetchImpl(`https://www.nytimes.com/svc/wordle/v2/${date}.json`, { headers: { "User-Agent": "wordle-spoiler-bot" }, signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`NYT returned ${response.status} for ${date}`);
        const data = await response.json();
        assert.equal(data.print_date, date, "NYT response date does not match requested date");
        assert.match(data.solution, /^[a-z]{5}$/i, "NYT solution must contain five letters");
        return [date, data.solution.toLowerCase()];
      }));
      if (this.pending !== job) return;
      this.records = new Map(rows);
      this.date = today;
      this.retryDate = "";
    })().catch((error) => {
      if (this.pending === job) { this.retryDate = today; this.retryAt = now.getTime() + this.retryMs; }
      throw error;
    }).finally(() => { if (this.pending === job) this.pending = null; });
    return job.promise;
  }
}

module.exports = { Answers, selectedDates };
