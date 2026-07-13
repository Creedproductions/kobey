// Services/twitterService.js
//
// Twitter / X video downloader.
//
// Chain (in priority order — try the next on any failure):
//   1. fxTwitter / FxEmbed   — well-maintained public mirror, JSON
//   2. vxTwitter              — alternative mirror, JSON
//   3. Twitter Syndication    — official cdn.syndication.twimg.com endpoint
//                               with the *computed* token (token=a is no
//                               longer accepted reliably)
//   4. btch-downloader        — last-resort wrapper around scraper services
//
// Tweet ID extraction handles every URL pattern Twitter has used over the
// years: /<user>/status/<id>, /i/status/<id>, /i/web/status/<id>, /statuses/<id>.
// Bare profile URLs (x.com/<username>) return null and we throw a clear
// "no tweet ID" error instead of leaking 500s.

const axios = require('axios');
const ytdlp = require('./ytDlpRunner');

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ─── URL helpers ────────────────────────────────────────────────────────────

const TWITTER_HOST_RE = /^(?:www\.|mobile\.|m\.)?(twitter|x|fxtwitter|vxtwitter|fixupx)\.com$/i;

function isTwitterUrl(input) {
  try {
    return TWITTER_HOST_RE.test(new URL(input).hostname);
  } catch (_) { return false; }
}

function extractTweetId(input) {
  try {
    const u = new URL(input);
    if (!isTwitterUrl(input)) return null;
    // Patterns: /<user>/status/<id>(/photo|video/N)?, /i/(web/)?status/<id>, /statuses/<id>
    const m = u.pathname.match(/\/(?:[^/]+\/)?(?:status(?:es)?|i\/(?:web\/)?status)\/(\d{5,25})/i);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

// Twitter Syndication API now requires a computed token rather than `a`.
// Algorithm reverse-engineered from twitter.com's syndication client.
// Reference: yt-dlp PR #12107.
function syndicationToken(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return 'a';
  return ((n / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

// ─── Strategy 1: fxTwitter / FxEmbed ────────────────────────────────────────

async function tryFxTwitter(tweetId) {
  // Username placeholder `_` works on fxTwitter — only the ID matters.
  const url = `https://api.fxtwitter.com/_/status/${tweetId}`;
  const r = await axios.get(url, {
    timeout: 12000,
    headers: { 'User-Agent': UA_DESKTOP, Accept: 'application/json' },
    validateStatus: () => true,
  });

  if (r.status !== 200 || !r.data) {
    throw new Error(`fxtwitter: HTTP ${r.status}`);
  }

  const tweet = r.data.tweet || r.data;
  const videos = tweet?.media?.videos || [];

  // Photo tweets: users paste /photo/N links constantly (production
  // Telegram alerts showed these misclassified as NOT_FOUND). fxtwitter
  // exposes them under media.photos — return them as image variants when
  // the tweet has no video. `name=orig` requests the full-resolution
  // original instead of the default sized-down variant.
  if (!videos.length) {
    const photos = tweet?.media?.photos || [];
    if (photos.length) {
      return photos.map((p, i) => ({
        quality: p.width && p.height ? `${p.width}x${p.height}` : 'original',
        type:    'image/jpeg',
        url:     p.url + (p.url.includes('?') ? '&' : '?') + 'name=orig',
        index:   i,
      }));
    }
    throw new Error('fxtwitter: no video or photo media in tweet');
  }

  // Sort by resolution desc — first one is highest quality.
  const sorted = [...videos].sort((a, b) =>
    (b.width * b.height || 0) - (a.width * a.height || 0)
  );
  return sorted.map(v => ({
    quality: v.width && v.height ? `${v.width}x${v.height}` : (v.format || 'HD'),
    // fxtwitter's `format` is already a full mime ("video/mp4"); a bare "mp4"
    // gets the video/ prefix. (Previously produced "video/video/mp4".)
    type:    v.format ? (String(v.format).includes('/') ? String(v.format) : `video/${v.format}`) : 'video/mp4',
    url:     v.url,
  }));
}

// ─── Strategy 2: vxTwitter ──────────────────────────────────────────────────

async function tryVxTwitter(tweetId) {
  const url = `https://api.vxtwitter.com/_/status/${tweetId}`;
  const r = await axios.get(url, {
    timeout: 12000,
    headers: { 'User-Agent': UA_DESKTOP, Accept: 'application/json' },
    validateStatus: () => true,
  });

  if (r.status !== 200 || !r.data) {
    throw new Error(`vxtwitter: HTTP ${r.status}`);
  }

  const list = r.data.mediaURLs || [];
  const videos = list.filter(u =>
    typeof u === 'string' && /\.(mp4|m3u8)(\?|$)/i.test(u)
  );
  if (!videos.length) {
    // Photo-tweet fallback: mediaURLs carries pbs.twimg.com image links
    // for photo tweets. Return them as image variants instead of failing.
    const photos = list.filter(u =>
      typeof u === 'string' &&
      (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(u) || u.includes('pbs.twimg.com/media/'))
    );
    if (photos.length) {
      return photos.map((u, i) => ({
        quality: 'original',
        type:    'image/jpeg',
        url:     u + (u.includes('?') ? '&' : '?') + 'name=orig',
        index:   i,
      }));
    }
    throw new Error('vxtwitter: no mp4 or image mediaURLs');
  }

  return videos.map((u, i) => ({
    quality: i === 0 ? 'HD' : 'SD',
    type:    'video/mp4',
    url:     u,
  }));
}

// ─── Strategy 3: Twitter Syndication API ────────────────────────────────────

async function trySyndication(tweetId) {
  // Retry once with a fresh token if the first response is empty — older
  // tokens occasionally serve a 200 with an empty body.
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = syndicationToken(tweetId);
    const url = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${token}&lang=en`;
    const r = await axios.get(url, {
      timeout: 12000,
      headers: {
        'User-Agent': UA_DESKTOP,
        Accept:        'application/json',
        Referer:       'https://platform.twitter.com/',
      },
      validateStatus: () => true,
    });

    if (r.status === 404) throw new Error('syndication: 404 (tweet may be age-restricted or removed)');
    if (r.status !== 200) {
      if (attempt === 0) continue;
      throw new Error(`syndication: HTTP ${r.status}`);
    }
    if (!r.data || typeof r.data !== 'object') {
      if (attempt === 0) continue;
      throw new Error('syndication: empty or non-JSON response');
    }

    const details = r.data.mediaDetails || [];
    const video = details.find(m => m.type === 'video' || m.type === 'animated_gif');
    if (!video) throw new Error('syndication: tweet has no video');

    const variants = (video.video_info?.variants || [])
      .filter(v => v.content_type === 'video/mp4')
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (!variants.length) throw new Error('syndication: no mp4 variants');

    return variants.map(v => ({
      quality: v.bitrate ? `${Math.round(v.bitrate / 1000)}kbps` : 'unknown',
      type:    'video/mp4',
      url:     v.url,
    }));
  }
  throw new Error('syndication: empty response after retry');
}

// ─── Strategy 4: yt-dlp ─────────────────────────────────────────────────────
//
// yt-dlp's Twitter extractor in 2026 ships a syndication-first path that
// works for most public tweets without cookies (login is required only for
// NSFW / protected accounts, which the syndication API also blocks). Used
// as a 4th-position fallback because fxTwitter/vxTwitter are still faster
// (200-500ms) when they work — yt-dlp typically takes 4-8s.

async function tryYtDlpTwitter(rawUrl, cookieFile = null) {
  if (!ytdlp.isAvailable) throw new Error('yt-dlp: binary not installed');
  // Normalise twitter.com → x.com so yt-dlp picks the right extractor.
  // Both work, but x.com is the active canonical and gets fewer redirects.
  const normalised = String(rawUrl).replace(/(?:www\.|mobile\.|m\.)?twitter\.com/i, 'x.com');
  const info = await ytdlp.run(normalised, {
    platform: 'twitter',
    timeoutMs: 22000,
    // 2026-Q3 — user's own session cookies unlock NSFW / protected /
    // age-restricted tweets that the public syndication API blocks.
    cookieFile: cookieFile || undefined,
  });
  const variants = ytdlp.formatTwitterVariants(info);
  if (!variants.length) throw new Error('yt-dlp: no mp4 variants returned');
  return variants;
}

// ─── Strategy 5: btch-downloader (last resort) ──────────────────────────────

async function tryBtchDownloader(rawUrl) {
  let twitter;
  try {
    ({ twitter } = require('btch-downloader'));
  } catch (_) {
    throw new Error('btch: package unavailable');
  }
  const result = await twitter(rawUrl);
  if (!result || (!result.HD && !result.SD)) {
    throw new Error('btch: no HD/SD URLs returned');
  }
  const out = [];
  if (result.HD) out.push({ quality: 'HD', type: 'video/mp4', url: result.HD });
  if (result.SD) out.push({ quality: 'SD', type: 'video/mp4', url: result.SD });
  return out;
}

// ─── Media liveness probe ─────────────────────────────────────────────────
//
// fxTwitter / vxTwitter happily return full metadata (title, thumbnail, and a
// video.twimg.com URL) even after the underlying media FILE has been taken
// down — a DMCA copyright claim or a deleted tweet. The CDN then answers the
// actual byte request with 403 `{"error_code":2,"error_response":"Dmcaed"}`
// (or 404/410). To the app that looks exactly like the reported bug: the
// fetch "succeeds" and formats a filename, then the download silently fails.
//
// A single tiny Range request here catches that up front so we can throw a
// clean, classifiable "no longer available" error (→ NOT_FOUND) instead of a
// false success.
//
// SAFE-BY-DEFAULT: only an explicit DMCA 403 / 404 / 410 on the media file is
// treated as dead. Timeouts, 5xx, other 403s, or any 2xx are treated as LIVE
// so a transient CDN blip can never block a video that actually works — the
// real proxied download then gets its own attempt. Returns:
//   'dmca' | 'deleted'  → confirmed gone (short-circuit)
//   null                → live or inconclusive (proceed)
async function probeMediaRemoved(mediaUrl) {
  try {
    const r = await axios.get(mediaUrl, {
      timeout: 6000,
      headers: {
        'User-Agent': UA_DESKTOP,
        Referer:      'https://twitter.com/',
        Range:        'bytes=0-1',
      },
      responseType:     'text',
      maxContentLength: 8192,   // Range caps this at 2 bytes; guards a no-Range CDN
      validateStatus:   () => true,
    });
    if (r.status === 404 || r.status === 410) return 'deleted';
    if (r.status === 403) {
      const body = typeof r.data === 'string' ? r.data.toLowerCase() : '';
      // Twitter's CDN tags DMCA takedowns with this exact shape. Only treat a
      // 403 as dead when it carries that signature — a bare 403 could be a
      // transient/geo hiccup, so we let those through to the real download.
      if (body.includes('dmca') || body.includes('error_code') || body.includes('error_response')) {
        return 'dmca';
      }
    }
    return null;
  } catch (_) {
    return null; // network blip → assume live, let the real download try
  }
}

// ─── Public entry ───────────────────────────────────────────────────────────

async function downloadTwmateData(rawUrl, opts = {}) {
  console.log(`🐦 Twitter: starting for ${rawUrl}`);
  // 2026-Q3 — per-request user cookies file (NSFW/protected tweets).
  const cookieFile = opts.cookieFile || null;

  const tweetId = extractTweetId(rawUrl);
  if (!tweetId) {
    throw new Error('Invalid Twitter URL - could not extract tweet ID');
  }
  console.log(`🐦 Tweet ID: ${tweetId}`);

  const strategies = [
    ['fxtwitter',    () => tryFxTwitter(tweetId)],
    ['vxtwitter',    () => tryVxTwitter(tweetId)],
    ['syndication',  () => trySyndication(tweetId)],
    // yt-dlp runs before btch because btch wraps the same mirrors we
    // already tried and offers no additional reach; yt-dlp opens up a
    // fresh extraction path (its own syndication-shaped request) — and
    // with the user's cookies it reaches NSFW / protected tweets the
    // public mirrors 404 on.
    ['yt-dlp',       () => tryYtDlpTwitter(rawUrl, cookieFile)],
    ['btch',         () => tryBtchDownloader(rawUrl)],
  ];

  const errors = [];
  for (const [name, fn] of strategies) {
    try {
      console.log(`🐦 Twitter: trying ${name}…`);
      const variants = await fn();
      if (Array.isArray(variants) && variants.length > 0) {
        console.log(`🐦 ✅ ${name} returned ${variants.length} variant(s)`);

        // Verify the media file actually exists before declaring success.
        // Photo variants (pbs.twimg.com) are skipped — the probe targets the
        // video CDN. A confirmed DMCA/deleted result short-circuits the whole
        // chain: no other mirror can resurrect a file the CDN has pulled, and
        // this spares a pointless (slow) yt-dlp fallback.
        const top = variants[0];
        const isVideo = /^video/i.test(String(top?.type || '')) ||
                        /video\.twimg\.com|\.mp4(\?|$)/i.test(String(top?.url || ''));
        if (isVideo && top?.url) {
          const dead = await probeMediaRemoved(top.url);
          if (dead) {
            console.warn(`🐦 ⚠ ${name} URL not downloadable (${dead}) — media removed`);
            throw Object.assign(
              new Error(dead === 'dmca'
                ? 'This X/Twitter video was removed due to a copyright (DMCA) claim and is no longer available'
                : 'This X/Twitter video is no longer available — the tweet was deleted or removed'),
              { _removed: true },
            );
          }
        }

        return variants;
      }
      errors.push(`${name}: empty result`);
    } catch (e) {
      // A confirmed removal is terminal — stop trying mirrors and surface the
      // clean message straight to the classifier (→ NOT_FOUND).
      if (e && e._removed) throw e;
      const msg = e.message || String(e);
      console.warn(`🐦 ❌ ${name}: ${msg.slice(0, 120)}`);
      errors.push(`${name}: ${msg}`);
    }
  }

  throw new Error(
    'Twitter download failed - no video or photo media found - tweet may be ' +
    `private, deleted, or region-locked. Tried: ${errors.join(' | ')}`
  );
}

module.exports = {
  downloadTwmateData,
  extractTweetId,
  isTwitterUrl,
};
