// offline checks for the GIF tag lookup: link parsing, provider responses (mocked fetch), caching, missing keys
const assert = require("assert");
const gifs = require("../gifs");
const detector = require("../detector");

let fails = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; } catch (e) { fails++; console.log(`FAIL ${name}: ${e.message}`); }
}

const calls = [];
global.fetch = async (url) => {
  calls.push(url);
  const u = String(url);
  const json = (body, ok = true) => ({ ok, status: ok ? 200 : 404, statusText: ok ? "OK" : "Not Found", json: async () => body });
  if (u.startsWith("https://tenor.googleapis.com/v2/posts")) {
    const id = new URL(u).searchParams.get("ids");
    if (id === "40404") return json({}, false);
    return json({ results: [{ id, title: "Place Your Bets GIF", h1_title: "Gambling Time", content_description: "a man throwing chips on a table", tags: ["wager", "bet", "casino"] }] });
  }
  if (u.startsWith("https://api.giphy.com/v1/gifs/")) {
    const id = new URL(u).pathname.split("/").pop();
    return json({ data: { id, title: "Haunted House GIF by Scooby-Doo", slug: "scooby-doo-haunted-house-abc123XYZ", alt_text: "a ghost floating through a hallway" } });
  }
  throw new Error("unexpected url " + u);
};

(async () => {
  await check("tenor view link", () => {
    assert.deepStrictEqual(gifs.links("lol https://tenor.com/view/place-your-bets-gif-12345678"), [{ provider: "tenor", id: "12345678", url: "https://tenor.com/view/place-your-bets-gif-12345678" }]);
  });
  await check("tenor media links are skipped", () => {
    assert.deepStrictEqual(gifs.links("https://media.tenor.com/abcDEF/place.gif https://c.tenor.com/xyz/tenor.gif"), []);
  });
  await check("giphy link forms", () => {
    const ids = gifs.links([
      "https://giphy.com/gifs/scooby-doo-haunted-house-abc123XYZ",
      "https://media2.giphy.com/media/v1.Y2lkPTc5MGI3NjExa2/abc123XYZ/giphy.gif?cid=1",
      "https://i.giphy.com/def456UVW.gif",
      "https://giphy.com/embed/ghi789RST",
    ].join(" ")).map((l) => l.id);
    assert.deepStrictEqual(ids, ["abc123XYZ", "def456UVW", "ghi789RST"]);
  });
  await check("no keys: nothing fetched", async () => {
    gifs.cfg.tenorKey = ""; gifs.cfg.giphyKey = "";
    assert.strictEqual(await gifs.describe("https://tenor.com/view/x-gif-12345678"), "");
    assert.strictEqual(calls.length, 0);
  });
  gifs.cfg.tenorKey = "t"; gifs.cfg.giphyKey = "g";
  await check("tenor tags reach the detector", async () => {
    const text = await gifs.describe("check this https://tenor.com/view/place-your-bets-gif-12345678");
    assert.ok(text.includes("wager"), text);
    detector.setAnswers(["wager"]);
    assert.strictEqual(detector.scan(text), "wager");
  });
  await check("giphy title reaches the detector", async () => {
    const text = await gifs.describe("https://giphy.com/gifs/scooby-doo-haunted-house-abc123XYZ");
    detector.setAnswers(["ghost"]);
    assert.strictEqual(detector.scan(text), "ghost");
  });
  await check("lookups are cached", async () => {
    const before = calls.length;
    await gifs.describe("https://tenor.com/view/place-your-bets-gif-12345678 https://tenor.com/view/place-your-bets-gif-12345678");
    assert.strictEqual(calls.length, before);
  });
  await check("api errors give empty text and are not cached", async () => {
    const before = calls.length;
    assert.strictEqual(await gifs.describe("https://tenor.com/view/missing-gif-40404"), "");
    assert.strictEqual(calls.length, before + 1);
    assert.ok(!gifs.cache.has("tenor:40404"));
  });
  await check("plain chat has no links", () => {
    assert.deepStrictEqual(gifs.links("got it in 3 today, https://discord.com/channels/1/2/3"), []);
  });
  console.log(`gif tags: ${passed}/${passed + fails} passed`);
  process.exit(fails ? 1 : 0);
})();
