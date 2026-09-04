const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { buildFixtures } = require("../eval/fixtures");
const frames = require("../frames");

test("the cap fixture contains exactly 300 blank frames before its spoiler", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wordle-eval-fixtures-"));
  const saved = frames.cfg.maxFrames;
  try {
    await buildFixtures(directory);
    const input = path.join(directory, "long.mkv");
    assert.equal(Number((await frames.probe(input)).streams[0].nb_read_frames), 301);
    frames.cfg.maxFrames = 300;
    const capped = [];
    const result = await frames.decode(input, async (png) => capped.push(await sharp(png).stats()));
    assert.equal(capped.length, 1);
    assert.equal(capped[0].channels[0].min, 255);
    assert.ok(result.issues.includes("video frame limit exceeded"));
    frames.cfg.maxFrames = 301;
    const full = [];
    await frames.decode(input, async (png) => full.push(await sharp(png).stats()));
    assert.equal(full.length, 2);
    assert.equal(full[1].channels[0].min, 0);
  } finally { frames.cfg.maxFrames = saved; await fs.rm(directory, { recursive: true, force: true }); }
});
