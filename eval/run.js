require("dotenv").config({ quiet: true });
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { execFileSync } = require("node:child_process");
const Anthropic = require("@anthropic-ai/sdk");
const detector = require("../detector");
const llm = require("../llm");
const frames = require("../frames");
const { ocrImage, close } = require("../ocr");
const { inspectMessage, extractAsset, limits } = require("../inspection");
const { download } = require("../download");
const { Conversation } = require("../conversation");
const { buildFixtures } = require("./fixtures");
const { summarize, estimateCost } = require("./metrics");

/** @returns {Promise<void>} */
async function main() {
  const { values } = parseArgs({ options: { "live-judge": { type: "boolean", default: false }, out: { type: "string" }, cases: { type: "string" }, prices: { type: "string" }, "max-requests": { type: "string", default: "40" } } });
  const out = path.resolve(values.out || path.join(__dirname, "runs", new Date().toISOString().replace(/[:.]/g, "-")));
  const maxRequests = Number(values["max-requests"]);
  assert.ok(Number.isInteger(maxRequests) && maxRequests > 0);
  await fs.mkdir(out, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(values.cases || path.join(__dirname, "cases.json"), "utf8"));
  assert.equal(new Set(manifest.map((row) => row.id)).size, manifest.length, "duplicate case ids");
  const prices = values.prices ? JSON.parse(await fs.readFile(values.prices, "utf8")) : null;
  const requests = [];
  let measuredClient;
  if (values["live-judge"]) {
    assert.ok(llm.init(), "live judge requested but unavailable");
    const client = new Anthropic();
    measuredClient = { beta: { messages: { create: async (...args) => {
      assert.ok(requests.length < maxRequests, "evaluation request budget exceeded");
      const request = { usage: null, stopReason: null, model: null, error: null };
      requests.push(request);
      try {
        const response = await client.beta.messages.create(...args);
        request.usage = response.usage;
        request.stopReason = response.stop_reason;
        request.model = response.model;
        return response;
      } catch (error) { request.error = { name: error.name, status: error.status || null }; throw error; }
    } } } };
  }
  const judge = { ...llm, classify: (input) => llm.classify(input, measuredClient) };
  detector.setAnswers(["wager"]);
  frames.init();
  const config = { answer: "wager", liveJudge: values["live-judge"], model: llm.cfg.model, judge: llm.cfg, frames: frames.cfg, limits, prices, maxRequests, transport: "local fixture bytes through validated download; no Discord writes", audio: "not exercised", commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), createdAt: new Date().toISOString() };
  await fs.writeFile(path.join(out, "config.json"), JSON.stringify(config, null, 2) + "\n");
  await fs.writeFile(path.join(out, "cases.json"), JSON.stringify(manifest, null, 2) + "\n");
  const assets = path.join(out, "assets");
  await buildFixtures(assets);
  const rows = [];
  for (const entry of manifest) {
    assert.ok(entry.id && entry.messages.length && Array.isArray(entry.remove));
    const conversation = new Conversation();
    const removed = new Set();
    const steps = [];
    const requestStart = requests.length;
    const start = performance.now();
    for (const [index, input] of entry.messages.entries()) {
      const id = input.id || String(index + 1);
      const message = { id, channelId: entry.id, content: input.content || "", author: { id: input.author || "tester" }, createdTimestamp: Date.now(), attachments: [] };
      if (input.asset) message.attachments.push({ url: `https://cdn.discordapp.com/attachments/evaluation/${encodeURIComponent(input.asset)}`, name: input.name || input.asset, contentType: input.contentType });
      conversation.remember(message, message.content);
      const result = await inspectMessage(message, {
        ocrImage, judge, context: conversation.get(entry.id).filter((row) => row.id !== id),
        extract: (asset, options) => extractAsset(asset, { ...options, downloadFile: (url) => download(url, { fetchImpl: async () => new Response(await fs.readFile(path.join(assets, input.asset))) }) }),
      });
      steps.push({ id, status: result.status, issues: result.issues, hit: result.hit || null });
      if (result.status === "spoiler") { removed.add(id); conversation.forget(entry.id, id); }
      else {
        conversation.remember(message, result.text, result.fragmentText ?? result.text);
        for (const contributor of conversation.fragments(entry.id, id)) { removed.add(contributor); conversation.forget(entry.id, contributor); }
      }
    }
    const used = requests.slice(requestStart);
    const row = { id: entry.id, category: entry.category, expected: entry.remove, removed: [...removed], steps, latencyMs: performance.now() - start, requests: used, estimatedCostUsd: estimateCost(used, prices) };
    rows.push(row);
    await fs.writeFile(path.join(out, "results.json"), JSON.stringify(rows, null, 2) + "\n");
    await fs.writeFile(path.join(out, "summary.json"), JSON.stringify(summarize(rows), null, 2) + "\n");
    console.log(`${row.id}: ${row.removed.length ? "remove " + row.removed.join(",") : "keep"}; ${row.latencyMs.toFixed(0)} ms`);
  }
  console.log(JSON.stringify({ out, ...summarize(rows) }, null, 2));
}

main().finally(close).catch((error) => { console.error(error); process.exitCode = 1; });
