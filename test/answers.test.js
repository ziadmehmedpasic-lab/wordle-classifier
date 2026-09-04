const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Answers, selectedDates } = require("../answers");

test("server timezone, year/leap boundaries and both DST changes select calendar dates", () => {
  assert.deepEqual(selectedDates(new Date("2026-09-04T16:00:00Z"), "Asia/Kuala_Lumpur", 1), ["2026-09-05", "2026-09-04"]);
  assert.deepEqual(selectedDates(new Date("2026-09-04T15:59:59Z"), "Asia/Kuala_Lumpur"), ["2026-09-04"]);
  assert.deepEqual(selectedDates(new Date("2026-01-01T00:00:00Z"), "UTC", 1), ["2026-01-01", "2025-12-31"]);
  assert.deepEqual(selectedDates(new Date("2024-03-01T12:00:00Z"), "UTC", 1), ["2024-03-01", "2024-02-29"]);
  for (const instant of ["2026-03-08T06:59:59Z", "2026-03-08T07:00:00Z"]) assert.equal(selectedDates(new Date(instant), "America/New_York")[0], "2026-03-08");
  for (const instant of ["2026-11-01T05:59:59Z", "2026-11-01T06:00:00Z"]) assert.equal(selectedDates(new Date(instant), "America/New_York")[0], "2026-11-01");
  assert.throws(() => selectedDates(new Date(), "bad/timezone"));
  for (const days of [-1, 0.5, NaN, Infinity, 32]) assert.throws(() => selectedDates(new Date(), "UTC", days));
});

test("only selected dates are fetched, and concurrent refreshes share one request", async () => {
  const urls = [];
  const answers = new Answers({ timeZone: "UTC", windowDays: 1, fetchImpl: async (url) => {
    urls.push(url);
    return Response.json({ print_date: url.slice(-15, -5), solution: url.includes("09-05") ? "wager" : "house" });
  } });
  const now = new Date("2026-09-05T12:00:00Z");
  await Promise.all([answers.refresh({ now }), answers.refresh({ now })]);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => !url.includes("09-06")));
  assert.deepEqual(answers.get(now), ["wager", "house"]);
});

test("rollover failure cannot expose stale answers, retries are bounded, and recovery works", async () => {
  let calls = 0;
  let fail = false;
  const answers = new Answers({ timeZone: "UTC", windowDays: 0, fetchImpl: async (url) => {
    calls++;
    if (fail) return new Response("unavailable", { status: 503 });
    return Response.json({ print_date: url.slice(-15, -5), solution: url.includes("09-05") ? "wager" : "house" });
  } });
  const before = new Date("2026-09-05T23:59:59Z");
  const after = new Date("2026-09-06T00:00:00Z");
  await answers.refresh({ now: before });
  assert.deepEqual(answers.get(before), ["wager"]);
  assert.deepEqual(answers.get(after), []);
  fail = true;
  await assert.rejects(answers.refresh({ now: after }), /503/);
  await answers.refresh({ now: new Date("2026-09-06T00:00:30Z") });
  assert.equal(calls, 2);
  assert.deepEqual(answers.get(after), []);
  fail = false;
  await answers.refresh({ now: new Date("2026-09-06T00:01:00Z") });
  assert.deepEqual(answers.get(after), ["house"]);
});

test("older in-flight fetches cannot overwrite a newer date", async () => {
  let release;
  const answers = new Answers({ timeZone: "UTC", windowDays: 0, fetchImpl: async (url) => {
    if (url.includes("09-05")) return new Promise((resolve) => { release = resolve; });
    return Response.json({ print_date: "2026-09-06", solution: "house" });
  } });
  const old = answers.refresh({ now: new Date("2026-09-05T12:00:00Z") });
  const now = new Date("2026-09-06T12:00:00Z");
  await answers.refresh({ now });
  release(Response.json({ print_date: "2026-09-05", solution: "wager" }));
  await old;
  assert.deepEqual(answers.get(now), ["house"]);
});

test("wrong dates and malformed solutions cannot become protected answers", async () => {
  const now = new Date("2026-09-05T12:00:00Z");
  for (const data of [{ print_date: "2026-09-04", solution: "wager" }, { print_date: "2026-09-05", solution: "bad" }]) {
    const answers = new Answers({ timeZone: "UTC", windowDays: 0, fetchImpl: async () => Response.json(data) });
    await assert.rejects(answers.refresh({ now }));
    assert.deepEqual(answers.get(now), []);
  }
});
