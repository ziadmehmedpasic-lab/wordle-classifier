// page logic for the playground. the detector runs in the browser; attempts go to
// /api/attempts and the page keeps working (without a record) when that is unreachable.
const det = require("../detector");
const WORDS = require("./words.json");

const $ = (id) => document.getElementById(id);
const wordEl = $("word");
const threadEl = $("thread");
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

function setWord(w) {
  word = w;
  det.setAnswers([word]);
  wordEl.replaceChildren(...tiles(word, false, false).children);
  resultEl.removeAttribute("data-state");
  lastId = null;
  resetThread();
}

function reroll() {
  $("pickstatus").textContent = "";
  setWord(WORDS[Math.floor(Math.random() * WORDS.length)]);
}

function pickWord(e) {
  e.preventDefault();
  const w = $("custom").value.trim().toLowerCase();
  const status = $("pickstatus");
  if (!/^[a-z]{5}$/.test(w)) { status.textContent = "Five letters, a to z."; return; }
  status.textContent = det.isWord(w) ? "" : "Not in the dictionary, but fine.";
  $("custom").value = "";
  setWord(w);
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
// the thread: one row per message, checked together in order
// ---------------------------------------------------------------------
const MAX_MESSAGES = 12;

function rows() { return [...threadEl.querySelectorAll(".m")]; }

function renumber() {
  const all = rows();
  all.forEach((r, i) => { r.querySelector(".n").textContent = String(i + 1); r.querySelector(".x").hidden = all.length === 1; });
}

function addRow(after) {
  if (rows().length >= MAX_MESSAGES) return null;
  const row = document.createElement("div");
  row.className = "m";
  const n = document.createElement("span");
  n.className = "n";
  const ta = document.createElement("textarea");
  ta.rows = 1;
  ta.spellcheck = false;
  ta.placeholder = rows().length ? "next message" : "Type it the way you'd post it in the channel";
  ta.addEventListener("keydown", onKey);
  ta.addEventListener("input", clearVerdicts);
  const x = document.createElement("button");
  x.type = "button";
  x.className = "x";
  x.title = "Remove this message";
  x.setAttribute("aria-label", "Remove this message");
  x.textContent = "×";
  x.addEventListener("click", () => { row.remove(); renumber(); clearVerdicts(); });
  row.append(n, ta, x);
  if (after) after.insertAdjacentElement("afterend", row); else threadEl.appendChild(row);
  renumber();
  return ta;
}

function onKey(e) {
  if (e.key !== "Enter") return;
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); send(); return; }
  if (e.shiftKey) return; // plain newline inside one message
  e.preventDefault();
  const next = addRow(e.target.closest(".m"));
  if (next) next.focus();
}

function resetThread() {
  threadEl.replaceChildren();
  addRow().focus();
}

function clearVerdicts() {
  for (const r of rows()) r.removeAttribute("data-verdict");
}

// ---------------------------------------------------------------------
// what the bot does with a sequence of messages from one author, in order:
// each message is scanned alone; a message of three characters or fewer that
// survives is held and the held ones are scanned joined (mirrors index.js)
// ---------------------------------------------------------------------
const FRAG_MAX = 12;

function runBot(messages) {
  const deleted = messages.map(() => false);
  let hit = null;
  let joined = null; // indices deleted together by the fragment join
  let held = [];
  messages.forEach((text, i) => {
    const single = det.scan(text);
    if (single) { deleted[i] = true; hit = hit || single; return; }
    const t = det.normalize(text).replace(/[^a-z0-9]/g, "");
    if (!t || t.length > 3) return;
    held.push({ i, t });
    while (held.length > FRAG_MAX) held.shift();
    const parts = held.map((h) => h.t);
    const h = det.scan(parts.join("")) || det.scan(parts.join(" "));
    if (!h) return;
    for (const f of held) deleted[f.i] = true;
    hit = hit || h;
    joined = held.map((f) => f.i);
    held = [];
  });
  return { deleted, hit, joined };
}

// ---------------------------------------------------------------------
// sending an attempt
// ---------------------------------------------------------------------
// state names double as css hooks: caught/through for leaks, flagged/passed for innocent text
function outcome(intent, caught) {
  if (intent === "leak") return caught ? "caught" : "through";
  return caught ? "flagged" : "passed";
}

const VERDICT = {
  caught: "Caught.",
  through: "Got through.",
  flagged: "Flagged.",
  passed: "Left alone.",
};

function describe(state, messages, r) {
  const n = messages.length;
  const which = r.deleted.map((d, i) => (d ? i + 1 : 0)).filter(Boolean);
  if (state === "through") return n > 1 ? `None of the ${n} messages tripped the pattern layer. This is a gap worth recording.` : "The pattern layer saw nothing. This is a gap worth recording.";
  if (state === "passed") return n > 1 ? `All ${n} messages would be left in the channel.` : "The pattern layer found nothing in it.";
  const verb = state === "flagged" ? "would be deleted, a false positive" : "would be deleted";
  if (n === 1) return `The message ${verb}.`;
  const list = which.length === n ? `All ${n} messages` : `Message${which.length > 1 ? "s" : ""} ${which.join(", ")} of ${n}`;
  const join = r.joined ? ` Short messages ${r.joined.map((i) => i + 1).join(", ")} were joined and read as one.` : "";
  return `${list} ${verb}.${join}`;
}

async function send() {
  const inputs = rows().map((r) => r.querySelector("textarea"));
  const messages = inputs.map((t) => t.value).filter((v) => v.trim());
  if (!messages.length) { inputs[0].focus(); return; }
  const intent = document.querySelector("input[name=intent]:checked").value;
  const r = runBot(messages);
  const caught = r.deleted.some(Boolean);
  const state = outcome(intent, caught);

  let k = 0;
  for (const row of rows()) {
    const t = row.querySelector("textarea");
    if (!t.value.trim()) { row.removeAttribute("data-verdict"); continue; }
    row.dataset.verdict = r.deleted[k++] ? "deleted" : "kept";
  }
  $("verdict").textContent = VERDICT[state];
  $("detail").textContent = describe(state, messages, r);
  $("decode").value = "";
  $("decodestatus").textContent = "";
  resultEl.dataset.state = state;
  lastId = null;

  if (!storageOk) return;
  const doc = { word, messages, deleted: r.deleted, intent, caught, hit: r.hit || "", decode: "", nickname: nickEl.value.trim() };
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
$("addmsg").addEventListener("click", () => { const t = addRow(); if (t) t.focus(); });
$("savedecode").addEventListener("click", saveDecode);
$("reroll").addEventListener("click", reroll);
$("pick").addEventListener("submit", pickWord);

// ---------------------------------------------------------------------
// live feed of attempts
// ---------------------------------------------------------------------
const FEED_ROWS = 40;
const WINDOW = 500;
const POLL_MS = 15000;

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

// older records have a single text; newer ones a list of messages
function messagesOf(d) {
  if (Array.isArray(d.messages) && d.messages.length) return d.messages.map(String);
  return [String(d.text || "")];
}
function deletedOf(d, n) {
  if (Array.isArray(d.deleted) && d.deleted.length === n) return d.deleted.map(Boolean);
  return Array(n).fill(!!d.caught);
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
    badge.textContent = state;
    const msgs = messagesOf(d);
    const del = deletedOf(d, msgs.length);
    const list = document.createElement("div");
    list.className = "msgs";
    msgs.forEach((text, i) => {
      const m = document.createElement("div");
      m.className = del[i] ? "msg deleted" : "msg";
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = msgs.length > 1 ? String(i + 1) : "";
      const pre = document.createElement("pre");
      pre.textContent = text;
      m.append(n, pre);
      list.append(m);
    });
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.append(tiles(String(d.word || ""), d.caught, true));
    const who = document.createElement("span");
    const multi = msgs.length > 1 ? ` · ${msgs.length} messages, ${del.filter(Boolean).length} deleted` : "";
    who.textContent = `${d.nickname || "anonymous"} · ${d.intent === "innocent" ? "innocent" : "leak"}${multi} · ${timeAgo(Number(d.ts) || 0)}`;
    meta.append(who);
    li.append(badge, list, meta);
    if (d.decode) {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = `Decode: ${d.decode}`;
      li.append(note);
    }
    return li;
  }));
}

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
