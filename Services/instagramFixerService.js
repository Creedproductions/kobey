'use strict';

// Instagram via public "embed fixer" services.
//
// Why (2026-11): Instagram refuses signed-out requests from Koyeb's datacenter
// IP (polaris graphql → null, yt-dlp → login wall) and igdl's backend hangs.
// Embed fixers (the services that make IG links preview in Discord/Telegram)
// fetch the post from THEIR infrastructure and answer with a plain 302 to the
// real cdninstagram.com file — so our IP never talks to instagram.com.
//
// Providers (all independent operators; verified 2026-11-16):
//   InstaFix-style   GET https://<host>/videos/<code>/<n>   (n = 1-based)
//       instagramfix.com, eeinstagram.com, toinstagram.com
//       302 → media file (mp4 OR jpg for photo items); 200 → no such item.
//   vxinstagram.com  GET /offload/<code>/<i>                (i = 0-based)
//       302 → media file; past the end it repeats the last item.
//   kkinstagram.com  GET /reel/<code>/  (bot UA only) → 302 → video (single).
//
// The returned CDN URLs are signed by path+query, not by host, so ISP-edge
// hosts (instagram.xxx.fna.fbcdn.net) get their HOST swapped for
// scontent.cdninstagram.com, which is reachable from anywhere. The query must
// stay byte-identical (changing _nc_ht → 403).

const axios = require('axios');

const UA = 'Mozilla/5.0 (compatible; UnisaverServer/1.0)';
const BOT_UA = 'TelegramBot (like TwitterBot)';
const MAX_ITEMS = 20;

const INSTAFIX_HOSTS = ['instagramfix.com', 'eeinstagram.com', 'toinstagram.com'];

function parseUrl(url) {
  const m = String(url || '').match(
    /instagram\.com\/(?:[^/?#]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i,
  );
  if (!m) return null;
  return { kind: m[1].toLowerCase(), shortcode: m[2] };
}

// Location header → clean, globally reachable CDN URL (or null).
function normalizeMediaUrl(loc) {
  if (!loc) return null;
  let s = String(loc).trim();
  // toinstagram wraps the target: https://cp.toinstagram.com/https://scontent…
  const inner = s.match(/^https?:\/\/[^/]+\/(https?:\/\/.+)$/i);
  if (inner) s = inner[1];
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (!/(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(host)) return null;
  if (/\.fna\.fbcdn\.net$/.test(host)) {
    // Swap ONLY the host. The query (incl. _nc_ht) is part of the signature —
    // touching it turns the URL into a 403.
    return s.replace(/^(https?:\/\/)[^/]+/i, '$1scontent.cdninstagram.com');
  }
  return s;
}

const mediaKey = (url) => { try { return new URL(url).pathname; } catch (_) { return url; } };
const typeOf = (url) => (/\.mp4$/i.test(mediaKey(url)) ? 'video' : 'image');

// GET without following redirects; resolve to the normalized Location or null.
async function resolveRedirect(url, { timeoutMs, ua = UA }) {
  const resp = await axios.get(url, {
    timeout: timeoutMs,
    maxRedirects: 0,
    responseType: 'stream',
    validateStatus: () => true,
    headers: { 'User-Agent': ua, Accept: '*/*' },
  });
  try { resp.data?.destroy?.(); } catch (_) { /* ignore */ }
  if (resp.status >= 300 && resp.status < 400) {
    return normalizeMediaUrl(resp.headers?.location);
  }
  if (resp.status >= 500 || resp.status === 429 || resp.status === 403) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return null; // 200/404 → no such item
}

function toItems(urls) {
  const seen = new Set();
  const items = [];
  for (const u of urls) {
    if (!u) continue;
    const k = mediaKey(u);
    if (seen.has(k)) continue;
    seen.add(k);
    const type = typeOf(u);
    items.push({ url: u, type, thumbnail: type === 'image' ? u : '' });
  }
  return items;
}

// Probe indexes [from..to] in parallel, return the contiguous run of hits.
async function probeRange(makeUrl, from, to, opts) {
  const idx = [];
  for (let i = from; i <= to; i++) idx.push(i);
  const res = await Promise.all(idx.map(i => resolveRedirect(makeUrl(i), opts).catch(() => null)));
  const out = [];
  for (const r of res) { if (!r) break; out.push(r); }
  return out;
}

// ── InstaFix-style host ─────────────────────────────────────────────────────
async function viaInstaFix(host, { shortcode, single }, opts) {
  const make = (n) => `https://${host}/videos/${shortcode}/${n}`;
  const first = await resolveRedirect(make(1), opts);
  if (!first) throw new Error(`${host}: no media for ${shortcode}`);
  if (single) return toItems([first]);

  // Probe the rest of the carousel. (instagramfix.com's JSON endpoint caps
  // media_attachments at 4, so it can't be trusted for the item count.)
  let urls = [first];
  const more = await probeRange(make, 2, 10, opts);
  urls = urls.concat(more);
  if (more.length === 9) urls = urls.concat(await probeRange(make, 11, MAX_ITEMS, opts));
  return toItems(urls);
}

// ── vxinstagram (0-based, repeats the last item past the end) ───────────────
async function viaVx({ shortcode, single }, opts) {
  const make = (i) => `https://vxinstagram.com/offload/${shortcode}/${i}`;
  const first = await resolveRedirect(make(0), opts);
  if (!first) throw new Error(`vxinstagram: no media for ${shortcode}`);
  if (single) return toItems([first]);
  const more = await probeRange(make, 1, 9, opts);
  return toItems([first, ...more]); // toItems() drops the repeated tail
}

// ── kkinstagram (single item, answers only to link-preview bots) ────────────
async function viaKk({ shortcode, kind }, opts) {
  const path = kind === 'p' ? 'p' : 'reel';
  const loc = await resolveRedirect(
    `https://kkinstagram.com/${path}/${shortcode}/`, { ...opts, ua: BOT_UA },
  );
  if (!loc) throw new Error(`kkinstagram: no media for ${shortcode}`);
  return toItems([loc]);
}

/**
 * Resolve an Instagram post/reel through the embed-fixer pool.
 * Providers start staggered (so the first healthy one usually answers alone)
 * and the first to return items wins.
 *
 * @param {string} url
 * @param {{timeoutMs?:number, isCancelled?:()=>boolean, staggerMs?:number, exclude?:string[]}} [o]
 * @returns {Promise<{items:Array<{url,type,thumbnail}>, source:string}>}
 */
async function fetchInstagramViaFixers(url, o = {}) {
  const parsed = parseUrl(url);
  if (!parsed) throw new Error('fixers: cannot extract shortcode');
  const single = parsed.kind !== 'p';
  const ctx = { ...parsed, single };
  const opts = { timeoutMs: o.timeoutMs || 8000 };
  const staggerMs = o.staggerMs ?? 1200;
  const cancelled = () => (typeof o.isCancelled === 'function' ? !!o.isCancelled() : false);

  const providers = [
    ['instagramfix', () => viaInstaFix('instagramfix.com', ctx, opts)],
    ['eeinstagram',  () => viaInstaFix('eeinstagram.com', ctx, opts)],
    ['vxinstagram',  () => viaVx(ctx, opts)],
    ['toinstagram',  () => viaInstaFix('toinstagram.com', ctx, opts)],
  ];
  // kk returns one item only → useful for single-video URLs.
  if (single) providers.push(['kkinstagram', () => viaKk(ctx, opts)]);
  // Caller can drop providers whose result it already rejected.
  const exclude = new Set(o.exclude || []);
  for (let i = providers.length - 1; i >= 0; i--) {
    if (exclude.has(providers[i][0])) providers.splice(i, 1);
  }
  if (!providers.length) throw new Error('fixers: no providers left');

  return new Promise((resolve, reject) => {
    let done = false;
    let settled = 0;
    const errors = [];
    const timers = [];
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      fn(v);
    };
    providers.forEach(([name, run], i) => {
      timers.push(setTimeout(() => {
        if (done) return;
        if (cancelled()) {
          errors.push(`${name}: skipped (cancelled)`);
          if (++settled === providers.length) finish(reject, new Error(`fixers: ${errors.join('; ')}`));
          return;
        }
        Promise.resolve().then(run).then(
          (items) => {
            if (Array.isArray(items) && items.length) {
              finish(resolve, { items, source: `fixer:${name}` });
              return;
            }
            throw new Error(`${name}: empty`);
          },
        ).catch((e) => {
          errors.push(`${name}: ${String(e?.message || e).replace(new RegExp(`^${name}[^:]*:\\s*`), '')}`);
          settled++;
          if (settled === providers.length) {
            finish(reject, new Error(`fixers: ${errors.join('; ')}`));
          }
        });
      }, i * staggerMs));
    });
  });
}

// Best-effort cover image for item n (1-based). eeinstagram's /images/ route
// answers with the JPG cover even for video items. Never throws.
async function fetchFixerThumbnail(url, n = 1, timeoutMs = 2500) {
  try {
    const p = parseUrl(url);
    if (!p) return '';
    const loc = await resolveRedirect(
      `https://eeinstagram.com/images/${p.shortcode}/${n}`, { timeoutMs },
    );
    return loc && typeOf(loc) === 'image' ? loc : '';
  } catch (_) {
    return '';
  }
}

module.exports = {
  fetchInstagramViaFixers,
  fetchFixerThumbnail,
  normalizeMediaUrl,
  _providers: { viaInstaFix, viaVx, viaKk, parseUrl, INSTAFIX_HOSTS },
};

// ── CLI probe: node Services/instagramFixerService.js <url> [<url>…] ────────
// Runs EVERY provider separately and range-GETs the first result, to check
// which ones work from the current machine/IP.
if (require.main === module) {
  (async () => {
    const urls = process.argv.slice(2);
    const opts = { timeoutMs: 10000 };
    for (const url of urls) {
      const p = parseUrl(url);
      const ctx = { ...p, single: p.kind !== 'p' };
      console.log(`\n== ${p.kind}/${p.shortcode}`);
      const runs = [
        ...INSTAFIX_HOSTS.map(h => [h, () => viaInstaFix(h, ctx, opts)]),
        ['vxinstagram.com', () => viaVx(ctx, opts)],
        ['kkinstagram.com', () => viaKk(ctx, opts)],
      ];
      await Promise.all(runs.map(async ([name, run]) => {
        const t = Date.now();
        try {
          const items = await run();
          let media = '';
          try {
            const r = await axios.get(items[0].url, {
              timeout: 10000, validateStatus: () => true, responseType: 'stream',
              headers: { Range: 'bytes=0-1023', 'User-Agent': UA, Referer: 'https://www.instagram.com/' },
            });
            r.data.destroy();
            media = `cdn=${r.status} ${r.headers['content-type']} host=${new URL(items[0].url).hostname}`;
          } catch (e) { media = `cdn ERR ${e.message}`; }
          console.log(`  OK  ${name} ${Date.now() - t}ms n=${items.length} [${items.map(i => i.type[0]).join('')}] ${media}`);
        } catch (e) {
          console.log(`  ERR ${name} ${Date.now() - t}ms ${e.message}`);
        }
      }));
      const t = Date.now();
      try {
        const r = await fetchInstagramViaFixers(url);
        console.log(`  POOL → ${r.source} n=${r.items.length} in ${Date.now() - t}ms`);
      } catch (e) { console.log(`  POOL ERR ${e.message}`); }
    }
  })();
}
