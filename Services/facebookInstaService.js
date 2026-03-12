/**
 * facebookInstaService.js
 *
 * Facebook strategy chain (in order):
 *   1. Resolve share/redirect URLs → canonical FB URL  (HTTP redirect follow)
 *   2. cobalt.tools API            (most reliable, no auth needed)
 *   3. @mrnima/facebook-downloader (npm)
 *   4. fdown.net scraper           (HTTP scrape)
 *   5. Direct Facebook HTML scrape (regex on page source)
 *
 * Instagram strategy chain:
 *   1. snapsave.app scraper
 *   2. snapinsta.app scraper
 *
 * Return shape (Facebook success):
 *   { hd, sd, thumbnail, title }
 *   — normalised by downloaderController.normaliseFacebookData()
 *
 * Return shape (Instagram success):
 *   { status: true, data: [ { thumbnail, url, type, quality } … ] }
 */

const axios   = require('axios');
const cheerio = require('cheerio');

// ─── optional deps ────────────────────────────────────────────────────────────

let mrnima;
try {
  mrnima = require('@mrnima/facebook-downloader');
} catch (_) {
  mrnima = null;
  console.warn('⚠️  @mrnima/facebook-downloader not installed — skipping that strategy');
}

// ─── shared axios instance ────────────────────────────────────────────────────

const http = axios.create({
  timeout: 30_000,
  maxRedirects: 15,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language':            'en-US,en;q=0.5',
    'Accept-Encoding':            'gzip, deflate, br',
    Connection:                   'keep-alive',
    'Upgrade-Insecure-Requests':  '1',
  },
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function decodeCdnUrl(href) {
  if (!href) return '';
  try {
    const u = new URL(href);
    for (const param of ['url', 'u', 'src', 'link', 'media']) {
      const val = u.searchParams.get(param);
      if (val && val.startsWith('http')) {
        const decoded = decodeURIComponent(val);
        if (decoded.includes('%3A')) return decodeCdnUrl(decoded);
        return decoded;
      }
    }
  } catch (_) {}
  return href;
}

function detectType(url) {
  if (!url) return 'video';
  try {
    const u   = new URL(url);
    const ext = (u.searchParams.get('ext') || '').toLowerCase();
    if (['mp4','mov','webm','mkv','avi','ts'].includes(ext))            return 'video';
    if (['jpg','jpeg','png','gif','webp','heic','avif'].includes(ext))  return 'image';
  } catch (_) {}
  const p = url.toLowerCase().split('?')[0];
  if (p.match(/\.(mp4|mov|webm|mkv|avi|ts)$/))         return 'video';
  if (p.match(/\.(jpg|jpeg|png|gif|webp|heic|avif)$/)) return 'image';
  if (p.includes('/t16/') || p.includes('/o1/v/') ||
      p.includes('/t50.') || p.includes('/video/'))     return 'video';
  if (p.includes('/t51.') || p.includes('/t39.'))       return 'image';
  const decoded = decodeCdnUrl(url);
  if (decoded !== url) return detectType(decoded);
  return 'video';
}

function qualityFromText(txt) {
  const t = (txt || '').toLowerCase();
  if (t.includes('hd') || t.includes('high')) return 'HD';
  if (t.includes('sd') || t.includes('low'))  return 'SD';
  return 'Original Quality';
}

function isMediaHref(href) {
  if (!href || !href.startsWith('http')) return false;
  const lower = href.toLowerCase();
  return (
    lower.includes('cdninstagram.com') ||
    lower.includes('fbcdn.net')        ||
    lower.includes('scontent')         ||
    lower.includes('snapsave.app')     ||
    lower.includes('snapinsta.app')    ||
    lower.match(/\.(mp4|mov|webm|jpg|jpeg|png|gif|webp)(\?|$)/i) != null
  );
}

function unescapeJsString(s) {
  return s
    .replace(/\\u003C/gi, '<').replace(/\\u003E/gi, '>')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u00[0-9a-f]{2}/gi, m => String.fromCharCode(parseInt(m.slice(2), 16)))
    .replace(/\\\//g, '/').replace(/\\"/g, '"');
}

// ─── Step 1 : Resolve canonical URL ──────────────────────────────────────────
//
// facebook.com/share/r/TOKEN  →  must follow redirect — TOKEN ≠ reel ID
// fb.watch/TOKEN              →  always redirects
// m.facebook.com              →  normalise to www
//
// We do a full GET (not HEAD) because many FB share links do a JS redirect
// which axios follows via Location headers.  If the resolved URL still looks
// like a share URL we return it anyway — cobalt will handle it.

async function resolveCanonicalFbUrl(rawUrl) {
  // Already canonical — fast exit
  if (
    rawUrl.match(/facebook\.com\/(watch|reel|video)\//) ||
    rawUrl.match(/facebook\.com\/[^/]+\/videos\/\d+/)   ||
    rawUrl.includes('facebook.com/watch?')
  ) {
    return rawUrl;
  }

  // Normalise mobile → desktop
  const url = rawUrl.replace('m.facebook.com', 'www.facebook.com');

  console.log(`🔗 Resolving redirect: ${url}`);

  // Try GET first (HEAD often blocked)
  for (const method of ['get', 'head']) {
    try {
      const resp = await axios[method](url, {
        maxRedirects: 15,
        timeout:      15_000,
        validateStatus: () => true,
        headers: {
          'User-Agent': http.defaults.headers['User-Agent'],
          Accept: 'text/html,*/*;q=0.8',
        },
      });

      const final =
        resp.request?.res?.responseUrl ||
        resp.request?.responseURL      ||
        (resp.config && resp.config.url !== url ? resp.config.url : null);

      if (final && final !== url && !final.includes('/share/')) {
        console.log(`🔗 Resolved (${method.toUpperCase()}) → ${final}`);
        return final;
      }
    } catch (_) {}
  }

  console.warn(`🔗 Could not resolve redirect — proceeding with original URL`);
  return url;
}

// ─── Strategy 2 : cobalt.tools API ───────────────────────────────────────────
//
// Cobalt handles FB reels, watch, share links natively.
// API docs: https://github.com/imputnet/cobalt

async function tryCobalt(url) {
  const resp = await axios.post(
    'https://api.cobalt.tools/',
    { url, videoQuality: 'max', filenameStyle: 'pretty' },
    {
      timeout: 25_000,
      headers: {
        'Content-Type': 'application/json',
        Accept:         'application/json',
      },
    }
  );

  const data = resp.data;
  console.log(`🌐 cobalt status=${data.status}`);

  if (data.status === 'stream' || data.status === 'redirect') {
    if (!data.url) throw new Error('cobalt: no URL in stream/redirect response');
    return { hd: data.url, sd: data.url, thumbnail: '', title: 'Facebook Video' };
  }

  if (data.status === 'picker' && Array.isArray(data.picker) && data.picker.length > 0) {
    // picker = multiple qualities or items; pick best (usually first)
    const best = data.picker.find(p => p.type === 'video') || data.picker[0];
    return {
      hd:        best.url || '',
      sd:        data.picker[data.picker.length - 1]?.url || best.url || '',
      thumbnail: best.thumb || '',
      title:     'Facebook Video',
    };
  }

  if (data.status === 'error') {
    throw new Error(`cobalt error: ${data.error?.code || data.text || 'unknown'}`);
  }

  throw new Error(`cobalt: unexpected status "${data.status}"`);
}

// ─── Strategy 3 : @mrnima/facebook-downloader ────────────────────────────────

async function tryMrnima(url) {
  if (!mrnima) throw new Error('@mrnima/facebook-downloader not installed');

  const result = await mrnima.facebook(url);
  console.log('📘 mrnima raw:', JSON.stringify(result || {}).slice(0, 300));

  if (!result || !result.status) {
    throw new Error(`@mrnima failed: ${result?.msg || 'status false'}`);
  }

  const links = result.result?.links || {};
  const hd    = links.HD || links.hd || '';
  const sd    = links.SD || links.sd || '';
  const thumb = result.result?.thumbnail || '';

  if (!hd && !sd) throw new Error('@mrnima returned no video links');
  return { hd, sd, thumbnail: thumb, title: result.result?.title || 'Facebook Video' };
}

// ─── Strategy 4 : fdown.net scraper ──────────────────────────────────────────

async function tryFdown(url) {
  const resp = await http.post(
    'https://fdown.net/download.php',
    `URLz=${encodeURIComponent(url)}`,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin:  'https://fdown.net',
        Referer: 'https://fdown.net/',
      },
    }
  );

  const html = typeof resp.data === 'string' ? resp.data : '';
  if (!html) throw new Error('fdown.net: empty response');

  const $   = cheerio.load(html);
  let hd = '', sd = '';

  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const text = $(a).text().toLowerCase();
    if (!href.includes('fbcdn.net') && !href.match(/\.mp4/i)) return;
    if (!hd && (text.includes('hd') || text.includes('high') || $(a).closest('[id*="HD"]').length))
      hd = href;
    else if (!sd && (text.includes('sd') || text.includes('low') || text.includes('normal')))
      sd = href;
    else if (!sd)
      sd = href;
  });

  // Fallback: <input type="text"> embeds
  if (!hd && !sd) {
    $('input[type="text"]').each((_, el) => {
      const val = $(el).attr('value') || '';
      if (!val.includes('fbcdn.net') && !val.match(/\.mp4/i)) return;
      const id = ($(el).attr('id') || '').toLowerCase();
      if (id.includes('hd') && !hd) hd = val;
      else if (!sd) sd = val;
    });
  }

  console.log(`📘 fdown: hd=${hd.slice(0,60)} sd=${sd.slice(0,60)}`);
  if (!hd && !sd) throw new Error('fdown.net: no video URLs found');

  return {
    hd,
    sd,
    thumbnail: $('img').first().attr('src') || '',
    title:     $('title').text().trim() || 'Facebook Video',
  };
}

// ─── Strategy 5 : Direct Facebook HTML scrape ────────────────────────────────

const FB_VIDEO_REGEXES = [
  { key: 'hd', re: /"browser_native_hd_url"\s*:\s*"([^"]+)"/ },
  { key: 'sd', re: /"browser_native_sd_url"\s*:\s*"([^"]+)"/ },
  { key: 'hd', re: /"hd_src"\s*:\s*"([^"]+)"/ },
  { key: 'sd', re: /"sd_src"\s*:\s*"([^"]+)"/ },
  { key: 'hd', re: /"hd_src_no_ratelimit"\s*:\s*"([^"]+)"/ },
  { key: 'sd', re: /"sd_src_no_ratelimit"\s*:\s*"([^"]+)"/ },
  { key: 'hd', re: /"playable_url_quality_hd"\s*:\s*"([^"]+)"/ },
  { key: 'sd', re: /"playable_url"\s*:\s*"([^"]+)"/ },
];

async function tryDirectHtmlScrape(url) {
  const resp = await http.get(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const html = typeof resp.data === 'string' ? resp.data : '';
  if (!html || html.length < 500)
    throw new Error('Direct scrape: empty or too-short response — likely blocked');

  let hd = '', sd = '';
  for (const { key, re } of FB_VIDEO_REGEXES) {
    const m = html.match(re);
    if (m && m[1]) {
      const clean = unescapeJsString(m[1]);
      if (key === 'hd' && !hd && clean.startsWith('http')) hd = clean;
      if (key === 'sd' && !sd && clean.startsWith('http')) sd = clean;
    }
    if (hd && sd) break;
  }

  console.log(`📘 Direct scrape: hd=${hd.slice(0,60)} sd=${sd.slice(0,60)}`);
  if (!hd && !sd)
    throw new Error('Direct scrape: no video URLs — page may require login');

  const $ = cheerio.load(html);
  return {
    hd,
    sd,
    thumbnail:
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="og:image"]').attr('content') || '',
    title:
      $('meta[property="og:title"]').attr('content') ||
      $('title').text().trim() || 'Facebook Video',
  };
}

// ─── Facebook main entry ──────────────────────────────────────────────────────

async function downloadFacebook(rawUrl) {
  console.log(`📘 Facebook: starting for ${rawUrl}`);

  // Step 1: resolve redirect / share URL → canonical
  const canonicalUrl = await resolveCanonicalFbUrl(rawUrl);

  const errors   = [];
  const urlsToTry = [...new Set([canonicalUrl, rawUrl])]; // deduped

  // Build attempt list: try all strategies on canonical URL first,
  // then fall back to original URL if it differs.
  const attempts = [];
  for (const u of urlsToTry) {
    const suffix = u === rawUrl && u !== canonicalUrl ? '-orig' : '';
    attempts.push(
      { name: `cobalt${suffix}`,      fn: () => tryCobalt(u) },
      { name: `@mrnima${suffix}`,     fn: () => tryMrnima(u) },
      { name: `fdown${suffix}`,       fn: () => tryFdown(u)  },
      { name: `direct-html${suffix}`, fn: () => tryDirectHtmlScrape(u) },
    );
  }

  for (const { name, fn } of attempts) {
    try {
      console.log(`📘 Facebook: trying [${name}]`);
      const result = await fn();
      console.log(`✅ Facebook: [${name}] succeeded`);

      // Normalise to the shape downloaderController.normaliseFacebookData() expects
      if (result && (result.hd || result.sd) && !result.data && !result.media) {
        return {
          hd:        result.hd        || '',
          sd:        result.sd        || '',
          title:     result.title     || 'Facebook Video',
          thumbnail: result.thumbnail || '',
        };
      }

      return result; // pass-through for unusual shapes
    } catch (err) {
      console.warn(`📘 Facebook: [${name}] failed — ${err.message}`);
      errors.push(`${name}: ${err.message}`);
    }
  }

  throw new Error(`Facebook: all download methods failed.\n${errors.join('\n')}`);
}

// ─── Instagram scrapers ───────────────────────────────────────────────────────

async function scrapeSnapsave(igUrl) {
  const resp = await http.post(
    'https://snapsave.app/action_download.php',
    `url=${encodeURIComponent(igUrl)}`,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin:  'https://snapsave.app',
        Referer: 'https://snapsave.app/',
      },
    }
  );

  const html     = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
  const $        = cheerio.load(html);
  const items    = [];
  const seenUrls = new Set();

  $('table tr, .download-items').each((_, row) => {
    const $row    = $(row);
    const thumbEl = $row.find('img').first();
    const thumb   = thumbEl.attr('src') || thumbEl.attr('data-src') || '';
    const anchors = [];

    $row.find('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (isMediaHref(href)) anchors.push({ href, text: $(a).text().trim() });
    });
    if (!anchors.length) return;

    const best    = anchors.find(a => a.text.toLowerCase().includes('hd'))
                 || anchors.find(a => a.text.toLowerCase().includes('sd'))
                 || anchors[0];
    const realUrl = decodeCdnUrl(best.href);
    if (seenUrls.has(realUrl)) return;
    seenUrls.add(realUrl);

    const type    = detectType(best.href);
    items.push({ thumbnail: thumb || (type === 'image' ? realUrl : ''), url: realUrl, type, quality: qualityFromText(best.text) });
  });

  if (items.length > 0) {
    console.log(`✅ snapsave: ${items.length} item(s)`);
    return items;
  }

  // Flat link scan fallback
  const singleThumb = $('img.img-thumbnail, .download-items__thumb img, img').first().attr('src') || '';
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!isMediaHref(href)) return;
    const realUrl = decodeCdnUrl(href);
    if (seenUrls.has(realUrl)) return;
    seenUrls.add(realUrl);
    const type = detectType(href);
    items.push({ thumbnail: singleThumb || (type === 'image' ? realUrl : ''), url: realUrl, type, quality: qualityFromText($(a).text().trim()) });
  });

  if (items.length > 0) console.log(`✅ snapsave (link-scan): ${items.length} item(s)`);
  return items;
}

async function scrapeSnapinsta(igUrl) {
  const resp = await http.post(
    'https://snapinsta.app/api/ajaxSearch',
    `q=${encodeURIComponent(igUrl)}&t=media&lang=en`,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin:  'https://snapinsta.app',
        Referer: 'https://snapinsta.app/',
      },
    }
  );

  const html = resp.data?.data || resp.data || '';
  if (!html || typeof html !== 'string') return [];

  const $        = cheerio.load(html);
  const items    = [];
  const seenUrls = new Set();

  const blocks = $('.download-items, .dl-item, .media-wrap');
  if (blocks.length > 0) {
    blocks.each((_, block) => {
      const $block  = $(block);
      const thumbEl = $block.find('img').first();
      const thumb   = thumbEl.attr('src') || thumbEl.attr('data-src') || '';
      const anchors = [];

      $block.find('a[href]').each((_, a) => {
        const href = $(a).attr('href') || '';
        if (isMediaHref(href)) anchors.push({ href, text: $(a).text().trim() });
      });
      if (!anchors.length) return;

      const best    = anchors.find(a => a.text.toLowerCase().includes('hd')) || anchors[0];
      const realUrl = decodeCdnUrl(best.href);
      if (seenUrls.has(realUrl)) return;
      seenUrls.add(realUrl);

      const type = detectType(best.href);
      items.push({ thumbnail: thumb || (type === 'image' ? realUrl : ''), url: realUrl, type, quality: qualityFromText(best.text) });
    });
  }

  if (items.length === 0) {
    const singleThumb = $('img').first().attr('src') || '';
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!isMediaHref(href)) return;
      const realUrl = decodeCdnUrl(href);
      if (seenUrls.has(realUrl)) return;
      seenUrls.add(realUrl);
      const type = detectType(href);
      items.push({ thumbnail: singleThumb || (type === 'image' ? realUrl : ''), url: realUrl, type, quality: qualityFromText($(a).text().trim()) });
    });
  }

  if (items.length > 0) console.log(`✅ snapinsta: ${items.length} item(s)`);
  return items;
}

// ─── public API ───────────────────────────────────────────────────────────────

async function facebookInsta(url) {
  // ── Facebook ──────────────────────────────────────────────────────────────
  if (url.includes('facebook.com') || url.includes('fb.watch')) {
    return downloadFacebook(url);
  }

  // ── Instagram ─────────────────────────────────────────────────────────────
  const errors = [];

  try {
    const items = await scrapeSnapsave(url);
    if (items.length > 0) return { status: true, data: items };
    errors.push('snapsave: 0 items');
  } catch (e) {
    console.warn('⚠️  snapsave error:', e.message);
    errors.push(`snapsave: ${e.message}`);
  }

  try {
    const items = await scrapeSnapinsta(url);
    if (items.length > 0) return { status: true, data: items };
    errors.push('snapinsta: 0 items');
  } catch (e) {
    console.warn('⚠️  snapinsta error:', e.message);
    errors.push(`snapinsta: ${e.message}`);
  }

  throw new Error(`All Instagram scrapers failed: ${errors.join(' | ')}`);
}

module.exports = facebookInsta;