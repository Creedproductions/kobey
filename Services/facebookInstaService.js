/**
 * facebookInstaService.js
 *
 * Routes by URL:
 *   facebook.com / fb.watch  →  multi-strategy chain (see below)
 *   instagram.com            →  snapsave.app → snapinsta.app scrapers
 *
 * Facebook strategy chain (in order):
 *   1. Resolve share/redirect URLs to canonical FB URL
 *   2. @mrnima/facebook-downloader  (npm install @mrnima/facebook-downloader)
 *   3. fdown.net scraper            (no install needed — HTTP scrape)
 *   4. Direct Facebook HTML scrape  (sd_src / hd_src / browser_native_* regex)
 *   5. metadownloader               (legacy last-resort)
 *
 * Return shape (Instagram success):
 *   { status: true, data: [ { thumbnail, url, type, quality } , … ] }
 *
 * Return shape (Facebook success):
 *   raw response — normalised by downloaderController.normaliseFacebookData()
 */

const axios   = require('axios');
const cheerio = require('cheerio');

// ─── optional deps ───────────────────────────────────────────────────────────

let metadownloader;
try {
  metadownloader = require('metadownloader');
} catch (_) {
  metadownloader = null;
  console.warn('⚠️ metadownloader not installed — using as last-resort fallback only');
}

let mrnima;
try {
  mrnima = require('@mrnima/facebook-downloader');
} catch (_) {
  mrnima = null;
  console.warn('⚠️ @mrnima/facebook-downloader not installed. Run: npm install @mrnima/facebook-downloader');
}

// ─── shared axios instance ───────────────────────────────────────────────────

const http = axios.create({
  timeout: 30_000,
  maxRedirects: 10,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language':    'en-US,en;q=0.5',
    'Accept-Encoding':    'gzip, deflate, br',
    'Connection':         'keep-alive',
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

function detectType(url) {
  if (!url) return 'video';
  try {
    const u   = new URL(url);
    const ext = (u.searchParams.get('ext') || '').toLowerCase();
    if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'ts'].includes(ext))            return 'video';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'avif'].includes(ext)) return 'image';
  } catch (_) {}
  const pathOnly = url.toLowerCase().split('?')[0];
  if (pathOnly.match(/\.(mp4|mov|webm|mkv|avi|ts)$/))          return 'video';
  if (pathOnly.match(/\.(jpg|jpeg|png|gif|webp|heic|avif)$/))   return 'image';
  if (pathOnly.includes('/t16/'))   return 'video';
  if (pathOnly.includes('/o1/v/'))  return 'video';
  if (pathOnly.match(/\/v\/t16/))   return 'video';
  if (pathOnly.includes('/t50.'))   return 'video';
  if (pathOnly.includes('/t51.'))   return 'image';
  if (pathOnly.includes('/t39.'))   return 'image';
  if (pathOnly.includes('/video/')) return 'video';
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

// ─── Step 1: URL resolver ─────────────────────────────────────────────────────
//
// facebook.com/share/r/XXXXX   → share links must be followed to get canonical
// fb.watch/XXXXX               → always redirects
// m.facebook.com               → normalise to www
//
// We do a lightweight HEAD request and follow redirects; if that fails we fall
// back to a GET (some CDNs block HEAD).

async function resolveCanonicalFbUrl(url) {
  // Fast-exit: already looks like a canonical video/reel/watch URL
  if (
    url.match(/facebook\.com\/(watch|reel|video)\//) ||
    url.match(/facebook\.com\/[^/]+\/videos\/\d+/) ||
    url.includes('facebook.com/watch?')
  ) {
    return url;
  }

  try {
    console.log(`🔗 Resolving redirect: ${url}`);
    const resp = await axios.head(url, {
      maxRedirects: 10,
      timeout: 10000,
      validateStatus: () => true,
      headers: { 'User-Agent': http.defaults.headers['User-Agent'] },
    });
    const finalUrl = resp.request?.res?.responseUrl || resp.config?.url || url;
    if (finalUrl && finalUrl !== url) {
      console.log(`🔗 Resolved → ${finalUrl}`);
      return finalUrl;
    }
  } catch (_) {}

  // Fallback: GET redirect
  try {
    const resp = await axios.get(url, {
      maxRedirects: 10,
      timeout: 12000,
      validateStatus: () => true,
      headers: { 'User-Agent': http.defaults.headers['User-Agent'] },
    });
    const finalUrl = resp.request?.res?.responseUrl || resp.config?.url || url;
    if (finalUrl && finalUrl !== url) {
      console.log(`🔗 Resolved (GET) → ${finalUrl}`);
      return finalUrl;
    }
  } catch (_) {}

  console.warn(`🔗 Could not resolve redirect, proceeding with original URL`);
  return url;
}

// ─── Strategy 2: @mrnima/facebook-downloader ─────────────────────────────────
//
// Returns: { creator, status, result: { thumbnail, duration, links: { HD, SD } } }
// Normalised to: { sd, hd, thumbnail, title }

async function tryMrnima(url) {
  if (!mrnima) throw new Error('@mrnima/facebook-downloader not installed');
  const result = await mrnima.facebook(url);
  console.log('📘 mrnima raw:', JSON.stringify(result).slice(0, 300));

  if (!result || !result.status) {
    throw new Error(`@mrnima failed: ${result?.msg || 'status false'}`);
  }

  const links = result.result?.links || {};
  const hd    = links.HD || links.hd || '';
  const sd    = links.SD || links.sd || '';
  const thumb = result.result?.thumbnail || '';

  if (!hd && !sd) throw new Error('@mrnima returned no video links');

  return {
    hd,
    sd,
    thumbnail: thumb,
    title:     result.result?.title || 'Facebook Video',
  };
}

// ─── Strategy 3: fdown.net scraper ───────────────────────────────────────────
//
// POST https://fdown.net/download.php  with  URLz=<url>
// Parse the response HTML for HD/SD download links.

async function tryFdown(url) {
  const resp = await http.post(
    'https://fdown.net/download.php',
    `URLz=${encodeURIComponent(url)}`,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin':  'https://fdown.net',
        'Referer': 'https://fdown.net/',
      },
    }
  );

  const html = typeof resp.data === 'string' ? resp.data : '';
  if (!html) throw new Error('fdown.net returned empty response');

  const $ = cheerio.load(html);

  // Look for HD/SD anchor links (href attributes pointing to fbcdn.net or video)
  let hd = '';
  let sd = '';

  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const text = $(a).text().toLowerCase();
    if (!href.includes('fbcdn.net') && !href.match(/\.mp4/i)) return;

    if (!hd && (text.includes('hd') || text.includes('high') || $(a).closest('[id*="HD"]').length))
      hd = href;
    else if (!sd && (text.includes('sd') || text.includes('low') || text.includes('normal')))
      sd = href;
    else if (!sd)
      sd = href;  // accept first unknown quality as SD
  });

  // Fallback: look inside input[type=text] (some versions embed URL in input)
  if (!hd && !sd) {
    $('input[type="text"]').each((_, el) => {
      const val = $(el).attr('value') || '';
      if (val.includes('fbcdn.net') || val.match(/\.mp4/i)) {
        const id = ($(el).attr('id') || '').toLowerCase();
        if (id.includes('hd') && !hd) hd = val;
        else if (!sd) sd = val;
      }
    });
  }

  console.log(`📘 fdown.net: hd=${hd.slice(0, 60)} sd=${sd.slice(0, 60)}`);

  if (!hd && !sd) throw new Error('fdown.net: no video URLs found in response HTML');

  const thumb = $('img').first().attr('src') || '';
  return { hd, sd, thumbnail: thumb, title: $('title').text().trim() || 'Facebook Video' };
}

// ─── Strategy 4: Direct Facebook HTML scrape ─────────────────────────────────
//
// Fetches the actual Facebook page and regex-extracts sd_src / hd_src /
// browser_native_hd_url / browser_native_sd_url from the embedded JSON blobs.

const FB_VIDEO_REGEXES = [
  { key: 'hd',  re: /"browser_native_hd_url"\s*:\s*"([^"]+)"/ },
  { key: 'sd',  re: /"browser_native_sd_url"\s*:\s*"([^"]+)"/ },
  { key: 'hd',  re: /"hd_src"\s*:\s*"([^"]+)"/ },
  { key: 'sd',  re: /"sd_src"\s*:\s*"([^"]+)"/ },
  { key: 'hd',  re: /"hd_src_no_ratelimit"\s*:\s*"([^"]+)"/ },
  { key: 'sd',  re: /"sd_src_no_ratelimit"\s*:\s*"([^"]+)"/ },
  // newer "playable_url" forms
  { key: 'hd',  re: /"playable_url_quality_hd"\s*:\s*"([^"]+)"/ },
  { key: 'sd',  re: /"playable_url"\s*:\s*"([^"]+)"/ },
];

function unescapeJsString(s) {
  return s
    .replace(/\\u003C/gi, '<')
    .replace(/\\u003E/gi, '>')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u00[0-9a-f]{2}/gi, m => String.fromCharCode(parseInt(m.slice(2), 16)))
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"');
}

async function tryDirectHtmlScrape(url) {
  const resp = await http.get(url, {
    headers: {
      // Use a mobile UA — mobile FB pages expose more raw JSON in page source
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const html = typeof resp.data === 'string' ? resp.data : '';
  if (!html) throw new Error('Facebook page returned empty content');
  if (html.length < 500) throw new Error('Facebook page response too short — likely blocked');

  let hd = '';
  let sd = '';

  for (const { key, re } of FB_VIDEO_REGEXES) {
    const match = html.match(re);
    if (match && match[1]) {
      const cleanUrl = unescapeJsString(match[1]);
      if (key === 'hd' && !hd && cleanUrl.startsWith('http')) hd = cleanUrl;
      if (key === 'sd' && !sd && cleanUrl.startsWith('http')) sd = cleanUrl;
    }
    if (hd && sd) break;
  }

  console.log(`📘 Direct scrape: hd=${hd.slice(0, 60)} sd=${sd.slice(0, 60)}`);

  if (!hd && !sd)
    throw new Error('Direct HTML scrape: no video URLs found — page may require login');

  // Extract thumbnail from og:image
  const $ = cheerio.load(html);
  const thumb =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="og:image"]').attr('content') || '';

  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim() || 'Facebook Video';

  return { hd, sd, thumbnail: thumb, title };
}

// ─── Strategy 5: metadownloader (legacy last-resort) ─────────────────────────

async function tryMetadownloader(url) {
  if (!metadownloader) throw new Error('metadownloader not installed');

  const data = await metadownloader(url);
  console.log('📘 metadownloader raw keys:', Object.keys(data || {}));

  // Detect and reject the error shape { developer, status: false, msg }
  if (data && data.status === false) {
    throw new Error(`metadownloader error: ${data.msg || 'status false'}`);
  }

  if (!data) throw new Error('metadownloader returned null');

  return data;  // let normaliseFacebookData handle the shape
}

// ─── Facebook main entry ──────────────────────────────────────────────────────

async function downloadFacebook(url) {
  console.log(`📘 Facebook: starting download for ${url}`);

  // Step 1: resolve redirect/share URLs
  const canonicalUrl = await resolveCanonicalFbUrl(url);

  const errors = [];
  const attempts = [
    { name: '@mrnima', fn: () => tryMrnima(canonicalUrl) },
    { name: 'fdown.net', fn: () => tryFdown(canonicalUrl) },
    { name: 'direct-html', fn: () => tryDirectHtmlScrape(canonicalUrl) },
    { name: 'metadownloader', fn: () => tryMetadownloader(canonicalUrl) },
    // Also try the original URL if canonical differs (safety net)
    ...(canonicalUrl !== url
      ? [
          { name: '@mrnima-orig', fn: () => tryMrnima(url) },
          { name: 'fdown.net-orig', fn: () => tryFdown(url) },
          { name: 'direct-html-orig', fn: () => tryDirectHtmlScrape(url) },
        ]
      : []),
  ];

  for (const { name, fn } of attempts) {
    try {
      console.log(`📘 Facebook: trying strategy [${name}]`);
      const result = await fn();
      console.log(`✅ Facebook: strategy [${name}] succeeded`);

      // Strategies 2-4 return normalised { hd, sd, thumbnail, title }
      // — wrap into the shape normaliseFacebookData() understands ({ sd, hd, title, thumbnail })
      if (result && (result.hd || result.sd) && !result.data && !result.media) {
        return {
          hd:        result.hd        || '',
          sd:        result.sd        || '',
          title:     result.title     || 'Facebook Video',
          thumbnail: result.thumbnail || '',
        };
      }

      // metadownloader may return its own shape — pass through
      return result;

    } catch (err) {
      console.warn(`📘 Facebook: strategy [${name}] failed: ${err.message}`);
      errors.push(`${name}: ${err.message}`);
    }
  }

  throw new Error(`Facebook: all strategies failed.\n${errors.join('\n')}`);
}

// ─── Instagram scrapers ───────────────────────────────────────────────────────

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
  // ── Facebook branch ───────────────────────────────────────────────────────
  if (url.includes('facebook.com') || url.includes('fb.watch')) {
    return downloadFacebook(url);
  }

  // ── Instagram branch ──────────────────────────────────────────────────────
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