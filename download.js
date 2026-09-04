const MEDIA_HOSTS = new Set([
  "cdn.discordapp.com", "media.discordapp.net", "media.tenor.com",
  "media.giphy.com", "i.giphy.com", "i.imgur.com",
]);

/** @param {AsyncIterable<Uint8Array>} stream @param {number} maxBytes @returns {Promise<Buffer>} */
async function readLimited(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`content exceeds ${maxBytes} byte limit`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** @param {string} url @param {object} options @returns {Promise<Buffer>} */
async function download(url, { maxBytes = 32_000_000, fetchImpl = fetch, allowedHosts = MEDIA_HOSTS } = {}) {
  const signal = AbortSignal.timeout(30_000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443") || !allowedHosts.has(parsed.hostname)) {
      throw new Error("media URL is not on an approved HTTPS host");
    }
    const response = await fetchImpl(url, { redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("redirect has no destination");
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`media download returned ${response.status}`); }
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw new Error("media exceeds download byte limit");
    }
    if (!response.body) throw new Error("media download has no body");
    return readLimited(response.body, maxBytes);
  }
  throw new Error("media redirect limit exceeded");
}

module.exports = { download, readLimited, MEDIA_HOSTS };
