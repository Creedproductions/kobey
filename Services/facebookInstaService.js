/**
 * facebookInstaService.js
 *
 * Facebook strategy chain (in order):
 *   1. snapsave.app  — same endpoint works for Facebook URLs too
 *   2. getfvid.com   — Facebook-specific scraper
 *   3. cobalt.tools  — tried across 3 public instances
 *   4. savefrom      — worker API fallback
 *   5. @mrnima       — npm package fallback
 *   6. fdown.net     — scraper fallback
 *   7. Direct HTML   — regex on page source, last resort
 *
 * Instagram strategy chain:
 *   1. snapsave.app
 *   2. snapinsta.app
 *
 * Return shape (Facebook success): { hd, sd, thumbnail, title }
 * Return shape (Instagram success): { status: true, data: [...] }
 */

const axios   = require('axios');
const cheerio = require('cheerio');

// ─── optional npm deps ────────────────────────────────────────────────────────

let mrnima;
try {
  mrnima = require('@mrnima/facebook-downloader');
} catch (_) {
  mrnima = null;
}

// ─── shared axios instance ────────────────────────────────────────────────────

const http = axios.create({
  timeout:      35_000,
  maxRedirects: 15,
  headers: {
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
    'Cache-Control':             'max-age=0',
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
    if (['mp4','mov','webm','mkv','avi','ts'].includes(ext))           return 'video';
    if (['jpg','jpeg','png','gif','webp','heic','avif'].includes(ext)) return 'image';
  } catch (_) {}
  const p = url.toLowerCase().split('?')[0];
  if (p.match(/\.(mp4|mov|webm|mkv|avi|ts)$/))        return 'video';
  if (p.match(/\.(jpg|jpeg|png|gif|webp|heic|avif)$/)) return 'image';
  if (p.includes('/t16/') || p.includes('/o1/v/') ||
      p.includes('/t50.') || p.includes('/video/'))    return 'video';
  if (p.includes('/t51.') || p.includes('/t39.'))      return 'image';
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

// ─── Strategy 1 : snapsave.app for Facebook ───────────────────────────────────
//
// snapsave handles Facebook URLs with the same POST endpoint used for Instagram.

async function trySnapsaveForFb(url) {
  const resp = await axios.post(
    'https://snapsave.app/action_download.php',
    `url=${encodeURIComponent(url)}`,
    {
      timeout: 25_000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   http.defaults.headers['User-Agent'],
        Accept:         '*/*',
        Origin:         'https://snapsave.app',
        Referer:        'https://snapsave.app/',
      },
    }
  );

  const html = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
  const $    = cheerio.load(html);
  let hd = '', sd = '';

  const thumb = $('img').first().attr('src') || '';

  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const text = $(a).text().toLowerCase();
    if (!href.includes('fbcdn.net') && !href.includes('fb.net') && !href.match(/\.mp4/i)) return;
    const realUrl = decodeCdnUrl(href);
    if (!hd && (text.includes('hd') || text.includes('high'))) { hd = realUrl; return; }
    if (!sd) sd = realUrl;
  });

  // Also check input value attributes
  if (!hd && !sd) {
    $('input[type="text"], input[type="hidden"]').each((_, el) => {
      const val = $(el).attr('value') || '';
      if (!val.includes('fbcdn.net') && !val.match(/\.mp4/i)) return;
      const id = ($(el).attr('id') || $(el).attr('name') || '').toLowerCase();
      if (!hd && id.includes('hd')) hd = val; else if (!sd) sd = val;
    });
  }

  console.log(`📘 snapsave-fb: hd=${hd.slice(0, 70)} sd=${sd.slice(0, 70)}`);
  if (!hd && !sd) throw new Error('snapsave-fb: no FB video links in response');
  return { hd, sd, thumbnail: thumb, title: $('title').text().trim() || 'Facebook Video' };
}

// ─── Strategy 2 : getfvid.com ────────────────────────────────────────────────

async function tryGetfvid(url) {
  const homeResp = await axios.get('https://getfvid.com/', {
    timeout: 12_000,
    headers: { 'User-Agent': http.defaults.headers['User-Agent'] },
  });

  const cookies = (homeResp.headers['set-cookie'] || [])
    .map(c => c.split(';')[0]).join('; ');

  const $home     = cheerio.load(homeResp.data || '');
  const csrfToken = $home('input[name="_token"]').val() || $home('input[name="csrf_token"]').val() || '';

  const body = new URLSearchParams({ url });
  if (csrfToken) body.append('_token', csrfToken);

  const resp = await axios.post(
    'https://getfvid.com/downloader',
    body.toString(),
    {
      timeout: 25_000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   http.defaults.headers['User-Agent'],
        Referer:        'https://getfvid.com/',
        Origin:         'https://getfvid.com',
        Cookie:         cookies,
        Accept:         'text/html,*/*;q=0.8',
      },
    }
  );

  const html = typeof resp.data === 'string' ? resp.data : '';
  if (!html) throw new Error('getfvid: empty response');

  const $   = cheerio.load(html);
  let hd = '', sd = '';

  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const text = $(a).text().toLowerCase();
    if (!href.match(/\.mp4/i) && !href.includes('fbcdn.net')) return;
    if (!hd && (text.includes('hd') || text.includes('high'))) { hd = href; return; }
    if (!sd) sd = href;
  });

  if (!hd && !sd) {
    $('[data-url],[data-href]').each((_, el) => {
      const val = $(el).attr('data-url') || $(el).attr('data-href') || '';
      if (val.match(/\.mp4/i) || val.includes('fbcdn.net')) { if (!sd) sd = val; }
    });
  }

  console.log(`📘 getfvid: hd=${hd.slice(0, 70)} sd=${sd.slice(0, 70)}`);
  if (!hd && !sd) throw new Error('getfvid: no video links found');

  const thumb = $('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || '';
  return { hd, sd, thumbnail: thumb, title: $('title').text().trim() || 'Facebook Video' };
}

// ─── Strategy 3 : cobalt.tools (multiple instances) ──────────────────────────

const COBALT_INSTANCES = [
  'https://api.cobalt.tools',
  'https://cobalt.api.timelessnesses.me',
  'https://co.wuk.sh',
];

async function tryCobalt(url) {
  for (const base of COBALT_INSTANCES) {
    try {
      const resp = await axios.post(
        `${base}/`,
        { url, videoQuality: 'max', filenameStyle: 'pretty', downloadMode: 'auto' },
        {
          timeout: 18_000,
          headers: {
            'Content-Type': 'application/json',
            Accept:         'application/json',
            'User-Agent':   http.defaults.headers['User-Agent'],
          },
        }
      );

      const data = resp.data;
      console.log(`🌐 cobalt [${base}] status=${data?.status}`);

      if (data?.status === 'stream' || data?.status === 'redirect' || data?.status === 'tunnel') {
        if (data.url) return { hd: data.url, sd: data.url, thumbnail: '', title: 'Facebook Video' };
        continue;
      }

      if (data?.status === 'picker' && Array.isArray(data.picker) && data.picker.length > 0) {
        const best = data.picker.find(p => p.type === 'video') || data.picker[0];
        return {
          hd:        best.url || '',
          sd:        data.picker[data.picker.length - 1]?.url || best.url || '',
          thumbnail: best.thumb || '',
          title:     'Facebook Video',
        };
      }
    } catch (e) {
      console.warn(`🌐 cobalt [${base}]: ${e.message}`);
    }
  }
  throw new Error('cobalt: all instances failed');
}

// ─── Strategy 4 : savefrom worker API ────────────────────────────────────────

async function trySavefrom(url) {
  const resp = await axios.get('https://worker.sf-tools.com/savefrom.php', {
    params:  { sf_url: url },
    timeout: 20_000,
    headers: {
      'User-Agent': http.defaults.headers['User-Agent'],
      Referer:      'https://en.savefrom.net/',
      Accept:       'application/json, text/javascript, */*;q=0.01',
    },
  });

  const data  = resp.data;
  if (!data) throw new Error('savefrom: empty response');

  const items = Array.isArray(data) ? data : (Array.isArray(data.url) ? data.url : []);
  if (!items.length) throw new Error('savefrom: no items');

  const hd = items.find(i => String(i.quality || '').includes('HD'))?.url || '';
  const sd = items.find(i => String(i.quality || '').includes('SD'))?.url || items[0]?.url || '';

  const hdUrl = typeof hd === 'string' ? hd : (Array.isArray(hd) ? hd[0] : '');
  const sdUrl = typeof sd === 'string' ? sd : (Array.isArray(sd) ? sd[0] : '');

  if (!hdUrl && !sdUrl) throw new Error('savefrom: no usable URLs');
  return {
    hd: hdUrl, sd: sdUrl,
    thumbnail: typeof data.thumb === 'string' ? data.thumb : '',
    title:     typeof data.title === 'string' ? data.title : 'Facebook Video',
  };
}

// ─── Strategy 5 : @mrnima/facebook-downloader ────────────────────────────────

async function tryMrnima(url) {
  if (!mrnima) throw new Error('@mrnima not installed');
  const result = await mrnima.facebook(url);
  if (!result || !result.status) throw new Error(`@mrnima: ${result?.msg || 'status false'}`);
  const links = result.result?.links || {};
  const hd    = links.HD || links.hd || '';
  const sd    = links.SD || links.sd || '';
  if (!hd && !sd) throw new Error('@mrnima: no links');
  return { hd, sd, thumbnail: result.result?.thumbnail || '', title: result.result?.title || 'Facebook Video' };
}

// ─── Strategy 6 : fdown.net ──────────────────────────────────────────────────

async function tryFdown(url) {
  const resp = await http.post(
    'https://fdown.net/download.php',
    `URLz=${encodeURIComponent(url)}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://fdown.net', Referer: 'https://fdown.net/' } }
  );
  const html = typeof resp.data === 'string' ? resp.data : '';
  if (!html) throw new Error('fdown: empty');

  const $ = cheerio.load(html);
  let hd = '', sd = '';

  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const text = $(a).text().toLowerCase();
    if (!href.includes('fbcdn.net') && !href.match(/\.mp4/i)) return;
    if (!hd && (text.includes('hd') || $(a).closest('[id*="HD"]').length)) hd = href;
    else if (!sd) sd = href;
  });

  if (!hd && !sd) {
    $('input[type="text"]').each((_, el) => {
      const val = $(el).attr('value') || '';
      if (!val.includes('fbcdn.net') && !val.match(/\.mp4/i)) return;
      const id = ($(el).attr('id') || '').toLowerCase();
      if (id.includes('hd') && !hd) hd = val; else if (!sd) sd = val;
    });
  }

  if (!hd && !sd) throw new Error('fdown: no links');
  return { hd, sd, thumbnail: $('img').first().attr('src') || '', title: $('title').text().trim() || 'Facebook Video' };
}

// ─── Strategy 7 : Direct Facebook HTML scrape ────────────────────────────────

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
  if (!html || html.length < 500) throw new Error('Direct scrape: too-short response');

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

  if (!hd && !sd) throw new Error('Direct scrape: no video URLs — login required');

  const $ = cheerio.load(html);
  return {
    hd, sd,
    thumbnail: $('meta[property="og:image"]').attr('content') || '',
    title:     $('meta[property="og:title"]').attr('content') || $('title').text().trim() || 'Facebook Video',
  };
}

// ─── Redirect resolution ──────────────────────────────────────────────────────
//
// share/r/TOKEN redirects via HTTP 302 but FB checks browser fingerprint.
// We attempt a full GET with browser headers; also check og:url in the response.

async function resolveCanonicalFbUrl(rawUrl) {
  if (
    rawUrl.match(/facebook\.com\/(watch|reel|video)\//) ||
    rawUrl.match(/facebook\.com\/[^/]+\/videos\/\d+/)   ||
    rawUrl.includes('facebook.com/watch?')
  ) return rawUrl;

  const url = rawUrl.replace('m.facebook.com', 'www.facebook.com');
  console.log(`🔗 Resolving redirect: ${url}`);

  try {
    const resp = await axios.get(url, {
      maxRedirects: 20,
      timeout:      18_000,
      validateStatus: () => true,
      headers: {
        'User-Agent':      http.defaults.headers['User-Agent'],
        Accept:            'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest':  'document',
        'Sec-Fetch-Mode':  'navigate',
        'Sec-Fetch-Site':  'none',
        'Cache-Control':   'max-age=0',
      },
    });

    const final =
      resp.request?.res?.responseUrl ||
      resp.request?.responseURL      ||
      (resp.config?.url !== url ? resp.config?.url : null);

    if (final && final !== url && !final.includes('/share/')) {
      console.log(`🔗 Resolved via redirect → ${final}`);
      return final;
    }

    // Check og:url in page source as fallback
    if (typeof resp.data === 'string' && resp.data.length > 500) {
      const $ = cheerio.load(resp.data);
      const ogUrl = $('meta[property="og:url"]').attr('content') || '';
      if (ogUrl && ogUrl.includes('facebook.com') && !ogUrl.includes('/share/')) {
        console.log(`🔗 Resolved via og:url → ${ogUrl}`);
        return ogUrl;
      }
    }
  } catch (e) {
    console.warn(`🔗 Redirect resolution failed: ${e.message}`);
  }

  console.warn(`🔗 Redirect unresolved — using original URL`);
  return url;
}

// ─── Facebook main entry ──────────────────────────────────────────────────────

async function downloadFacebook(rawUrl) {
  console.log(`📘 Facebook: starting for ${rawUrl}`);

  const canonicalUrl = await resolveCanonicalFbUrl(rawUrl);
  const urlsToTry   = [...new Set([canonicalUrl, rawUrl])];

  const errors   = [];
  const attempts = [];

  for (const u of urlsToTry) {
    const suf = (u === rawUrl && u !== canonicalUrl) ? '-orig' : '';
    attempts.push(
      { name: `snapsave${suf}`,    fn: () => trySnapsaveForFb(u) },
      { name: `getfvid${suf}`,     fn: () => tryGetfvid(u) },
      { name: `cobalt${suf}`,      fn: () => tryCobalt(u) },
      { name: `savefrom${suf}`,    fn: () => trySavefrom(u) },
      { name: `@mrnima${suf}`,     fn: () => tryMrnima(u) },
      { name: `fdown${suf}`,       fn: () => tryFdown(u) },
      { name: `direct-html${suf}`, fn: () => tryDirectHtmlScrape(u) },
    );
  }

  for (const { name, fn } of attempts) {
    try {
      console.log(`📘 Facebook: trying [${name}]`);
      const result = await fn();
      console.log(`✅ Facebook: [${name}] succeeded`);

      if (result && (result.hd || result.sd) && !result.data && !result.media) {
        return {
          hd:        result.hd        || '',
          sd:        result.sd        || '',
          title:     result.title     || 'Facebook Video',
          thumbnail: result.thumbnail || '',
        };
      }
      return result;
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
        Origin:         'https://snapsave.app',
        Referer:        'https://snapsave.app/',
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
    const type = detectType(best.href);
    items.push({ thumbnail: thumb || (type === 'image' ? realUrl : ''), url: realUrl, type, quality: qualityFromText(best.text) });
  });

  if (items.length > 0) { console.log(`✅ snapsave: ${items.length} item(s)`); return items; }

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

  if (items.length > 0) console.log(`✅ snapsave (link-scan): ${items.length}`);
  return items;
}

async function scrapeSnapinsta(igUrl) {
  const resp = await http.post(
    'https://snapinsta.app/api/ajaxSearch',
    `q=${encodeURIComponent(igUrl)}&t=media&lang=en`,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin:         'https://snapinsta.app',
        Referer:        'https://snapinsta.app/',
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
  if (url.includes('facebook.com') || url.includes('fb.watch')) {
    return downloadFacebook(url);
  }

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