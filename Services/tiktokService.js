// ============================================================
// Services/tiktokService.js — Production 2026
// tikwm direct API only.
//
// Returns BOTH:
//   video[0] = hdplay — full TikTok CDN URL (HD, best quality)
//   video[1] = tikwm proxy URL — always works regardless of IP/headers
//              format: https://tikwm.com/video/media/play/{videoId}.mp4
//
// Flutter download_service uses video[0] first, falls back to video[1]
// if CDN download fails (e.g. on simulator or restricted IPs).
// ============================================================

const axios = require('axios');

const TIKWM_ENDPOINTS = [
  'https://www.tikwm.com/api/',
  'https://tikwm.com/api/',
];

function isValidVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('http')) return false;
  if (url.length < 20) return false;
  return true;
}

// Extract TikTok video ID from any TikTok URL format
function extractVideoId(url) {
  try {
    // Standard: tiktok.com/@user/video/1234567890
    const match = url.match(/\/video\/(\d+)/);
    if (match) return match[1];

    // Short: vt.tiktok.com/xxx or vm.tiktok.com/xxx
    // These get resolved to the full URL by the API
    return null;
  } catch {
    return null;
  }
}

async function robustTikTokDownload(url) {
  console.log(`\nTikTok: Starting download for: ${url}`);

  const errors = [];

  for (const endpoint of TIKWM_ENDPOINTS) {
    try {
      console.log(`TikTok [tikwm]: Trying ${endpoint}...`);

      const response = await axios.get(endpoint, {
        params: { url, hd: 1 },
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.tikwm.com/',
        },
      });

      const data = response.data;

      if (!data || data.code !== 0 || !data.data) {
        const msg = `code=${data?.code} msg=${data?.msg || 'unknown'}`;
        console.log(`  ${endpoint}: ${msg}`);
        errors.push(`${endpoint}: ${msg}`);
        continue;
      }

      const d = data.data;

      // Primary: hdplay (HD, no watermark, direct TikTok CDN URL)
      // Fallback: play (SD, no watermark, direct TikTok CDN URL)
      const cdnUrl = d.hdplay || d.play || '';

      console.log(`  tikwm hdplay len : ${d.hdplay?.length || 0}`);
      console.log(`  tikwm play len   : ${d.play?.length || 0}`);

      if (!isValidVideoUrl(cdnUrl)) {
        errors.push(`${endpoint}: no valid URL`);
        continue;
      }

      // Build tikwm proxy URL as a guaranteed fallback.
      // tikwm hosts videos at /video/media/play/{id}.mp4 — no CDN headers needed.
      // Extract video ID from the API response (d.id) or from the URL.
      const videoId = d.id || extractVideoId(url);
      const proxyUrl = videoId
        ? `https://www.tikwm.com/video/media/play/${videoId}.mp4`
        : null;

      console.log(`TikTok: Success — CDN URL length: ${cdnUrl.length}`);
      if (proxyUrl) console.log(`TikTok: Proxy URL: ${proxyUrl}`);

      const audioUrl = d.music || d.music_info?.play || '';

      // Return both URLs: Flutter tries cdnUrl first (HD), falls back to proxyUrl
      const videoUrls = proxyUrl ? [cdnUrl, proxyUrl] : [cdnUrl];

      return {
        title: d.title || 'TikTok Video',
        video: videoUrls,
        thumbnail: d.cover || d.origin_cover || '',
        audio: audioUrl ? [audioUrl] : [],
        duration: d.duration ? String(d.duration) : 'unknown',
        _source: 'tikwm',
        // Tell Flutter exactly what headers to use when downloading the CDN URL
        _downloadHeaders: {
          'Referer': 'https://www.tiktok.com/',
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8',
        },
      };

    } catch (e) {
      const msg = (e.message || 'unknown').substring(0, 150);
      console.log(`  tikwm ${endpoint}: ${msg}`);
      errors.push(`${endpoint}: ${msg}`);
    }
  }

  throw new Error(`TikTok download failed: ${errors.join(' | ')}`);
}

module.exports = { robustTikTokDownload };