const { test } = require("node:test");
const assert = require("node:assert/strict");
const { handleMessage, client, conversation, versions } = require("../index");
const { Events } = require("discord.js");

/** @param {string} id @param {string} content @param {object} channel @returns {object} */
function message(id, content, channel) {
  return { id, content, channel, channelId: "channel", guildId: "guild", createdTimestamp: Date.now(), guild: {}, author: { id, bot: true }, attachments: [], delete: async () => channel.deleted.push(id) };
}

test("Discord handling removes cooperating bot messages and preserves unrelated messages", async () => {
  const original = global.fetch;
  global.fetch = async () => Response.json({ solution: "wager" });
  const channel = { deleted: [], guild: { members: { me: {} } }, permissionsFor: () => ({ has: () => true }), bulkDelete: async (ids) => channel.deleted.push(...ids) };
  try {
    await handleMessage(message("1", "hi", channel));
    await handleMessage(message("2", "wa", channel));
    await handleMessage(message("3", "ger", channel));
    assert.deepEqual(channel.deleted, ["2", "3"]);
    assert.equal(conversation.get("channel").length, 1);
  } finally { global.fetch = original; conversation.channels.clear(); }
});

test("a slow scan cannot delete a newer clean edit", async () => {
  const original = global.fetch;
  let release;
  global.fetch = async (url) => {
    if (String(url).includes("nytimes.com")) return Response.json({ solution: "wager" });
    return new Promise((resolve) => { release = resolve; });
  };
  const channel = { deleted: [], guild: { members: { me: {} } }, permissionsFor: () => ({ has: () => true }) };
  try {
    const old = message("4", "", channel);
    old.attachments = [{ url: "https://cdn.discordapp.com/attachments/test", name: "text.txt" }];
    const running = handleMessage(old);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof release, "function");
    await handleMessage(message("4", "coffee", channel));
    release(new Response("WAGER"));
    await running;
    assert.deepEqual(channel.deleted, []);
    assert.equal(conversation.get("channel")[0].text, "coffee");
    client.emit(Events.MessageDelete, { id: "4", channelId: "channel" });
    assert.equal(conversation.get("channel").length, 0);
    assert.equal(versions.size, 0);
  } finally { global.fetch = original; conversation.channels.clear(); }
});
