const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SurfaceModerator, presenceText, profileAssets } = require("../surfaces");
const { collectContent } = require("../inspection");
const detector = require("../detector");

detector.setAnswers(["wager"]);

/** @returns {object} */
function harness() {
  const reports = [];
  const inputs = [];
  const moderator = new SurfaceModerator({
    profiles: true, presences: true, allowedChannels: new Set(["allowed"]),
    report: async (event) => reports.push(event),
    inspect: async (message) => { inputs.push(message); return { status: detector.scan(message.content) || message.attachments.length ? "spoiler" : "clean", issues: [] }; },
  });
  const guild = { id: "guild", members: { me: { permissions: { has: () => true } } } };
  return { moderator, guild, reports, inputs };
}

test("custom status and activity fields are scanned without attempting to edit an account", async () => {
  const { moderator, guild, reports } = harness();
  const presence = { guild, userId: "member", activities: [{ name: "Custom Status", state: "WAGER", details: "detail", assets: { largeText: "hover text" } }] };
  assert.match(presenceText(presence), /hover text/);
  await moderator.check(presence, "presence");
  assert.equal(reports[0].status, "requires moderator action");
  assert.equal(reports[0].id, "member");
  assert.ok(!JSON.stringify(reports).includes("WAGER"));
});

test("profile assets include guild and global images", async () => {
  const { moderator, guild, reports, inputs } = harness();
  const member = { id: "member", guild, displayAvatarURL: () => "guild-avatar", bannerURL: () => "guild-banner", user: { avatarURL: () => "global-avatar", bannerURL: () => "global-banner" } };
  assert.equal(profileAssets(member).length, 4);
  await moderator.check(member, "profile");
  assert.equal(inputs[0].attachments.length, 4);
  assert.equal(reports[0].status, "requires moderator action");
});

test("channel topics and forum tags are cleared when they leak the answer", async () => {
  const { moderator, guild } = harness();
  const edits = [];
  await moderator.check({ id: "channel", guild, name: "chat", topic: "WAGER", availableTags: [{ name: "help" }], manageable: true, edit: async (patch) => edits.push(patch) }, "channel");
  assert.equal(edits[0].topic, null);
  assert.deepEqual(edits[0].availableTags, []);
  assert.equal(detector.scan(edits[0].name), null);
  await moderator.check({ id: "allowed", guild, topic: "WAGER", manageable: true, edit: async () => assert.fail("allowed channel edited") }, "channel");
});

test("event descriptions and cover images trigger a permitted edit", async () => {
  const { moderator, guild } = harness();
  const edits = [];
  await moderator.check({ id: "event", guild, name: "party", description: "WAGER", coverImageURL: () => "cover", edit: async (patch) => edits.push(patch) }, "event");
  assert.equal(edits[0].description, null);
  assert.equal(edits[0].image, null);
});

test("an innocent emoji name does not prevent pixel inspection and removal", async () => {
  const { moderator, guild, inputs } = harness();
  let removed = false;
  await moderator.check({ id: "emoji", guild, name: "hello", imageURL: () => "pixels", deletable: true, delete: async () => { removed = true; } }, "emoji");
  assert.equal(inputs[0].attachments[0].url, "pixels");
  assert.ok(removed);
});

test("missing permission reports a finding without claiming removal", async () => {
  const { moderator, guild, reports } = harness();
  await moderator.check({ id: "channel", guild, name: "WAGER", manageable: false, edit: async () => assert.fail("unmanageable channel edited") }, "channel");
  assert.equal(reports[0].status, "requires moderator action");
});

test("identical content is deduplicated, but answer rollover and edits are rechecked", async () => {
  const { moderator, guild, inputs, reports } = harness();
  const target = { guild, userId: "member", activities: [{ state: "coffee" }] };
  await moderator.check(target, "presence");
  await moderator.check(target, "presence");
  assert.equal(inputs.length, 1);
  assert.equal(reports.length, 0);
  detector.setAnswers(["house"]);
  try { await moderator.check(target, "presence"); assert.equal(inputs.length, 2); }
  finally { detector.setAnswers(["wager"]); }
  target.activities[0].state = "WAGER";
  await moderator.check(target, "presence");
  assert.equal(reports.length, 1);
});

test("used external emoji and stickers include their actual image URLs", () => {
  const content = collectContent({ content: "<a:hello:123456789012345678>", stickers: [{ name: "hello", format: 3, url: "https://cdn.discordapp.com/stickers/1.json" }] });
  assert.equal(content.assets.length, 2);
  assert.ok(content.assets.some((asset) => asset.url.includes("123456789012345678.gif")));
  assert.ok(content.assets.some((asset) => asset.unsupported === "Lottie sticker rendering unsupported"));
});

test("a newer edit prevents a slow stale finding from clearing the surface", async () => {
  const { moderator, guild } = harness();
  let finish;
  moderator.inspect = async (message) => {
    if (message.content === "WAGER") return new Promise((resolve) => { finish = resolve; });
    return { status: "clean", issues: [] };
  };
  const target = { guild, id: "channel", name: "WAGER", manageable: true, edit: async () => assert.fail("stale finding edited channel") };
  const stale = moderator.check(target, "channel");
  target.name = "coffee";
  await moderator.check(target, "channel");
  finish({ status: "spoiler", issues: [] });
  assert.equal(await stale, null);
});
