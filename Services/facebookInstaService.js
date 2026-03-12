/**
 * facebookInstaService.js
 *
 * Facebook: resolve share/redirect URL first, then metadownloader,
 *           with snapsave + direct-scrape as fallbacks.
 * Instagram: snapsave → snapinsta
 */

const axios   = require('axios');
const cheerio = require('cheerio');

let metadownloader;
try {
  metadownloader = require('metadownloader');
} catch (_) {
  metadownloader = null;
  console.warn('⚠️ metadownloader not installed');
}

// ─── shared headers ───────────────────────────────────────────────────────────

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language':           'en-US,en;q=0.9',
  'Accept-Encoding':           'gzip, deflate, br',
  Connection:                  'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest':            'document',
  'Sec-Fetch-Mode':            'navigate',
  'Sec-Fetch-Site':            'none',
};

// ─── helpers ──────────────────────────────────────────────────────────────────

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

// ─── Step 1 : resolve share URL to canonical ──────────────────────────────────
//
// share/r/TOKEN is a short-link that 302-redirects to the real reel/video URL.
// We follow the redirect and also check og:url in the page as a backup.

async function resolveCanonicalFbUrl(rawUrl) {
  // Already canonical
  if (
    rawUrl.match(/facebook\.com\/(watch|reel|video)\/\d+/) ||
    rawUrl.match(/facebook\.com\/[^/]+\/videos\/\d+/)      ||
    rawUrl.includes('facebook.com/watch?v=')
  ) return rawUrl;

  const url = rawUrl.replace('m.facebook.com', 'www.facebook.com');
  console.log(`🔗 Resolving: ${url}`);

  try {
    const resp = await axios.get(url, {
      maxRedirects: 20,
      timeout:      15_000,
      validateStatus: () => true,
      headers: BROWSER_HEADERS,
    });

    // Final URL after all redirects
    const final =
      resp.request?.res?.responseUrl ||
      resp.request?.responseURL      ||
      (resp.config?.url !== url ? resp.config?.url : null);

    if (final && !final.includes('/share/') && final !== url) {
      console.log(`🔗 Resolved → ${final}`);
      // Strip tracking params, keep core reel/video path
      try {
        const u = new URL(final);
        const clean = `${u.origin}${u.pathname}`;
        console.log(`🔗 Cleaned → ${clean}`);
        return clean;
      } catch (_) { return final; }
    }

    // Fallback: og:url meta tag
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

// ─── Strategy A : metadownloader (npm) ────────────────────────────────────────
//
// This was working before. We now pass the CANONICAL URL (after redirect),
// not the raw share/r/TOKEN URL — that was causing the `.split` crash.

async function tryMetadownloader(url) {
  if (!metadownloader) throw new Error('metadownloader not installed');

  const result = await metadownloader(url);
  console.log('📘 metadownloader keys:', Object.keys(result || {}));

  // The package returns { status: false, msg } on error
  if (result && result.status === false) {
    throw new Error(`metadownloader: ${result.msg || 'status false'}`);
  }

  if (!result) throw new Error('metadownloader returned null');

  return result; // caller (normaliseFacebookData) handles all shapes
}

// ─── Strategy B : snapsave.app ────────────────────────────────────────────────

async function trySnapsave(url) {
  const resp = await axios.post(
    'https://snapsave.app/action_download.php',
    `url=${encodeURIComponent(url)}`,
    {
      timeout: 20_000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   BROWSER_HEADERS['User-Agent'],
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
    if (!href.includes('fbcdn.net') && !href.match(/\.mp4/i)) return;
    const real = decodeCdnUrl(href);
    if (!hd && (text.includes('hd') || text.includes('high'))) { hd = real; return; }
    if (!sd) sd = real;
  });

  if (!hd && !sd) {
    $('input').each((_, el) => {
      const val = $(el).attr('value') || '';
      if (!val.includes('fbcdn.net') && !val.match(/\.mp4/i)) return;
      const id = ($(el).attr('id') || '').toLowerCase();
      if (!hd && id.includes('hd')) hd = val; else if (!sd) sd = val;
    });
  }

  console.log(`📘 snapsave: hd=${hd.slice(0,70)} sd=${sd.slice(0,70)}`);
  if (!hd && !sd) throw new Error('snapsave: no FB video links');

  return { hd, sd, thumbnail: $('img').first().attr('src') || '', title: 'Facebook Video' };
}

// ─── Strategy C : direct HTML scrape ─────────────────────────────────────────

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
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,*/*;q=0.8',
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

// ─── Facebook entry ───────────────────────────────────────────────────────────

async function downloadFacebook(rawUrl) {
  console.log(`📘 Facebook: starting for ${rawUrl}`);

  const canonical = await resolveCanonicalFbUrl(rawUrl);
  const urls      = [...new Set([canonical, rawUrl])]; // try canonical first, then raw

  const errors = [];

  for (const u of urls) {
    const label = u === rawUrl && u !== canonical ? 'raw' : 'canonical';

    // A: metadownloader (the one that was working before)
    try {
      console.log(`📘 trying metadownloader [${label}]: ${u}`);
      const result = await tryMetadownloader(u);
      console.log('✅ metadownloader succeeded');
      return result;
    } catch (e) {
      console.warn(`📘 metadownloader [${label}] failed: ${e.message}`);
      errors.push(`metadownloader[${label}]: ${e.message}`);
    }

    // B: snapsave
    try {
      console.log(`📘 trying snapsave [${label}]`);
      const result = await trySnapsave(u);
      console.log('✅ snapsave succeeded');
      // Wrap into shape normaliseFacebookData understands
      return { sd: result.sd, hd: result.hd, thumbnail: result.thumbnail, title: result.title };
    } catch (e) {
      console.warn(`📘 snapsave [${label}] failed: ${e.message}`);
      errors.push(`snapsave[${label}]: ${e.message}`);
    }

    // C: direct scrape
    try {
      console.log(`📘 trying direct-scrape [${label}]`);
      const result = await tryDirectScrape(u);
      console.log('✅ direct-scrape succeeded');
      return { sd: result.sd, hd: result.hd, thumbnail: result.thumbnail, title: result.title };
    } catch (e) {
      console.warn(`📘 direct-scrape [${label}] failed: ${e.message}`);
      errors.push(`direct-scrape[${label}]: ${e.message}`);
    }
  }

  throw new Error(`Facebook: all methods failed.\n${errors.join('\n')}`);
}

// ─── Instagram scrapers ───────────────────────────────────────────────────────

async function scrapeSnapsave(igUrl) {
  const resp = await axios.post(
    'https://snapsave.app/action_download.php',
    `url=${encodeURIComponent(igUrl)}`,
    {
      timeout: 25_000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   BROWSER_HEADERS['User-Agent'],
        Origin:         'https://snapsave.app',
        Referer:        'https://snapsave.app/',
      },
    }
  );

  const html     = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
  const $        = cheerio.load(html);
  const items    = [];
  const seen     = new Set();

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
        'User-Agent':   BROWSER_HEADERS['User-Agent'],
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

// ─── public API ───────────────────────────────────────────────────────────────

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