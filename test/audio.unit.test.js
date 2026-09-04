// Offline checks for the audio layer: attachment classification and the never-touch-the-network guards.
const assert = require("assert");
const audio = require("../audio");

const cases = [
  [{ contentType: "audio/ogg", name: "voice-message.ogg" }, "audio"],
  [{ contentType: "audio/mpeg", name: "song.mp3" }, "audio"],
  [{ contentType: "audio/webm", name: "a.weba" }, "audio"],
  [{ contentType: "audio/x-m4a", name: "a.m4a" }, "audio"],
  [{ contentType: "audio/flac", name: "a.flac" }, "audio"],
  [{ contentType: "video/mp4", name: "clip.mp4" }, "video"],
  [{ contentType: "video/quicktime", name: "clip.mov" }, "video"],
  [{ contentType: "video/webm", name: "clip.webm" }, "video"],
  [{ contentType: null, name: "a.m4a" }, "audio"],
  [{ contentType: null, name: "a.flac" }, "audio"],
  [{ contentType: null, name: "a.MOV" }, "video"],
  [{ contentType: "application/octet-stream", name: "a.mkv" }, "video"],
  [{ contentType: "image/png", name: "a.png" }, null],
  [{ contentType: "text/plain", name: "a.txt" }, null],
  [{ contentType: "application/pdf", name: "a.pdf" }, null],
  [{ contentType: "text/plain", name: "notes.mp3.txt" }, null],
  [{ contentType: null, name: "notes" }, null],
];
let fails = 0;
for (const [a, exp] of cases) {
  const r = audio.kind(a);
  if (r !== exp) { fails++; console.log("FAIL", JSON.stringify(a), "->", r, "(expected " + exp + ")"); }
}

// a disabled layer and an oversize attachment must return "" without downloading anything
global.fetch = () => { throw new Error("fetch must not be called"); };
(async () => {
  const a = { id: "1", url: "https://cdn.discordapp.com/attachments/1/2/voice-message.ogg", name: "voice-message.ogg", contentType: "audio/ogg", size: 1000 };
  assert.strictEqual(await audio.transcribe(a), "");
  audio.cfg.enabled = true;
  assert.strictEqual(await audio.transcribe({ ...a, size: audio.cfg.maxBytes + 1 }), "");
  const total = cases.length + 2;
  console.log(`audio unit: ${total - fails}/${total} passed`);
  process.exit(fails ? 1 : 0);
})();
