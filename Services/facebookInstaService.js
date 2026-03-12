/**
 * facebookInstaService.js
 *
 * Routes by URL:
 *   facebook.com / fb.watch  →  metadownloader (first), then page-scrape fallback
 *   instagram.com            →  snapsave.app → snapinsta.app scrapers
 */

const axios   = require('axios');
const cheerio = require('cheerio');

// ─── metadownloader ───────────────────────────────────────────────────────────

let metadownloader;
try {
  metadownloader = require('metadownloader');
} catch (_) {
  metadownloader = null;
  console.warn('⚠️ metadownloader not installed. Run: npm install metadownloader');
}

// ─── shared axios instance ────────────────────────────────────────────────────

const http = axios.create({
  timeout: 30_000,
  headers: {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection':      'keep-alive',
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

function detectType(url) {
  if (!url) return 'video';
  try {
    const ext = (new URL(url).searchParams.get('ext') || '').toLowerCase();
    if (['mp4','mov','webm','mkv','avi','ts'].includes(ext))           return 'video';
    if (['jpg','jpeg','png','gif','webp','heic','avif'].includes(ext)) return 'image';
  } catch (_) {}
  const p = url.toLowerCase().split('?')[0];
  if (p.match(/\.(mp4|mov|webm|mkv|avi|ts)$/))         return 'video';
  if (p.match(/\.(jpg|jpeg|png|gif|webp|heic|avif)$/))  return 'image';
  if (p.includes('/t16/'))   return 'video';
  if (p.includes('/o1/v/'))  return 'video';
  if (p.match(/\/v\/t16/))   return 'video';
  if (p.includes('/t50.'))   return 'video';
  if (p.includes('/t51.'))   return 'image';
  if (p.includes('/t39.'))   return 'image';
  if (p.includes('/video/')) return 'video';
  const decoded = decodeCdnUrl(url);
  if (decoded !== url) {
    const dp = decoded.toLowerCase().split('?')[0];
    if (dp.match(/\.(mp4|mov|webm|mkv|avi|ts)$/))        return 'video';
    if (dp.match(/\.(jpg|jpeg|png|gif|webp|heic|avif)$/)) return 'image';
    if (dp.includes('/t16/'))  return 'video';
    if (dp.includes('/o1/v/')) return 'video';
    if (dp.includes('/t50.'))  return 'video';
    if (dp.includes('/t51.'))  return 'image';
    if (dp.includes('/t39.'))  return 'image';
  }
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

// ─── Facebook URL rewriter ────────────────────────────────────────────────────
// Converts short-form share URLs to their canonical forms WITHOUT any HTTP
// requests. metadownloader crashes on /share/r/ and /share/v/ because it can't
// parse the redirect page. Simple string rewriting fixes it instantly.
//
//   /share/r/ABC/  →  /reel/ABC/       (Reel share links)
//   /share/v/ABC/  →  /videos/ABC/     (Video share links)
//   fb.watch/ABC   →  keep as-is (metadownloader handles fb.watch fine)

function rewriteFacebookUrl(url) {
  try {
    const u = new URL(url);

    // /share/r/ID/ → /reel/ID/
    const reelMatch = u.pathname.match(/^\/share\/r\/([^/]+)\/?/);
    if (reelMatch) {
      const rewritten = `https://www.facebook.com/reel/${reelMatch[1]}/`;
      console.log(`📘 FB URL rewrite (reel): ${url.slice(-30)} → ${rewritten}`);
      return rewritten;
    }

    // /share/v/ID/ → /videos/ID/
    const videoMatch = u.pathname.match(/^\/share\/v\/([^/]+)\/?/);
    if (videoMatch) {
      const rewritten = `https://www.facebook.com/videos/${videoMatch[1]}/`;
      console.log(`📘 FB URL rewrite (video): ${url.slice(-30)} → ${rewritten}`);
      return rewritten;
    }

    // /share/p/ID/ → /posts/ID/
    const postMatch = u.pathname.match(/^\/share\/p\/([^/]+)\/?/);
    if (postMatch) {
      const rewritten = `https://www.facebook.com/posts/${postMatch[1]}/`;
      console.log(`📘 FB URL rewrite (post): ${url.slice(-30)} → ${rewritten}`);
      return rewritten;
    }

  } catch (_) {}

  // No rewrite needed
  return url;
}

// ─── Facebook page scrape fallback ───────────────────────────────────────────
// Fetches the Facebook page and looks for hd_src/sd_src video URLs embedded
// in the page JS. Only called if metadownloader fails.

async function scrapeFacebookPage(url) {
  try {
    console.log('📘 FB page scrape: fetching', url.slice(0, 80));
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Sec-Fetch-Mode':  'navigate',
      },
    });

    const raw = typeof resp.data === 'string' ? resp.data : '';
    if (!raw) return null;

    // Unescape Facebook's unicode escapes
    const html = raw
      .replace(/\\u0026/g, '&')
      .replace(/\\u0025/g, '%')
      .replace(/\\u003C/g, '<')
      .replace(/\\u003E/g, '>')
      .replace(/\\\//g, '/');

    const variants = [];

    // Strategy 1: hd_src / sd_src in page JS
    const hdUrl = (html.match(/"hd_src"\s*:\s*"([^"]+\.mp4[^"]*)"/)?.[1] || '').replace(/\\/g, '');
    const sdUrl = (html.match(/"sd_src"\s*:\s*"([^"]+\.mp4[^"]*)"/)?.[1] || '').replace(/\\/g, '');
    if (hdUrl) { console.log('📘 FB page scrape: found hd_src'); variants.push({ resolution: 'HD', url: hdUrl, thumbnail: '' }); }
    if (sdUrl) { console.log('📘 FB page scrape: found sd_src'); variants.push({ resolution: 'SD', url: sdUrl, thumbnail: '' }); }

    // Strategy 2: browser_native_hd_url / browser_native_sd_url
    if (!variants.length) {
      const hdN = (html.match(/"browser_native_hd_url"\s*:\s*"([^"]+)"/)?.[1] || '').replace(/\\/g, '');
      const sdN = (html.match(/"browser_native_sd_url"\s*:\s*"([^"]+)"/)?.[1] || '').replace(/\\/g, '');
      if (hdN) variants.push({ resolution: 'HD', url: hdN, thumbnail: '' });
      if (sdN) variants.push({ resolution: 'SD', url: sdN, thumbnail: '' });
      if (variants.length) console.log('📘 FB page scrape: found browser_native_*_url');
    }

    // Strategy 3: og:video meta tag
    if (!variants.length) {
      const $ = cheerio.load(raw);
      const ogVideo = $('meta[property="og:video"]').attr('content') || $('meta[property="og:video:url"]').attr('content') || '';
      if (ogVideo?.startsWith('http')) {
        console.log('📘 FB page scrape: found og:video');
        variants.push({ resolution: 'Best Quality', url: ogVideo, thumbnail: '' });
      }
    }

    if (!variants.length) {
      console.warn('📘 FB page scrape: no video URLs found — page likely requires login');
      return null;
    }

    // Extract thumbnail
    let thumbnail = '';
    try {
      const $ = cheerio.load(raw);
      thumbnail = $('meta[property="og:image"]').attr('content') || $('meta[property="og:image:url"]').attr('content') || '';
    } catch (_) {}

    variants.forEach(v => { if (!v.thumbnail) v.thumbnail = thumbnail; });
    console.log(`✅ FB page scrape: ${variants.length} variant(s)`);
    return { data: variants, title: 'Facebook Video', thumbnail };

  } catch (e) {
    console.warn('📘 FB page scrape error:', e.message);
    return null;
  }
}

// ─── Facebook main handler ────────────────────────────────────────────────────

async function handleFacebook(url) {
  // Step 1: rewrite share short-links to canonical URLs (no HTTP request needed)
  const canonicalUrl = rewriteFacebookUrl(url);

  // Step 2: try metadownloader FIRST — it's the fastest and most reliable
  if (metadownloader) {
    let data = null;
    let metaErr = '';
    try {
      data = await metadownloader(canonicalUrl);
    } catch (e) {
      metaErr = e.message;
      console.warn('📘 metadownloader threw:', e.message);
    }

    const metaOk = data &&
      data.status !== false &&
      (
        (Array.isArray(data.data)  && data.data.length  > 0) ||
        (Array.isArray(data.media) && data.media.length > 0) ||
        data.sd || data.hd || data.url
      );

    if (metaOk) {
      console.log('📘 metadownloader OK — keys:', Object.keys(data));
      return data;
    }

    console.warn('📘 metadownloader failed — msg:', data?.msg || metaErr || 'no data');
  } else {
    console.warn('📘 metadownloader not installed — trying page scrape');
  }

  // Step 3: page scrape fallback (only if metadownloader fails)
  const scraped = await scrapeFacebookPage(canonicalUrl);
  if (scraped) return scraped;

  throw new Error('Facebook: all download methods failed. The video may be private or login-required.');
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

  if (items.length > 0) { console.log(`✅ snapsave: ${items.length} item(s) via table/download-items`); return items; }

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

  if (items.length > 0) console.log(`✅ snapsave: ${items.length} item(s) via link scan`);
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

// ─── public API ──────────────────────────────────────────────────────────────

async function facebookInsta(url) {
  if (url.includes('facebook.com') || url.includes('fb.watch')) {
    return handleFacebook(url);
  }

  // Instagram scraper chain
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