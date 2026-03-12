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

// ─── Facebook redirect resolver ──────────────────────────────────────────────
// /share/r/ links are HTTP redirects. metadownloader crashes on them because it
// tries to parse the page before the redirect resolves. Follow the redirect
// first to get the real reel/video URL, then pass that to metadownloader.

async function resolveFacebookUrl(url) {
  // Only bother for known redirect patterns
  if (!url.includes('/share/') && !url.includes('fb.watch')) return url;

  try {
    const resp = await axios.get(url, {
      maxRedirects: 10,
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      validateStatus: () => true, // accept any status so we can read the final URL
    });

    // axios resolves the redirect chain — the final URL is in resp.request.res.responseUrl
    // or resp.request._redirectable?._currentUrl depending on the http client version
    const finalUrl =
      resp.request?.res?.responseUrl ||
      resp.request?._redirectable?._currentUrl ||
      resp.config?.url ||
      url;

    if (finalUrl && finalUrl !== url) {
      console.log(`📘 Facebook redirect: ${url} → ${finalUrl}`);
      return finalUrl;
    }

    // Fallback: check for a canonical URL or og:url in the HTML body
    if (typeof resp.data === 'string') {
      const canonical = resp.data.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1]
        || resp.data.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1];
      if (canonical && canonical.includes('facebook.com')) {
        console.log(`📘 Facebook canonical: ${canonical}`);
        return canonical;
      }
    }
  } catch (e) {
    console.warn('📘 Facebook redirect resolve failed:', e.message, '— using original URL');
  }

  return url;
}

// ─── Facebook scraper fallback (fbdown.net) ───────────────────────────────────
// Used when metadownloader fails (status:false or throws).

async function scrapeFbdown(fbUrl) {
  try {
    // Step 1: get token from homepage
    const home = await axios.get('https://fbdown.net/', {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36' },
    });
    const $home  = cheerio.load(home.data);
    const token  = $home('input[name="_token"]').val() || $home('input[name="token"]').val() || '';

    // Step 2: submit the URL
    const form = new URLSearchParams({ _token: token, url: fbUrl });
    const resp = await axios.post('https://fbdown.net/', form.toString(), {
      timeout: 20000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://fbdown.net/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      },
    });

    const $ = cheerio.load(resp.data);
    const items = [];

    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!href.startsWith('http')) return;
      const lower = href.toLowerCase();
      if (!lower.includes('fbcdn.net') && !lower.includes('.mp4') && !lower.includes('facebook')) return;
      const text  = $(a).text().trim().toLowerCase();
      const quality = text.includes('hd') ? 'HD' : text.includes('sd') ? 'SD' : 'Best Quality';
      items.push({ resolution: quality, url: href, thumbnail: '' });
    });

    if (items.length > 0) {
      console.log(`✅ fbdown: ${items.length} item(s)`);
      return { data: items, title: 'Facebook Video', thumbnail: '' };
    }
  } catch (e) {
    console.warn('📘 fbdown scraper failed:', e.message);
  }
  return null;
}

async function facebookInsta(url) {
  // ── Facebook branch: metadownloader + fallback ────────────────────────────
  if (url.includes('facebook.com') || url.includes('fb.watch')) {
    console.log('📘 Facebook: using metadownloader');

    if (!metadownloader) {
      throw new Error('metadownloader is not installed. Run: npm install metadownloader');
    }

    // For /share/r/ and fb.watch links, resolve the redirect first so
    // metadownloader receives the real video/reel URL instead of a redirect stub.
    const resolvedUrl = await resolveFacebookUrl(url);

    let data = null;
    try {
      data = await metadownloader(resolvedUrl);
    } catch (e) {
      console.warn('📘 metadownloader threw:', e.message);
    }

    // Check if metadownloader actually succeeded (it returns status:false on failure)
    const metaOk = data && data.status !== false && (
      (Array.isArray(data.data)  && data.data.length  > 0) ||
      (Array.isArray(data.media) && data.media.length > 0) ||
      data.sd || data.hd || data.url
    );

    if (metaOk) {
      console.log('📘 Facebook metadownloader raw type:', typeof data);
      console.log('📘 Facebook metadownloader raw keys:', Object.keys(data || {}));
      console.log('📘 Facebook metadownloader sample:', JSON.stringify(data).slice(0, 400));
      return data;
    }

    // metadownloader failed — log why and try fbdown.net scraper
    console.warn('📘 metadownloader failed or returned status:false — msg:', data?.msg || 'unknown');
    console.log('📘 Facebook: trying fbdown.net scraper as fallback');

    const fbdownData = await scrapeFbdown(resolvedUrl);
    if (fbdownData) return fbdownData;

    // Both failed
    throw new Error(`Facebook: all download methods failed. metadownloader: ${data?.msg || 'error'}`);
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