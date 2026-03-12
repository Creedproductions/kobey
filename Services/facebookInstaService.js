/**
 * facebookInstaService.js
 *
 * Clean Instagram / Facebook carousel scraper.
 * Does NOT use the broken `metadownloader` package.
 *
 * Tries two services in order:
 *   1. snapsave.app  — returns direct CDN URLs per carousel item with correct types
 *   2. snapinsta.app — similar structure, useful as fallback
 *
 * Both services are Instagram scrapers that proxy through their own servers,
 * so Instagram's datacenter-IP blocking does not affect us.
 *
 * Return shape (on success):
 *   { status: true, data: [ { thumbnail, url, type, quality } , … ] }
 *
 * Return shape (on failure):
 *   { status: false, msg: '…error message…' }
 */

const axios   = require('axios');
const cheerio = require('cheerio');

// ─── shared axios instance with browser-like headers ───────────────────────
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

/** Decide media type from URL string */
function typeFromUrl(url) {
  const u = url.toLowerCase();
  if (u.match(/\.(mp4|mov|webm|mkv)(\?|$)/)) return 'video';
  if (u.match(/\.(jpg|jpeg|png|gif|webp|heic)(\?|$)/)) return 'image';
  if (u.includes('/v/') && u.includes('.mp4'))          return 'video';
  return null; // unknown — caller should default to 'video'
}

/** Decide quality label from anchor text */
function qualityFromText(txt) {
  const t = (txt || '').toLowerCase();
  if (t.includes('hd') || t.includes('high')) return 'HD';
  if (t.includes('sd') || t.includes('low'))  return 'SD';
  return 'Original Quality';
}

/** Keeps only CDN-style download hrefs (excludes JS links, # etc.) */
function isMediaHref(href) {
  if (!href || !href.startsWith('http')) return false;
  // Must look like a direct media URL or a CDN proxy
  return (
    href.includes('cdninstagram.com') ||
    href.includes('fbcdn.net') ||
    href.includes('scontent') ||
    href.includes('snapsave') ||  // proxied through snapsave CDN
    href.includes('snapinsta') || // proxied through snapinsta CDN
    href.match(/\.(mp4|mov|webm|jpg|jpeg|png|gif|webp)(\?|$)/i)
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

  // ── Carousel table rows ─────────────────────────────────────────────────
  // snapsave renders carousels as <table> rows: thumb | quality buttons
  $('table tr').each((i, row) => {
    const $row     = $(row);
    const thumb    = $row.find('img').first().attr('src') || '';
    const anchors  = [];

    $row.find('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (isMediaHref(href)) anchors.push({ href, text: $(a).text().trim() });
    });

    if (!anchors.length) return;

    // Pick HD > SD > first
    const best = anchors.find(a => a.text.toLowerCase().includes('hd'))
              || anchors.find(a => a.text.toLowerCase().includes('sd'))
              || anchors[0];

    items.push({
      thumbnail: thumb,
      url:       best.href,
      type:      typeFromUrl(best.href) || 'video',
      quality:   qualityFromText(best.text),
    });
  });

  if (items.length > 0) {
    console.log(`✅ snapsave: ${items.length} item(s) via table rows`);
    return items;
  }

  // ── Single-item / alternative layout ────────────────────────────────────
  // Some posts return a download section without a table
  const singleThumb = $('img.img-thumbnail, .download-items__thumb img, img').first().attr('src') || '';
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!isMediaHref(href)) return;
    items.push({
      thumbnail: singleThumb,
      url:       href,
      type:      typeFromUrl(href) || 'video',
      quality:   qualityFromText($(a).text().trim()),
    });
  });

  if (items.length > 0) {
    console.log(`✅ snapsave: ${items.length} item(s) via link scan`);
  }

  return items;
}

// ─── Scraper 2: snapinsta.app ────────────────────────────────────────────

async function scrapeSnapinsta(igUrl) {
  // snapinsta uses an AJAX endpoint
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

  // Response is JSON: { status: 'ok', data: '<html>' }
  const html = resp.data?.data || resp.data || '';
  if (!html || typeof html !== 'string') return [];

  const $     = cheerio.load(html);
  const items = [];

  // snapinsta carousel: multiple .download-items blocks
  $('.download-items, .dl-item, .media-wrap').each((_, block) => {
    const $block  = $(block);
    const thumb   = $block.find('img').first().attr('src') || '';
    const anchors = [];

    $block.find('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (isMediaHref(href)) anchors.push({ href, text: $(a).text().trim() });
    });

    if (!anchors.length) return;

    const best = anchors.find(a => a.text.toLowerCase().includes('hd'))
              || anchors[0];

    items.push({
      thumbnail: thumb,
      url:       best.href,
      type:      typeFromUrl(best.href) || 'video',
      quality:   qualityFromText(best.text),
    });
  });

  if (items.length === 0) {
    // Fallback: scan all valid hrefs
    const singleThumb = $('img').first().attr('src') || '';
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!isMediaHref(href)) return;
      items.push({
        thumbnail: singleThumb,
        url:       href,
        type:      typeFromUrl(href) || 'video',
        quality:   qualityFromText($(a).text().trim()),
      });
    });
  }

  if (items.length > 0) {
    console.log(`✅ snapinsta: ${items.length} item(s)`);
  }

  return items;
}

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Fetch Instagram or Facebook media info.
 * Returns { status: true, data: [...] } or throws on total failure.
 */
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