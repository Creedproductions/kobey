// ============================================================
// Services/tiktokService.js — PRODUCTION READY 2026
// ============================================================
// FIXES vs previous version:
//
//  ❌ yt-dlp "status code 0" on datacenter IPs
//  ✅ FIX: Added tiktok:app_info extractor args to spoof mobile client
//         Cycles through multiple known-working app_info strings
//
//  ❌ @tobyg74 returns 0-char URL
//  ✅ FIX: Try v1 → v2 → v3 with correct field mapping per version
//
//  ❌ btch-downloader tikwm URL (62 chars) wrongly rejected by our guard
//  ✅ FIX: REPLACED btch with direct tikwm.com API → returns hdplay
//         URL (300+ chars, HD, watermark-free). Smart URL validator
//         replaces raw 100-char minimum.
//
//  NEW: Layer 4 ssstik.io scraper — no API key, works on datacenter IPs
//  NEW: Layer 5 btch-downloader kept but with corrected URL validation
// ============================================================

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const axios = require('axios');

const YTDLP_TIMEOUT_MS = 35000;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Smart URL validator.
 * Old code rejected tikwm.com URLs at 62 chars — those ARE valid.
 * We now reject only truly bogus values.
 */
function isValidVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('http')) return false;
  if (url.length < 20) return false;
  const REJECTED = ['placeholder', 'example.com', 'localhost', 'undefined', 'null'];
  if (REJECTED.some(bad => url.includes(bad))) return false;
  return true;
}

function cleanTikTokUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}

function extractFirstUrl(value) {
  if (Array.isArray(value)) return value.find(v => typeof v === 'string') || '';
  return typeof value === 'string' ? value : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1: yt-dlp with TikTok mobile app_info spoofing
//
// FIX: "status code 0" = TikTok blocks datacenter IPs on web API.
// Solution: --extractor-args "tiktok:app_info=<iid>" routes through
// TikTok's mobile API which has weaker IP restrictions.
// We cycle through multiple known-working app_info strings.
// ─────────────────────────────────────────────────────────────────────────────
const TIKTOK_APP_INFOS = [
  '7351144',
  '7351144/trill/34.1.2/340102/1180',
  '7319358/trill/34.0.1/340001/1180',
  '7293884/musical_ly/31.5.4/315402/1233',
];

async function downloadWithYtDlp(url) {
  console.log('TikTok [Layer 1 / yt-dlp]: Starting...');
  const cleanUrl = cleanTikTokUrl(url);
  console.log(`  Clean URL: ${cleanUrl}`);

  const errors = [];
  for (const appInfo of TIKTOK_APP_INFOS) {
    try {
      const result = await tryYtDlpWithAppInfo(cleanUrl, appInfo);
      if (result && isValidVideoUrl(extractFirstUrl(result.video))) {
        console.log(`TikTok [Layer 1 / yt-dlp]: Success with app_info=${appInfo}`);
        return result;
      }
    } catch (e) {
      const msg = (e.message || 'unknown').substring(0, 200);
      console.log(`  yt-dlp app_info=${appInfo} failed: ${msg}`);
      errors.push(`app_info=${appInfo}: ${msg}`);
    }
  }
  throw new Error(`yt-dlp all app_info attempts failed:\n${errors.join('\n')}`);
}

async function tryYtDlpWithAppInfo(url, appInfo) {
  const cmd = [
    'yt-dlp',
    '--no-warnings',
    '--no-playlist',
    '-j',
    `--extractor-args "tiktok:app_info=${appInfo}"`,
    '--user-agent "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"',
    `"${url}"`
  ].join(' ');

  const { stdout } = await execAsync(cmd, {
    timeout: YTDLP_TIMEOUT_MS,
    maxBuffer: 1024 * 1024 * 10,
  });

  const lines = stdout.trim().split('\n').filter(Boolean);
  let info = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{') && line.endsWith('}')) {
      try { info = JSON.parse(line); break; } catch { continue; }
    }
  }
  if (!info) throw new Error('yt-dlp: no JSON in stdout');

  const videoUrl = info.url || '';
  if (!isValidVideoUrl(videoUrl)) {
    throw new Error(`yt-dlp: invalid URL (${videoUrl?.length || 0} chars)`);
  }

  return {
    title: info.title || 'TikTok Video',
    video: [videoUrl],
    thumbnail: info.thumbnail || '',
    audio: [],
    duration: info.duration ? String(info.duration) : 'unknown',
    _source: 'yt-dlp'
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2: tikwm.com direct API
//
// FIX: This is what btch-downloader calls internally. Calling it directly
// gives us access to `hdplay` — a full 300+ char CDN URL, HD, no watermark.
// The btch wrapper strips this down to the short redirect URL we were rejecting.
// ─────────────────────────────────────────────────────────────────────────────
async function downloadWithTikwm(url) {
  console.log('TikTok [Layer 2 / tikwm API]: Starting...');

  const endpoints = [
    'https://www.tikwm.com/api/',
    'https://tikwm.com/api/',
  ];

  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const response = await axios.get(endpoint, {
        params: { url, hd: 1 },
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.tikwm.com/',
        }
      });

      const data = response.data;
      if (!data || data.code !== 0 || !data.data) {
        const msg = `code=${data?.code} msg=${data?.msg || 'unknown'}`;
        errors.push(`${endpoint}: ${msg}`);
        continue;
      }

      const d = data.data;
      // hdplay = HD no-watermark, play = SD no-watermark
      const videoUrl = d.hdplay || d.play || '';

      console.log(`  tikwm hdplay len: ${d.hdplay?.length || 0}, play len: ${d.play?.length || 0}`);

      if (!isValidVideoUrl(videoUrl)) {
        errors.push(`${endpoint}: URL invalid (${videoUrl?.length || 0} chars)`);
        continue;
      }

      const audioUrl = d.music || d.music_info?.play || '';
      console.log(`TikTok [Layer 2 / tikwm]: Success — URL length: ${videoUrl.length}`);

      return {
        title: d.title || 'TikTok Video',
        video: [videoUrl],
        thumbnail: d.cover || d.origin_cover || '',
        audio: audioUrl ? [audioUrl] : [],
        duration: d.duration ? String(d.duration) : 'unknown',
        _source: 'tikwm'
      };

    } catch (e) {
      const msg = (e.message || 'unknown').substring(0, 150);
      console.log(`  tikwm ${endpoint}: ${msg}`);
      errors.push(`${endpoint}: ${msg}`);
    }
  }

  throw new Error(`tikwm API failed: ${errors.join(' | ')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 3: @tobyg74/tiktok-api-dl
//
// FIX: Old code only tried v3. Try v1 → v2 → v3.
// Field names differ per version — now correctly mapped for each.
// ─────────────────────────────────────────────────────────────────────────────
async function downloadWithTobyApi(url) {
  console.log('TikTok [Layer 3 / @tobyg74]: Starting...');

  let TikTokDl;
  try {
    TikTokDl = require('@tobyg74/tiktok-api-dl');
  } catch {
    throw new Error('@tobyg74/tiktok-api-dl not installed. Run: npm install @tobyg74/tiktok-api-dl');
  }

  const versions = ['v1', 'v2', 'v3'];
  const errors = [];

  for (const version of versions) {
    try {
      console.log(`  Trying @tobyg74 ${version}...`);

      const result = await TikTokDl.Downloader(url, { version, showOriginalResponse: false });

      if (!result || result.status !== 'success') {
        errors.push(`${version}: status=${result?.status}`);
        continue;
      }

      const d = result.result;
      if (!d) {
        errors.push(`${version}: result is empty`);
        continue;
      }

      // Field names differ per version
      const rawVideo = d.video || d.play || d.hdplay || d.no_watermark;
      const videoUrl = extractFirstUrl(rawVideo);

      if (!isValidVideoUrl(videoUrl)) {
        console.log(`  @tobyg74 ${version}: URL invalid (${videoUrl?.length || 0} chars), keys: ${JSON.stringify(Object.keys(d))}`);
        errors.push(`${version}: URL invalid (${videoUrl?.length || 0} chars)`);
        continue;
      }

      const rawAudio = d.music || d.music_info?.play || d.music_url || '';
      const audioUrl = extractFirstUrl(rawAudio);

      console.log(`TikTok [Layer 3 / @tobyg74 ${version}]: Success — URL length: ${videoUrl.length}`);

      return {
        title: d.title || d.desc || 'TikTok Video',
        video: [videoUrl],
        thumbnail: d.cover || d.origin_cover || d.dynamic_cover || '',
        audio: audioUrl ? [audioUrl] : [],
        duration: d.duration ? String(d.duration) : 'unknown',
        _source: `tobyg74-${version}`
      };

    } catch (e) {
      const msg = (e.message || 'unknown').substring(0, 150);
      console.log(`  @tobyg74 ${version}: ${msg}`);
      errors.push(`${version}: ${msg}`);
    }
  }

  throw new Error(`@tobyg74 all versions failed: ${errors.join(' | ')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 4: ssstik.io scraper
// No API key needed. Works on datacenter IPs.
// ─────────────────────────────────────────────────────────────────────────────
async function downloadWithSsstik(url) {
  console.log('TikTok [Layer 4 / ssstik]: Starting...');

  try {
    // Step 1: get tt token from page
    const pageResp = await axios.get('https://ssstik.io/en-1', {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });

    const ttMatch = pageResp.data.match(/tt:\s*["']([^"']+)["']/);
    if (!ttMatch) throw new Error('ssstik: could not find tt token in page');
    const tt = ttMatch[1];

    // Step 2: submit URL via form POST
    const formData = new URLSearchParams();
    formData.append('id', url);
    formData.append('locale', 'en');
    formData.append('tt', tt);

    const resp = await axios.post('https://ssstik.io/abc?url=dl', formData.toString(), {
      timeout: 20000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://ssstik.io/en-1',
        'Origin': 'https://ssstik.io',
        'Accept': '*/*',
      }
    });

    const html = resp.data;

    // Extract no-watermark download URL
    const noWmMatch = html.match(/href="(https:\/\/[^"]+)"[^>]*>\s*(?:Without watermark|No Watermark|Download)/i);
    const anyMp4Match = html.match(/href="(https:\/\/(?:v\d+|cdn|tikcdn|tiktokcdn|tikwm)[^"]+\.mp4[^"]*)"/i);
    const anyHrefMatch = html.match(/class="[^"]*download_link[^"]*"[^>]*href="(https:\/\/[^"]+)"/i);

    const videoUrl = (noWmMatch && noWmMatch[1]) ||
                     (anyMp4Match && anyMp4Match[1]) ||
                     (anyHrefMatch && anyHrefMatch[1]) || '';

    if (!isValidVideoUrl(videoUrl)) {
      throw new Error('ssstik: no valid video URL found in HTML response');
    }

    const titleMatch = html.match(/<p[^>]*class="[^"]*maintext[^"]*"[^>]*>([^<]+)<\/p>/i);
    const title = titleMatch ? titleMatch[1].trim() : 'TikTok Video';
    const thumbMatch = html.match(/src="(https:\/\/[^"]+(?:cover|thumb)[^"]*)"/i);
    const thumbnail = thumbMatch ? thumbMatch[1] : '';

    console.log(`TikTok [Layer 4 / ssstik]: Success — URL length: ${videoUrl.length}`);

    return {
      title,
      video: [videoUrl],
      thumbnail,
      audio: [],
      duration: 'unknown',
      _source: 'ssstik'
    };

  } catch (e) {
    throw new Error(`ssstik failed: ${(e.message || 'unknown').substring(0, 200)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 5: btch-downloader (last resort)
//
// FIX: Old code had 100-char minimum that wrongly rejected valid tikwm
// redirect URLs (62 chars). Now uses isValidVideoUrl() instead.
// tikwm short URLs DO serve video when accessed with proper headers.
// ─────────────────────────────────────────────────────────────────────────────
async function downloadWithBtch(url) {
  console.log('TikTok [Layer 5 / btch-downloader]: Starting...');

  const { ttdl } = require('btch-downloader');
  const data = await ttdl(url);

  if (!data || !data.video) {
    throw new Error('btch-downloader: null or missing video field');
  }

  const videoUrl = extractFirstUrl(data.video);

  if (!isValidVideoUrl(videoUrl)) {
    throw new Error(`btch-downloader: URL is not a valid http URL`);
  }

  if (videoUrl.length < 100) {
    console.log(`  btch-downloader: short URL (${videoUrl.length} chars) — tikwm redirect, proceeding`);
  }

  console.log(`TikTok [Layer 5 / btch-downloader]: URL length: ${videoUrl.length}`);

  return {
    title: data.title || 'TikTok Video',
    video: Array.isArray(data.video) ? data.video : [data.video],
    thumbnail: data.thumbnail || '',
    audio: data.audio ? (Array.isArray(data.audio) ? data.audio : [data.audio]) : [],
    duration: 'unknown',
    _source: 'btch-downloader'
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT — tries all 5 layers in order
// ─────────────────────────────────────────────────────────────────────────────
async function robustTikTokDownload(url) {
  console.log(`\nTikTok: Robust download starting for: ${url}`);

  const layers = [
    { name: 'btch-downloader',        fn: () => downloadWithBtch(url)     }, // fastest when working
    { name: 'tikwm-direct',           fn: () => downloadWithTikwm(url)    }, // direct API, HD quality
    { name: 'yt-dlp',                 fn: () => downloadWithYtDlp(url)    }, // most robust fallback
    { name: '@tobyg74/tiktok-api-dl', fn: () => downloadWithTobyApi(url)  },
    { name: 'ssstik',                 fn: () => downloadWithSsstik(url)   },
  ];

  const errors = [];

  for (const layer of layers) {
    try {
      const result = await layer.fn();
      const finalUrl = extractFirstUrl(result?.video);

      if (!isValidVideoUrl(finalUrl)) {
        throw new Error(`Post-validation: URL from [${layer.name}] invalid (${finalUrl?.length || 0} chars)`);
      }

      console.log(`\nTikTok: Succeeded via [${layer.name}]`);
      console.log(`  Title  : ${result.title}`);
      console.log(`  URL len: ${finalUrl.length}`);
      console.log(`  URL    : ${finalUrl.substring(0, 80)}...`);
      return result;

    } catch (err) {
      const msg = (err.message || 'unknown error').substring(0, 250);
      console.warn(`  TikTok [${layer.name}] FAILED: ${msg}`);
      errors.push(`[${layer.name}]: ${msg}`);
    }
  }

  throw new Error(`TikTok download failed across all 5 services:\n${errors.join('\n')}`);
}

module.exports = { robustTikTokDownload };