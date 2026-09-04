const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const { parseArgs } = require("node:util");
const detector = require("../detector");
const { inspectMessage, extractAsset, limits } = require("../inspection");
const { ocrImage, close } = require("../ocr");
const { download } = require("../download");

/** @returns {Promise<void>} */
async function main() {
  const { values } = parseArgs({ options: { out: { type: "string", default: "eval/runs/overload.json" } } });
  detector.setAnswers(["wager"]);
  const bytes = await sharp({ create: { width: 320, height: 100, channels: 3, background: "white" } }).png().toBuffer();
  const started = performance.now();
  const running = Array.from({ length: 24 }, async (_, i) => {
    const start = performance.now();
    const result = await inspectMessage({ channelId: "overload", attachments: [{ name: "image.png", url: `https://cdn.discordapp.com/attachments/eval/${i}` }] }, {
      ocrImage, extract: (asset, options) => extractAsset(asset, { ...options, downloadFile: (url) => download(url, { fetchImpl: async () => new Response(bytes) }) }),
    });
    return { id: i, status: result.status, issues: result.issues, latencyMs: performance.now() - start };
  });
  const directStart = performance.now();
  const direct = await inspectMessage({ content: "WAGER", channelId: "overload" }, { ocrImage });
  const directLatencyMs = performance.now() - directStart;
  const rows = await Promise.all(running);
  const result = { limits, judge: "disabled", transport: "local fixture bytes", latencyMs: performance.now() - started, direct: { status: direct.status, latencyMs: directLatencyMs }, queueRejected: rows.filter((row) => row.issues.includes("inspection queue full")).length, queueExpired: rows.filter((row) => row.issues.includes("inspection queue wait expired")).length, rows };
  await fs.mkdir(path.dirname(values.out), { recursive: true });
  await fs.writeFile(values.out, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ out: values.out, queueRejected: result.queueRejected, queueExpired: result.queueExpired, direct: result.direct, latencyMs: result.latencyMs }, null, 2));
}

main().finally(close).catch((error) => { console.error(error); process.exitCode = 1; });
