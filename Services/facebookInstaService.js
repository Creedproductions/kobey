/**
 * facebookInstaService.js
 *
 * Clean Instagram / Facebook carousel scraper.
 *
 * FIX: snapsave returns proxy links like:
 *   https://snapsave.app/api/ajaxDownload.php?url=ENCODED_CDN_URL&ext=jpg
 * The old code ran typeFromUrl() on the proxy URL (.php → null → 'video'),
 * and deduped by thumbnail (all rows may share the same post thumbnail → collapse to 1).
 *
 * Now we:
 *   1. Decode the real Instagram CDN URL from the proxy link's `url` param.
 *   2. Return the CDN URL as the download URL (pre-signed, no-cookie, directly downloadable).
 *   3. Detect type and build the dedup key from the CDN URL, not the proxy.
 *
 * Tries two services in order:
 *   1. snapsave.app
 *   2. snapinsta.app
 */

const axios   = require('axios');
const cheerio = require('cheerio');

// ─── shared axios instance ──────────────────────────────────────────────────
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

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Decode the real CDN URL from a snapsave/snapinsta proxy link.
 *
 * Proxy URL shapes we handle:
 *   https://snapsave.app/api/ajaxDownload.php?url=ENCODED&ext=jpg
 *   https://snapinsta.app/api/ajaxDownload.php?url=ENCODED&ext=mp4
 *   https://snapsave.app/d?url=ENCODED
 *
 * If the href is already a direct CDN URL, return it unchanged.
 */
function decodeCdnUrl(href) {
  if (!href) return '';
  try {
    const u = new URL(href);
    // Common parameter names used by scraper sites
    for (const param of ['url', 'u', 'src', 'link', 'media']) {
      const val = u.searchParams.get(param);
      if (val && val.startsWith('http')) {
        const decoded = decodeURIComponent(val);
        // Recursively decode in case of double-encoding
        if (decoded.includes('%')) return decodeCdnUrl(decoded);
        return decoded;
      }
    }
  } catch (_) {}
  return href; // Already a direct URL
}

/** Detect media type purely from a URL string (works on real CDN URLs). */
function typeFromUrl(url) {
  if (!url) return null;
  const u = url.toLowerCase().split('?')[0]; // strip query params for extension check
  if (u.match(/\.(mp4|mov|webm|mkv|avi|ts)$/))         return 'video';
  if (u.match(/\.(jpg|jpeg|png|gif|webp|heic|avif)$/))  return 'image';
  // Instagram CDN path convention: /t50.* = video, /t51.* = image
  if (u.includes('/t50.'))  return 'video';
  if (u.includes('/t51.'))  return 'image';
  // Path contains 'video'
  if (u.includes('/video/') || u.includes('video_dashinit')) return 'video';
  return null;
}

/** Detect type first from the proxy URL, then from the decoded CDN URL. */
function detectType(proxyHref) {
  // 1. Try extension in the proxy URL's own `ext` param (snapsave sets this)
  try {
    const u   = new URL(proxyHref);
    const ext = (u.searchParams.get('ext') || '').toLowerCase();
    if (['mp4', 'mov', 'webm', 'mkv'].includes(ext)) return 'video';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(ext)) return 'image';
  } catch (_) {}

  // 2. Try from the proxy URL path itself
  const fromProxy = typeFromUrl(proxyHref);
  if (fromProxy) return fromProxy;

  // 3. Decode the actual CDN URL and check its extension/path
  const cdnUrl = decodeCdnUrl(proxyHref);
  if (cdnUrl !== proxyHref) {
    const fromCdn = typeFromUrl(cdnUrl);
    if (fromCdn) return fromCdn;
  }

  return 'video'; // safe default
}

/** Quality label from button text */
function qualityFromText(txt) {
  const t = (txt || '').toLowerCase();
  if (t.includes('hd') || t.includes('high')) return 'HD';
  if (t.includes('sd') || t.includes('low'))  return 'SD';
  return 'Original Quality';
}

/**
 * Accept any href that could be a media download link.
 * Must start with http and be from a known CDN or scraper domain.
 * We're deliberately permissive — stricter checks happen in dedup.
 */
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

// ─── Scraper 1: snapsave.app ─────────────────────────────────────────────

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

  const html = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
  const $    = cheerio.load(html);
  const items = [];

  // ── Strategy 1: carousel table rows ────────────────────────────────────
  // snapsave renders carousels as <table> rows: [thumbnail | quality buttons]
  $('table tr, .download-items').each((_, row) => {
    const $row    = $(row);
    const thumbEl = $row.find('img').first();
    const thumb   = thumbEl.attr('src') || thumbEl.attr('data-src') || '';
    const anchors = [];

    $row.find('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (isMediaHref(href)) {
        anchors.push({ href, text: $(a).text().trim() });
      }
    });

    if (!anchors.length) return;

    // Pick HD > SD > first
    const best = anchors.find(a => a.text.toLowerCase().includes('hd'))
              || anchors.find(a => a.text.toLowerCase().includes('sd'))
              || anchors[0];

    // ── KEY FIX: decode the real CDN URL from the proxy link ──
    const realUrl = decodeCdnUrl(best.href);
    const type    = detectType(best.href);  // uses ext param + CDN path
    const quality = qualityFromText(best.text);

    // Per-item thumbnail from the row is more reliable than a decoded CDN URL.
    // If the row has no per-item thumb, fall back to the decoded URL (images
    // from Instagram CDN are viewable directly).
    const itemThumb = thumb || (type === 'image' ? realUrl : '');

    console.log(`  snapsave row → realUrl=${realUrl.slice(0,80)} type=${type} thumb=${itemThumb.slice(0,60)}`);

    items.push({
      thumbnail: itemThumb,
      url:       realUrl,   // ← direct CDN URL, not the proxy URL
      type,
      quality,
    });
  });

  if (items.length > 0) {
    console.log(`✅ snapsave: ${items.length} item(s) via table/download-items`);
    return items;
  }

  // ── Strategy 2: flat link scan (single-item / alternative layout) ───────
  const singleThumb = $('img.img-thumbnail, .download-items__thumb img, img').first().attr('src') || '';

  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!isMediaHref(href)) return;

    const realUrl = decodeCdnUrl(href);
    const type    = detectType(href);

    items.push({
      thumbnail: singleThumb || (type === 'image' ? realUrl : ''),
      url:       realUrl,
      type,
      quality: qualityFromText($(a).text().trim()),
    });
  });

  if (items.length > 0) {
    console.log(`✅ snapsave: ${items.length} item(s) via link scan`);
  }

  return items;
}

// ─── Scraper 2: snapinsta.app ────────────────────────────────────────────

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

  const $     = cheerio.load(html);
  const items = [];

  // snapinsta carousel: multiple .download-items / .dl-item blocks
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
      const type    = detectType(best.href);

      items.push({
        thumbnail: thumb || (type === 'image' ? realUrl : ''),
        url:       realUrl,
        type,
        quality: qualityFromText(best.text),
      });
    });
  }

  if (items.length === 0) {
    // Fallback: flat scan
    const singleThumb = $('img').first().attr('src') || '';
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!isMediaHref(href)) return;
      const realUrl = decodeCdnUrl(href);
      const type    = detectType(href);
      items.push({
        thumbnail: singleThumb || (type === 'image' ? realUrl : ''),
        url:       realUrl,
        type,
        quality: qualityFromText($(a).text().trim()),
      });
    });
  }

  if (items.length > 0) {
    console.log(`✅ snapinsta: ${items.length} item(s)`);
  }

  return items;
}

// ─── public API ─────────────────────────────────────────────────────────────

async function facebookInsta(url) {
  const errors = [];

  // ── Attempt 1: snapsave ─────────────────────────────────────────────────
  try {
    const items = await scrapeSnapsave(url);
    if (items.length > 0) {
      return { status: true, data: items };
    }
    console.warn('⚠️ snapsave returned 0 items');
    errors.push('snapsave: 0 items');
  } catch (e) {
    console.warn('⚠️ snapsave error:', e.message);
    errors.push(`snapsave: ${e.message}`);
  }

  // ── Attempt 2: snapinsta ────────────────────────────────────────────────
  try {
    const items = await scrapeSnapinsta(url);
    if (items.length > 0) {
      return { status: true, data: items };
    }
    console.warn('⚠️ snapinsta returned 0 items');
    errors.push('snapinsta: 0 items');
  } catch (e) {
    console.warn('⚠️ snapinsta error:', e.message);
    errors.push(`snapinsta: ${e.message}`);
  }

  throw new Error(`All Instagram scrapers failed: ${errors.join(' | ')}`);
}

module.exports = facebookInsta;