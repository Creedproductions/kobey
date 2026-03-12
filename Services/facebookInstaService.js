/**
 * facebookInstaService.js
 *
 * Routes by URL:
 *   facebook.com / fb.watch  →  metadownloader  (npm install metadownloader)
 *   instagram.com            →  snapsave.app → snapinsta.app scrapers
 *
 * Return shape (Instagram success):
 *   { status: true, data: [ { thumbnail, url, type, quality } , … ] }
 *
 * Return shape (Facebook success):
 *   raw metadownloader response — normalised by downloaderController's normaliseFacebookData()
 */

const axios      = require('axios');
const cheerio    = require('cheerio');

// ─── metadownloader (Facebook) ───────────────────────────────────────────────

let metadownloader;
try {
  metadownloader = require('metadownloader');
} catch (_) {
  metadownloader = null;
  console.warn('⚠️ metadownloader not installed — Facebook downloads will fail. Run: npm install metadownloader');
}

// ─── shared axios instance (Instagram scrapers) ──────────────────────────────

const http = axios.create({
  timeout: 30_000,
  headers: {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection':      'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  },
});

// ─── helpers ─────────────────────────────────────────────────────────────────

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

/**
 * Detect media type from a URL string.
 *
 * Instagram CDN path conventions (priority order):
 *   /t16/         → video  (newer Reels / image+audio clips)
 *   /o1/v/        → video  (newer CDN path prefix)
 *   /v/t16        → video  (alternate reel path)
 *   /t50.         → video  (older video CDN)
 *   /t51.         → image  (older image CDN)
 *   /t39.         → image  (feed photos — most single-image posts)
 *   /video/       → video
 *   default       → 'video' (safer for reels; caller checks thumbnail to override)
 */
function detectType(url) {
  if (!url) return 'video';

  // 1. Proxy ext param
  try {
    const u   = new URL(url);
    const ext = (u.searchParams.get('ext') || '').toLowerCase();
    if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'ts'].includes(ext))           return 'video';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'avif'].includes(ext)) return 'image';
  } catch (_) {}

  // 2. Path extension
  const pathOnly = url.toLowerCase().split('?')[0];
  if (pathOnly.match(/\.(mp4|mov|webm|mkv|avi|ts)$/))          return 'video';
  if (pathOnly.match(/\.(jpg|jpeg|png|gif|webp|heic|avif)$/))   return 'image';

  // 3. Instagram CDN path conventions
  if (pathOnly.includes('/t16/'))    return 'video';  // newer Reels / audio+image video CDN
  if (pathOnly.includes('/o1/v/'))   return 'video';  // newer CDN path prefix
  if (pathOnly.match(/\/v\/t16/))    return 'video';  // /v/t16xxx
  if (pathOnly.includes('/t50.'))    return 'video';  // older video CDN
  if (pathOnly.includes('/t51.'))    return 'image';  // older image CDN
  if (pathOnly.includes('/t39.'))    return 'image';  // feed photos (most single-image posts)
  if (pathOnly.includes('/video/'))  return 'video';

  // 4. Decode proxy URL and retry
  const decoded = decodeCdnUrl(url);
  if (decoded !== url) {
    const dp = decoded.toLowerCase().split('?')[0];
    if (dp.match(/\.(mp4|mov|webm|mkv|avi|ts)$/))          return 'video';
    if (dp.match(/\.(jpg|jpeg|png|gif|webp|heic|avif)$/))   return 'image';
    if (dp.includes('/t16/'))    return 'video';
    if (dp.includes('/o1/v/'))   return 'video';
    if (dp.match(/\/v\/t16/))    return 'video';
    if (dp.includes('/t50.'))    return 'video';
    if (dp.includes('/t51.'))    return 'image';
    if (dp.includes('/t39.'))    return 'image';
    if (dp.includes('/video/'))  return 'video';
  }

  return 'video'; // safe default
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

// ─── Scraper 1: snapsave.app ─────────────────────────────────────────────────

async function scrapeSnapsave(igUrl) {
  const resp = await http.post(
    'https://snapsave.app/action_download.php',
    `url=${encodeURIComponent(igUrl)}`,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin':  'https://snapsave.app',
        'Referer': 'https://snapsave.app/',
      },
    }
  );

  const html     = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
  const $        = cheerio.load(html);
  const items    = [];
  const seenUrls = new Set();

  // Strategy 1: table rows / .download-items blocks
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
    const quality = qualityFromText(best.text);
    const itemThumb = thumb || (type === 'image' ? realUrl : '');

    console.log(`  snapsave row → realUrl=${realUrl.slice(0, 80)} type=${type}`);
    items.push({ thumbnail: itemThumb, url: realUrl, type, quality });
  });

  if (items.length > 0) {
    console.log(`✅ snapsave: ${items.length} item(s) via table/download-items`);
    return items;
  }

  // Strategy 2: flat link scan
  const singleThumb = $('img.img-thumbnail, .download-items__thumb img, img').first().attr('src') || '';

  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!isMediaHref(href)) return;

    const realUrl = decodeCdnUrl(href);
    if (seenUrls.has(realUrl)) return;
    seenUrls.add(realUrl);

    const type = detectType(href);
    items.push({
      thumbnail: singleThumb || (type === 'image' ? realUrl : ''),
      url:       realUrl,
      type,
      quality:   qualityFromText($(a).text().trim()),
    });
  });

  if (items.length > 0) {
    console.log(`✅ snapsave: ${items.length} item(s) via link scan`);
  }

  return items;
}

// ─── Scraper 2: snapinsta.app ────────────────────────────────────────────────

async function scrapeSnapinsta(igUrl) {
  const resp = await http.post(
    'https://snapinsta.app/api/ajaxSearch',
    `q=${encodeURIComponent(igUrl)}&t=media&lang=en`,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin':  'https://snapinsta.app',
        'Referer': 'https://snapinsta.app/',
      },
    }
  );

  const html = resp.data?.data || resp.data || '';
  if (!html || typeof html !== 'string') return [];

  const $        = cheerio.load(html);
  const items    = [];
  const seenUrls = new Set();
  const blocks   = $('.download-items, .dl-item, .media-wrap');

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
      items.push({
        thumbnail: thumb || (type === 'image' ? realUrl : ''),
        url:       realUrl,
        type,
        quality:   qualityFromText(best.text),
      });
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
      items.push({
        thumbnail: singleThumb || (type === 'image' ? realUrl : ''),
        url:       realUrl,
        type,
        quality:   qualityFromText($(a).text().trim()),
      });
    });
  }

  if (items.length > 0) console.log(`✅ snapinsta: ${items.length} item(s)`);
  return items;
}

// ─── public API ──────────────────────────────────────────────────────────────

async function facebookInsta(url) {
  // ── Facebook branch: metadownloader ──────────────────────────────────────
  if (url.includes('facebook.com') || url.includes('fb.watch')) {
    console.log('📘 Facebook: using metadownloader');

    if (!metadownloader) {
      throw new Error('metadownloader is not installed. Run: npm install metadownloader');
    }

    // metadownloader can throw or return null for some URL types — let it bubble
    const data = await metadownloader(url);

    console.log('📘 Facebook metadownloader raw type:', typeof data);
    console.log('📘 Facebook metadownloader raw keys:', Object.keys(data || {}));
    console.log('📘 Facebook metadownloader sample:', JSON.stringify(data).slice(0, 400));

    return data; // normalisation happens in downloaderController.normaliseFacebookData()
  }

  // ── Instagram branch: scraper chain ──────────────────────────────────────
  const errors = [];

  try {
    const items = await scrapeSnapsave(url);
    if (items.length > 0) return { status: true, data: items };
    console.warn('⚠️ snapsave returned 0 items');
    errors.push('snapsave: 0 items');
  } catch (e) {
    console.warn('⚠️ snapsave error:', e.message);
    errors.push(`snapsave: ${e.message}`);
  }

  try {
    const items = await scrapeSnapinsta(url);
    if (items.length > 0) return { status: true, data: items };
    console.warn('⚠️ snapinsta returned 0 items');
    errors.push('snapinsta: 0 items');
  } catch (e) {
    console.warn('⚠️ snapinsta error:', e.message);
    errors.push(`snapinsta: ${e.message}`);
  }

  throw new Error(`All Instagram scrapers failed: ${errors.join(' | ')}`);
}

module.exports = facebookInsta;