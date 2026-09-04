const { test } = require("node:test");
const assert = require("node:assert/strict");
const { InspectionAlerts } = require("../alerts");

test("incomplete events aggregate and alerts never quote untrusted content or mention users", async () => {
  let now = 0;
  const sent = [];
  const guild = { id: "1", channels: { cache: new Map([["log", { isTextBased: () => true, send: async (payload) => sent.push(payload) }]]) } };
  const alerts = new InspectionAlerts({ channelId: "log", now: () => now });
  alerts.record({ guild, id: "123", issues: ["WAGER.pdf: text limit exceeded @everyone"] });
  await alerts.flush();
  for (let i = 0; i < 20; i++) alerts.record({ guild, id: String(200 + i), issues: ["inspection queue full"] });
  await alerts.flush();
  assert.equal(sent.length, 1);
  now = 60_000;
  await alerts.flush();
  assert.equal(sent.length, 2);
  assert.match(sent[1].content, /20 scan\(s\)/);
  assert.match(sent[1].content, /inspection queue: 20/);
  assert.ok(sent.every((payload) => !/WAGER|everyone/.test(payload.content)));
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});

test("failed deliveries and events arriving during a send are retained without duplicate sends", async () => {
  let now = 0;
  let reject;
  const sent = [];
  let fail = true;
  const channel = { isTextBased: () => true, send: async (payload) => {
    if (fail) return new Promise((_resolve, rejectSend) => { reject = rejectSend; });
    sent.push(payload);
  } };
  const guild = { id: "1", channels: { cache: new Map([["log", channel]]) } };
  const alerts = new InspectionAlerts({ channelId: "log", now: () => now });
  alerts.record({ guild, id: "1", issues: ["OCR failed"] });
  const sending = alerts.flush();
  alerts.record({ guild, id: "2", issues: ["meaning classifier disabled"] });
  await alerts.flush();
  reject(new Error("missing permission"));
  await sending;
  assert.equal(alerts.guilds.get("1").count, 2);
  fail = false;
  now = 60_000;
  await alerts.flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /2 scan\(s\)/);
  assert.equal(alerts.guilds.get("1").count, 0);
});
