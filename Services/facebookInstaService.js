/**
 * facebookInstaService.js
 *
 * Facebook  : multi-strategy chain — getfvid → fdown → mbasic scrape →
 *             snapsave → metadownloader → desktop scrape.
 *             First strategy that yields HD or SD wins.
 *
 * Instagram : snapsave → snapinsta (unchanged from previous version).
 *
 * Why the rewrite:
 *   The old chain led with `metadownloader` (npm) and `snapsave.app/action_download.php`
 *   which both broke when Facebook tightened their rendering and snapsave moved
 *   to an obfuscated response format. The new lead strategies (getfvid, fdown)
 *   are well-known scraping endpoints with stable POST contracts and have been
 *   the recommended path for Node-based Facebook scrapers in 2025–2026.
 */

const axios   = require('axios');
const cheerio = require('cheerio');

let metadownloader;
try {
  metadownloader = require('metadownloader');
} catch (_) {
  metadownloader = null;
  console.warn('⚠️ metadownloader not installed (optional fallback)');
}

// ─── Shared headers ──────────────────────────────────────────────────────────

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const BROWSER_HEADERS = {
  'User-Agent':                UA_DESKTOP,
  Accept:                      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language':           'en-US,en;q=0.9',
  'Accept-Encoding':           'gzip, deflate, br',
  Connection:                  'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest':            'document',
  'Sec-Fetch-Mode':            'navigate',
  'Sec-Fetch-Site':            'none',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function unescapeJsString(s) {
  return s
    .replace(/\\u003C/gi, '<').replace(/\\u003E/gi, '>')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u00[0-9a-f]{2}/gi, m => String.fromCharCode(parseInt(m.slice(2), 16)))
    .replace(/\\\//g, '/').replace(/\\"/g, '"');
}

function decodeCdnUrl(href) {
  if (!href) return '';
  try {
    const u = new URL(href);
    for (const p of ['url', 'u', 'src', 'link', 'media']) {
      const val = u.searchParams.get(p);
      if (val && val.startsWith('http')) {
        const d = decodeURIComponent(val);
        return d.includes('%3A') ? decodeCdnUrl(d) : d;
      }
    }
  } catch (_) {}
  return href;
}

function detectType(url) {
  if (!url) return 'video';
  const p = url.toLowerCase().split('?')[0];
  if (p.match(/\.(mp4|mov|webm|mkv|avi|ts)$/))        return 'video';
  if (p.match(/\.(jpg|jpeg|png|gif|webp|heic|avif)$/)) return 'image';
  if (p.includes('/t16/') || p.includes('/o1/v/') ||
      p.includes('/t50.') || p.includes('/video/'))    return 'video';
  if (p.includes('/t51.') || p.includes('/t39.'))      return 'image';
  return 'video';
}

function isMediaHref(href) {
  if (!href || !href.startsWith('http')) return false;
  const l = href.toLowerCase();
  return (
    l.includes('cdninstagram.com') || l.includes('fbcdn.net') ||
    l.includes('scontent')         || l.includes('snapsave.app') ||
    l.includes('snapinsta.app')    ||
    l.match(/\.(mp4|mov|webm|jpg|jpeg|png|gif|webp)(\?|$)/i) != null
  );
}

const looksLikeFbVideo = (u) =>
  typeof u === 'string' && u.startsWith('http') &&
  (u.includes('fbcdn.net') || /\.mp4(\?|$)/i.test(u));

// ─── Step 1 : resolve share URL to canonical ──────────────────────────────────

async function resolveCanonicalFbUrl(rawUrl) {
  if (
    rawUrl.match(/facebook\.com\/(watch|reel|video)\/\d+/) ||
    rawUrl.match(/facebook\.com\/[^/]+\/videos\/\d+/)      ||
    rawUrl.includes('facebook.com/watch?v=')
  ) return rawUrl;

  const url = rawUrl.replace('m.facebook.com', 'www.facebook.com');
  console.log(`🔗 Resolving: ${url}`);

  try {
    const resp = await axios.get(url, {
      maxRedirects:   20,
      timeout:        15_000,
      validateStatus: () => true,
      headers:        BROWSER_HEADERS,
    });

    const final =
      resp.request?.res?.responseUrl ||
      resp.request?.responseURL      ||
      (resp.config?.url !== url ? resp.config?.url : null);

    if (final && !final.includes('/share/') && final !== url) {
      console.log(`🔗 Resolved → ${final}`);
      try {
        const u = new URL(final);
        const clean = `${u.origin}${u.pathname}`;
        console.log(`🔗 Cleaned → ${clean}`);
        return clean;
      } catch (_) { return final; }
    }

    if (typeof resp.data === 'string' && resp.data.length > 500) {
      const $ = cheerio.load(resp.data);
      const og = $('meta[property="og:url"]').attr('content') || '';
      if (og && og.includes('facebook.com') && !og.includes('/share/')) {
        console.log(`🔗 og:url → ${og}`);
        return og;
      }
    }
  } catch (e) {
    console.warn(`🔗 Redirect failed: ${e.message}`);
  }

  console.warn('🔗 Could not resolve — using original URL');
  return url;
}

// ─── Strategy A : getfvid.com ────────────────────────────────────────────────
//
// POST https://getfvid.com/downloader   (Content-Type: form-urlencoded)
// Body: url=<fb_url>
// Response: HTML with <a href="..."> labelled "Download in HD" / "Download in SD".

async function tryGetfvid(url) {
  const resp = await axios.post(
    'https://getfvid.com/downloader',
    new URLSearchParams({ url }).toString(),
    {
      timeout: 20_000,
      headers: {
        'Content-Type':            'application/x-www-form-urlencoded',
        'User-Agent':              UA_DESKTOP,
        Accept:                    'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language':         'en-US,en;q=0.9',
        Origin:                    'https://getfvid.com',
        Referer:                   'https://getfvid.com/',
        'Upgrade-Insecure-Requests': '1',
      },
      maxRedirects: 5,
    }
  );

  const html = typeof resp.data === 'string' ? resp.data : '';
  if (!html || html.length < 200) throw new Error('getfvid: empty response');

  const $ = cheerio.load(html);
  let hd = '', sd = '';

  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const text = $(a).text().toLowerCase();
    if (!looksLikeFbVideo(href)) return;
    if (!hd && (text.includes('hd') || text.includes('high'))) { hd = href; return; }
    if (!sd && (text.includes('sd') || text.includes('normal') || text.includes('low'))) {
      sd = href; return;
    }
    if (!sd) sd = href;
  });

  if (!hd && !sd) throw new Error('getfvid: no FB video links found');

  const thumbnail = $('img').first().attr('src') || '';
  const title     = $('title').first().text().replace(/getfvid|facebook video|downloader/gi, '').trim()
                    || 'Facebook Video';

  console.log(`📘 getfvid: hd=${hd ? hd.slice(0, 60) : 'none'}  sd=${sd ? sd.slice(0, 60) : 'none'}`);
  return { hd, sd, thumbnail, title };
}

// ─── Strategy B : fdown.net ──────────────────────────────────────────────────
//
// POST https://fdown.net/download.php (form-urlencoded, body URLz=<fb_url>)
// Response: HTML containing #downloadhd and #downloadsd anchors.

async function tryFdown(url) {
  const resp = await axios.post(
    'https://fdown.net/download.php',
    new URLSearchParams({ URLz: url }).toString(),
    {
      timeout: 20_000,
      headers: {
        'Content-Type':    'application/x-www-form-urlencoded',
        'User-Agent':      UA_DESKTOP,
        Accept:            'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
        Origin:            'https://fdown.net',
        Referer:           'https://fdown.net/',
      },
      maxRedirects: 5,
    }
  );

  const html = typeof resp.data === 'string' ? resp.data : '';
  if (!html || html.length < 200) throw new Error('fdown: empty response');

  const $  = cheerio.load(html);
  const hd = $('#downloadhd, a#downloadhd').attr('href') || '';
  const sd = $('#downloadsd, a#downloadsd').attr('href') || '';

  // Some result pages use class-based anchors instead of IDs.
  let hdAlt = hd, sdAlt = sd;
  if (!hdAlt || !sdAlt) {
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const text = $(a).text().toLowerCase();
      if (!looksLikeFbVideo(href)) return;
      if (!hdAlt && text.includes('hd')) hdAlt = href;
      else if (!sdAlt && (text.includes('sd') || text.includes('normal'))) sdAlt = href;
    });
  }

  const finalHd = hd || hdAlt;
  const finalSd = sd || sdAlt;

  if (!finalHd && !finalSd) throw new Error('fdown: no FB video links found');

  const thumbnail = $('.img-thumbnail').first().attr('src') ||
                    $('img').first().attr('src') || '';
  const title     = $('.lead, h2').first().text().trim() || 'Facebook Video';

  console.log(`📘 fdown: hd=${finalHd ? finalHd.slice(0, 60) : 'none'}  sd=${finalSd ? finalSd.slice(0, 60) : 'none'}`);
  return { hd: finalHd, sd: finalSd, thumbnail, title };
}

// ─── Strategy C : mbasic.facebook.com scrape ─────────────────────────────────
//
// The lightweight m-basic frontend of Facebook still serves direct video URLs
// in raw HTML for many public videos, with no login wall. Mobile UA only.

async function tryMbasicScrape(url) {
  // Coerce URL onto the mbasic host
  let target = url
    .replace(/https?:\/\/(www\.|web\.|m\.|mobile\.)?facebook\.com/i, 'https://mbasic.facebook.com')
    .replace(/https?:\/\/fb\.watch/i, 'https://mbasic.facebook.com');

  const resp = await axios.get(target, {
    timeout:        20_000,
    maxRedirects:   10,
    validateStatus: () => true,
    headers: {
      'User-Agent':      UA_MOBILE,
      Accept:            'text/html,application/xhtml+xml,*/*;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const html = typeof resp.data === 'string' ? resp.data : '';
  if (!html || html.length < 500) throw new Error('mbasic: empty response');

  // Look for direct video URLs in HTML
  const mp4Matches = html.match(/https?:\/\/[^"'\s<>]*\.mp4[^"'\s<>]*/gi) || [];
  const fbVideos = [...new Set(mp4Matches)]
    .map(u => unescapeJsString(u).replace(/&amp;/g, '&'))
    .filter(u => u.includes('fbcdn.net') || u.includes('scontent'));

  if (fbVideos.length === 0) throw new Error('mbasic: no .mp4 URLs in HTML');

  // mbasic typically only exposes a single quality (sd-equivalent)
  const $         = cheerio.load(html);
  const thumbnail = $('meta[property="og:image"]').attr('content') ||
                    $('img').first().attr('src') || '';
  const title     = $('meta[property="og:title"]').attr('content') ||
                    $('title').first().text().trim() || 'Facebook Video';

  console.log(`📘 mbasic: found ${fbVideos.length} video URL(s)`);
  return {
    hd:        '', // mbasic rarely has HD
    sd:        fbVideos[0],
    thumbnail,
    title,
  };
}

// ─── Strategy D : snapsave.app (legacy) ──────────────────────────────────────

async function trySnapsave(url) {
  const resp = await axios.post(
    'https://snapsave.app/action_download.php',
    `url=${encodeURIComponent(url)}`,
    {
      timeout: 20_000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   UA_DESKTOP,
        Accept:         '*/*',
        Origin:         'https://snapsave.app',
        Referer:        'https://snapsave.app/',
      },
    }
  );

  const html = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
  const $    = cheerio.load(html);
  let hd = '', sd = '';

  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const text = $(a).text().toLowerCase();
    if (!looksLikeFbVideo(href)) return;
    const real = decodeCdnUrl(href);
    if (!hd && (text.includes('hd') || text.includes('high'))) { hd = real; return; }
    if (!sd) sd = real;
  });

  if (!hd && !sd) {
    $('input').each((_, el) => {
      const val = $(el).attr('value') || '';
      if (!looksLikeFbVideo(val)) return;
      const id = ($(el).attr('id') || '').toLowerCase();
      if (!hd && id.includes('hd')) hd = val; else if (!sd) sd = val;
    });
  }

  if (!hd && !sd) throw new Error('snapsave: no FB video links');

  return {
    hd, sd,
    thumbnail: $('img').first().attr('src') || '',
    title:     'Facebook Video',
  };
}

// ─── Strategy E : metadownloader npm (legacy) ────────────────────────────────

async function tryMetadownloader(url) {
  if (!metadownloader) throw new Error('metadownloader not installed');
  const result = await metadownloader(url);
  if (result && result.status === false) {
    throw new Error(`metadownloader: ${result.msg || 'status false'}`);
  }
  if (!result) throw new Error('metadownloader returned null');
  return result;
}

// ─── Strategy F : direct desktop scrape (legacy) ─────────────────────────────

const FB_REGEXES = [
  { key: 'hd', re: /"browser_native_hd_url"\s*:\s*"([^"]+)"/ },
  { key: 'sd', re: /"browser_native_sd_url"\s*:\s*"([^"]+)"/ },
  { key: 'hd', re: /"hd_src"\s*:\s*"([^"]+)"/ },
  { key: 'sd', re: /"sd_src"\s*:\s*"([^"]+)"/ },
  { key: 'hd', re: /"hd_src_no_ratelimit"\s*:\s*"([^"]+)"/ },
  { key: 'sd', re: /"sd_src_no_ratelimit"\s*:\s*"([^"]+)"/ },
  { key: 'hd', re: /"playable_url_quality_hd"\s*:\s*"([^"]+)"/ },
  { key: 'sd', re: /"playable_url"\s*:\s*"([^"]+)"/ },
];

async function tryDirectScrape(url) {
  const resp = await axios.get(url, {
    timeout: 20_000,
    maxRedirects: 10,
    headers: {
      'User-Agent':      UA_MOBILE,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept:            'text/html,*/*;q=0.8',
    },
  });

  const html = typeof resp.data === 'string' ? resp.data : '';
  if (!html || html.length < 500) throw new Error('Direct scrape: empty response');

  let hd = '', sd = '';
  for (const { key, re } of FB_REGEXES) {
    const m = html.match(re);
    if (m?.[1]) {
      const clean = unescapeJsString(m[1]);
      if (key === 'hd' && !hd && clean.startsWith('http')) hd = clean;
      if (key === 'sd' && !sd && clean.startsWith('http')) sd = clean;
    }
    if (hd && sd) break;
  }

  if (!hd && !sd) throw new Error('Direct scrape: no video URLs (login required)');

  const $ = cheerio.load(html);
  return {
    hd, sd,
    thumbnail: $('meta[property="og:image"]').attr('content') || '',
    title:     $('meta[property="og:title"]').attr('content') || 'Facebook Video',
  };
}

// ─── Facebook entry ──────────────────────────────────────────────────────────

async function downloadFacebook(rawUrl) {
  console.log(`📘 Facebook: starting for ${rawUrl}`);

  const canonical = await resolveCanonicalFbUrl(rawUrl);
  // Canonical first, raw as backup. Dedupe in case they're equal.
  const urls = [...new Set([canonical, rawUrl].filter(Boolean))];

  // Order matters — start with the strategies that are most reliable in 2026.
  const strategies = [
    { name: 'getfvid',         fn: tryGetfvid         },
    { name: 'fdown',           fn: tryFdown           },
    { name: 'mbasic',          fn: tryMbasicScrape    },
    { name: 'snapsave',        fn: trySnapsave        },
    { name: 'metadownloader',  fn: tryMetadownloader  },
    { name: 'direct-scrape',   fn: tryDirectScrape    },
  ];

  const errors = [];

  for (const u of urls) {
    const label = u === rawUrl && u !== canonical ? 'raw' : 'canonical';

    for (const s of strategies) {
      try {
        console.log(`📘 trying ${s.name} [${label}]`);
        const result = await s.fn(u);

        // For metadownloader the result shape is whatever the package returns;
        // for everything else it's { hd, sd, thumbnail, title }.
        if (s.name === 'metadownloader') {
          console.log(`📘 ✅ ${s.name} succeeded`);
          return result;
        }

        if (result && (result.hd || result.sd)) {
          console.log(`📘 ✅ ${s.name} succeeded — has hd:${!!result.hd}  sd:${!!result.sd}`);
          return result;
        }

        errors.push(`${s.name}[${label}]: returned no usable URL`);
      } catch (e) {
        const msg = e.message || String(e);
        console.warn(`📘 ❌ ${s.name} [${label}] — ${msg}`);
        errors.push(`${s.name}[${label}]: ${msg}`);
      }
    }
  }

  throw new Error(`Facebook: all strategies failed.\n${errors.join('\n')}`);
}

// ─── Instagram scrapers (unchanged from previous version) ────────────────────

async function scrapeSnapsave(igUrl) {
  const resp = await axios.post(
    'https://snapsave.app/action_download.php',
    `url=${encodeURIComponent(igUrl)}`,
    {
      timeout: 25_000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   UA_DESKTOP,
        Origin:         'https://snapsave.app',
        Referer:        'https://snapsave.app/',
      },
    }
  );

  const html  = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
  const $     = cheerio.load(html);
  const items = [];
  const seen  = new Set();

  $('table tr, .download-items').each((_, row) => {
    const $r      = $(row);
    const thumb   = $r.find('img').first().attr('src') || '';
    const anchors = [];
    $r.find('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (isMediaHref(href)) anchors.push({ href, text: $(a).text().trim() });
    });
    if (!anchors.length) return;
    const best = anchors.find(a => a.text.toLowerCase().includes('hd')) || anchors[0];
    const real = decodeCdnUrl(best.href);
    if (seen.has(real)) return;
    seen.add(real);
    const type = detectType(best.href);
    items.push({ thumbnail: thumb || (type === 'image' ? real : ''), url: real, type, quality: 'HD' });
  });

  if (!items.length) {
    const thumb = $('img').first().attr('src') || '';
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!isMediaHref(href)) return;
      const real = decodeCdnUrl(href);
      if (seen.has(real)) return;
      seen.add(real);
      items.push({ thumbnail: thumb, url: real, type: detectType(href), quality: 'Original Quality' });
    });
  }

  return items;
}

async function scrapeSnapinsta(igUrl) {
  const resp = await axios.post(
    'https://snapinsta.app/api/ajaxSearch',
    `q=${encodeURIComponent(igUrl)}&t=media&lang=en`,
    {
      timeout: 25_000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   UA_DESKTOP,
        Origin:         'https://snapinsta.app',
        Referer:        'https://snapinsta.app/',
      },
    }
  );

  const html = resp.data?.data || resp.data || '';
  if (!html || typeof html !== 'string') return [];

  const $ = cheerio.load(html);
  const items = [], seen = new Set();

  $('.download-items, .dl-item, .media-wrap').each((_, block) => {
    const $b    = $(block);
    const thumb = $b.find('img').first().attr('src') || '';
    const ancs  = [];
    $b.find('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (isMediaHref(href)) ancs.push({ href, text: $(a).text().trim() });
    });
    if (!ancs.length) return;
    const best = ancs.find(a => a.text.toLowerCase().includes('hd')) || ancs[0];
    const real = decodeCdnUrl(best.href);
    if (seen.has(real)) return;
    seen.add(real);
    items.push({ thumbnail: thumb, url: real, type: detectType(best.href), quality: 'HD' });
  });

  if (!items.length) {
    const thumb = $('img').first().attr('src') || '';
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!isMediaHref(href)) return;
      const real = decodeCdnUrl(href);
      if (seen.has(real)) return;
      seen.add(real);
      items.push({ thumbnail: thumb, url: real, type: detectType(href), quality: 'Original Quality' });
    });
  }

  return items;
}

// ─── Public API ──────────────────────────────────────────────────────────────

async function facebookInsta(url) {
  if (url.includes('facebook.com') || url.includes('fb.watch')) {
    return downloadFacebook(url);
  }

  const errors = [];

  try {
    const items = await scrapeSnapsave(url);
    if (items.length > 0) return { status: true, data: items };
    errors.push('snapsave: 0 items');
  } catch (e) {
    errors.push(`snapsave: ${e.message}`);
  }

  try {
    const items = await scrapeSnapinsta(url);
    if (items.length > 0) return { status: true, data: items };
    errors.push('snapinsta: 0 items');
  } catch (e) {
    errors.push(`snapinsta: ${e.message}`);
  }

  throw new Error(`Instagram: all scrapers failed — ${errors.join(' | ')}`);
}

module.exports = facebookInsta;