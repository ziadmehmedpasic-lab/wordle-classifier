// page logic for the playground. the detector runs in the browser; attempts go to
// /api/attempts and the page keeps working (without a record) when that is unreachable.
const det = require("../detector");
const WORDS = require("./words.json");

const $ = (id) => document.getElementById(id);
const wordEl = $("word");
const msgEl = $("msg");
const nickEl = $("nick");
const resultEl = $("result");
const feedEl = $("feed");
const tallyEl = $("tally");
const storageEl = $("storage");

let word = "";
let storageOk = false;
let lastId = null; // id of the last saved attempt, for the decode note

const API = "/api/attempts";
async function call(method, body) {
  const r = await fetch(API, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${API}: ${r.status}`);
  return r.json();
}
function storageFailed(what) {
  storageEl.textContent = what;
  storageEl.className = "storage warn";
}

// ---------------------------------------------------------------------
// target word
// ---------------------------------------------------------------------
function tiles(w, hit, small) {
  const box = document.createElement("div");
  box.className = small ? "tiles small" : "tiles";
  for (const c of w) {
    const t = document.createElement("span");
    t.className = hit ? "tile hit" : "tile";
    t.textContent = c;
    box.appendChild(t);
  }
  return box;
}

function reroll() {
  word = WORDS[Math.floor(Math.random() * WORDS.length)];
  det.setAnswers([word]);
  wordEl.replaceChildren(...tiles(word, false, false).children);
  resultEl.removeAttribute("data-state");
  lastId = null;
  msgEl.value = "";
  msgEl.focus();
}

// ---------------------------------------------------------------------
// nickname, kept per browser
// ---------------------------------------------------------------------
function loadNick() {
  try { nickEl.value = localStorage.getItem("nick") || ""; } catch { /* storage blocked */ }
}
nickEl.addEventListener("change", () => {
  try { localStorage.setItem("nick", nickEl.value.trim()); } catch { /* storage blocked */ }
});

// ---------------------------------------------------------------------
// sending an attempt
// ---------------------------------------------------------------------
// state names double as css hooks: caught/through for leaks, flagged/passed for innocent text
function outcome(intent, hit) {
  if (intent === "leak") return hit ? "caught" : "through";
  return hit ? "flagged" : "passed";
}

const VERDICT = {
  caught: ["Caught.", "The bot would delete this message."],
  through: ["Got through.", "The pattern layer saw nothing. This is a gap worth recording."],
  flagged: ["Flagged.", "An innocent message would have been deleted. That is a false positive."],
  passed: ["Left alone.", "The pattern layer found nothing in it."],
};

async function send() {
  const text = msgEl.value;
  if (!text.trim()) { msgEl.focus(); return; }
  const intent = document.querySelector("input[name=intent]:checked").value;
  const hit = det.scan(text);
  const state = outcome(intent, hit);

  $("verdict").textContent = VERDICT[state][0];
  $("detail").textContent = VERDICT[state][1];
  $("decode").value = "";
  $("decodestatus").textContent = "";
  resultEl.dataset.state = state;
  lastId = null;

  if (!storageOk) return;
  const doc = { word, text, intent, caught: !!hit, hit: hit || "", decode: "", nickname: nickEl.value.trim() };
  try {
    lastId = (await call("POST", doc)).id;
    await refresh();
  } catch (e) {
    storageFailed(`This attempt was not saved (${e.message}).`);
  }
}

async function saveDecode() {
  const decode = $("decode").value.trim();
  const status = $("decodestatus");
  if (!lastId) { status.textContent = storageOk ? "Nothing to attach this to." : "Not recorded: storage is unavailable."; return; }
  if (!decode) { status.textContent = "Write something first."; return; }
  try {
    await call("PATCH", { id: lastId, decode });
    status.textContent = "Saved.";
    await refresh();
  } catch (e) {
    status.textContent = `Not saved (${e.message}).`;
  }
}

$("send").addEventListener("click", send);
$("savedecode").addEventListener("click", saveDecode);
$("reroll").addEventListener("click", reroll);
msgEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });

// ---------------------------------------------------------------------
// live feed of attempts
// ---------------------------------------------------------------------
const FEED_ROWS = 40;
const WINDOW = 500;

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

function render(docs) {
  const counts = { caught: 0, through: 0, flagged: 0, passed: 0 };
  for (const d of docs) counts[outcome(d.intent, d.caught)]++;
  tallyEl.replaceChildren(
    ...[["caught", "caught"], ["through", "got through"], ["flagged", "false positives"]].map(([k, label]) => {
      const s = document.createElement("span");
      const b = document.createElement("b");
      b.textContent = String(counts[k]);
      s.append(b, ` ${label}`);
      return s;
    }),
  );

  if (!docs.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No attempts yet. Yours will be the first.";
    feedEl.replaceChildren(li);
    return;
  }

  feedEl.replaceChildren(...docs.slice(0, FEED_ROWS).map((d) => {
    const li = document.createElement("li");
    const state = outcome(d.intent, d.caught);
    const badge = document.createElement("span");
    badge.className = `badge ${state}`;
    badge.textContent = state === "through" ? "through" : state;
    const msg = document.createElement("pre");
    msg.className = "msg";
    msg.textContent = String(d.text || "");
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.append(tiles(String(d.word || ""), d.caught, true));
    const who = document.createElement("span");
    who.textContent = `${d.nickname || "anonymous"} · ${d.intent === "innocent" ? "innocent" : "leak"} · ${timeAgo(Number(d.ts) || 0)}`;
    meta.append(who);
    li.append(badge, msg, meta);
    if (d.decode) {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = `Decode: ${d.decode}`;
      li.append(note);
    }
    return li;
  }));
}

const POLL_MS = 15000;

async function refresh() {
  const { attempts } = await call("GET");
  render(attempts);
}

async function connect() {
  try {
    await refresh();
  } catch (e) {
    storageFailed("Storage is unreachable. You can still test messages, but nothing is recorded.");
    render([]);
    return;
  }
  storageOk = true;
  storageEl.textContent = `Shared with everyone who opens this page. Showing the last ${FEED_ROWS} of up to ${WINDOW} attempts.`;
  setInterval(() => refresh().catch(() => storageFailed("Lost the connection to storage. Reload to reconnect.")), POLL_MS);
}

loadNick();
reroll();
render([]);
connect();
