// =====================================================================
// GIF metadata: a Tenor or Giphy link carries tags and a description
// on the provider's API that the slug in the URL does not. Looked up
// before any pixel is examined, so a GIF found by searching the answer
// is caught even when the slug is neutral.
// =====================================================================
const cfg = { tenorKey: "", giphyKey: "", timeoutMs: 5000 };
const cache = new Map(); // "provider:id" -> text
const CACHE_MAX = 1000;

function init() {
  cfg.tenorKey = process.env.TENOR_API_KEY || "";
  cfg.giphyKey = process.env.GIPHY_API_KEY || "";
  const on = [cfg.tenorKey && "Tenor", cfg.giphyKey && "Giphy"].filter(Boolean);
  if (on.length) console.log(`GIF tags: on (${on.join(", ")})`);
  else console.log("GIF tags: disabled (no TENOR_API_KEY or GIPHY_API_KEY in .env). GIF links are checked by their URL only.");
  return on.length > 0;
}

// ---------------------------------------------------------------------
// Which links can be looked up
// ---------------------------------------------------------------------
const URL_RE = /https?:\/\/(?:[a-z0-9-]+\.)*(tenor|giphy)\.com\/[^\s<>()"']+/gi;

// tenor.com/view/<slug>-<numeric id>; giphy.com/gifs/<slug>-<id>, media*.giphy.com/media/[<cid>/]<id>/..., i.giphy.com/<id>.gif, giphy.com/embed/<id>
function links(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || "").matchAll(URL_RE)) {
    const provider = m[1].toLowerCase();
    const parts = m[0].split(/[?#]/)[0].split("/").slice(3).filter(Boolean);
    let id = null;
    if (provider === "tenor" && parts[0] === "view" && parts[1]) id = (parts[1].match(/(\d{4,})$/) || [])[1];
    if (provider === "giphy") {
      if (parts[0] === "gifs" && parts[1]) id = parts[1].split("-").pop();
      else if (parts[0] === "media") id = parts.slice(1).find((p) => /^[A-Za-z0-9]{8,24}$/.test(p));
      else if (parts[0] === "embed" && parts[1]) id = parts[1];
      else if (parts.length === 1 && /^[A-Za-z0-9]{8,24}\.\w+$/.test(parts[0])) id = parts[0].split(".")[0];
      if (id && !/^[A-Za-z0-9]{8,24}$/.test(id)) id = null;
    }
    if (!id) continue;
    const key = `${provider}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider, id, url: m[0] });
  }
  return out;
}

// ---------------------------------------------------------------------
// Provider APIs
// ---------------------------------------------------------------------
async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(cfg.timeoutMs) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

async function tenorText(id) {
  const q = new URLSearchParams({ ids: id, key: cfg.tenorKey, client_key: "wordle-classifier" });
  const data = await fetchJson(`https://tenor.googleapis.com/v2/posts?${q}`);
  const post = data.results?.[0];
  if (!post) return "";
  return [post.title, post.h1_title, post.content_description, ...(post.tags || [])].filter(Boolean).join(" \n ");
}

async function giphyText(id) {
  const q = new URLSearchParams({ api_key: cfg.giphyKey });
  const data = await fetchJson(`https://api.giphy.com/v1/gifs/${encodeURIComponent(id)}?${q}`);
  const gif = data.data;
  if (!gif || !gif.id) return "";
  return [gif.title, gif.slug, gif.alt_text, ...(gif.tags || [])].filter(Boolean).join(" \n ");
}

// every tag, title and description for the GIF links in a message, as one text blob ("" when nothing is available)
async function describe(text) {
  const bits = [];
  for (const link of links(text)) {
    const key = `${link.provider}:${link.id}`;
    if (!cache.has(key)) {
      const enabled = link.provider === "tenor" ? cfg.tenorKey : cfg.giphyKey;
      if (!enabled) continue;
      let t = "";
      try { t = link.provider === "tenor" ? await tenorText(link.id) : await giphyText(link.id); }
      catch (e) { console.warn(`GIF tags: ${link.provider} lookup failed for ${link.id}: ${e.message}`); continue; } // not cached, so a transient error is retried next time
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, t);
    }
    if (cache.get(key)) bits.push(cache.get(key));
  }
  return bits.join(" \n ");
}

module.exports = { init, cfg, links, describe, cache };
