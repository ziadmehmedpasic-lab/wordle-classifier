const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Conversation } = require("../conversation");
const detector = require("../detector");

detector.setAnswers(["wager"]);

test("cooperating authors yield only the exact contributing message IDs", () => {
  const context = new Conversation();
  for (const [index, text] of ["hi", "w", "a", "g", "e", "r"].entries()) context.remember({ id: String(index + 1), channelId: "channel", author: { id: String(index) }, createdTimestamp: 100 + index }, text, text, 200);
  assert.deepEqual(context.fragments("channel", "6", 200), ["2", "3", "4", "5", "6"]);
  assert.deepEqual(context.fragments("another", "6", 200), []);
});

test("edited messages replace prior content and deletion removes evidence", () => {
  const context = new Conversation();
  context.remember({ id: "1", channelId: "channel", createdTimestamp: 100 }, "WA", "WA", 200);
  context.remember({ id: "2", channelId: "channel", createdTimestamp: 101 }, "GER", "GER", 200);
  assert.deepEqual(context.fragments("channel", "2", 200), ["1", "2"]);
  context.remember({ id: "1", channelId: "channel", createdTimestamp: 100 }, "hello", "hello", 200);
  assert.deepEqual(context.fragments("channel", "1", 200), []);
  assert.equal(context.get("channel", 200).length, 2);
  context.forget("channel", "2");
  assert.equal(context.get("channel", 200).length, 1);
});

test("ordinary short replies, long interruptions and expired fragments do not match", () => {
  const context = new Conversation();
  for (const [index, text] of ["wa", "a harmless interruption", "ger", "hi", "ok", "yes"].entries()) context.remember({ id: String(index), channelId: "channel", createdTimestamp: 100 + index }, text, text, 200);
  assert.deepEqual(context.fragments("channel", "2", 200), []);
  assert.deepEqual(context.fragments("channel", "5", 200), []);
  assert.deepEqual(context.fragments("channel", "2", 200_000), []);
  assert.deepEqual(context.get("channel", 700_000), []);
});

test("context bounds and answer rollover are explicit", () => {
  const context = new Conversation({ maxMessages: 2, maxText: 4 });
  for (let i = 0; i < 3; i++) context.remember({ id: String(i), channelId: "channel", createdTimestamp: 100 }, "long text", "long text", 200);
  assert.equal(context.get("channel", 200).length, 2);
  assert.ok(context.get("channel", 200).every((row) => row.truncated));
  detector.setAnswers(["house"]);
  try { assert.deepEqual(context.get("channel", 200), []); }
  finally { detector.setAnswers(["wager"]); }
});
