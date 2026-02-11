'use strict';

/**
 * youtubeService.js — youtubei.js InnerTube API with multi-client fallback
 * 
 * Added support for:
 * - Cookie authentication to bypass age-restriction
 * - Better error handling for restricted content
 * - iOS client with cookies for age-restricted videos
 */

const { Innertube, UniversalCache } = require('youtubei.js');
const fs = require('fs').promises;
const path = require('path');

// ─── Configuration ───────────────────────────────────────────
const COOKIES_PATH = process.env.YT_COOKIES_PATH || '/tmp/yt-cookies.json';
const CLIENT_ORDER = ['IOS', 'TV_EMBEDDED', 'ANDROID', 'WEB']; // Added WEB as last resort

// ─── Singleton pool — one instance per client type ──────────
const _pool = {};

/**
 * Load cookies from file if they exist
 */
async function loadCookies() {
  try {
    if (process.env.YT_COOKIES) {
      // Direct cookie string from env
      return JSON.parse(process.env.YT_COOKIES);
    }
    
    const cookieFile = await fs.readFile(COOKIES_PATH, 'utf8');
    return JSON.parse(cookieFile);
  } catch (e) {
    return null;
  }
}

/**
 * Create InnerTube client with optional cookies
 */
async function createInnerTubeClient(clientType, useCookies = false) {
  const clientConfig = {
    cache: new UniversalCache(true, `/tmp/ytjs-cache-${clientType}`),
    client_type: clientType,
    generate_session_locally: true,
    location: '',
    lang: 'en',
  };

  // Add cookies if requested and available
  if (useCookies) {
    const cookies = await loadCookies();
    if (cookies) {
      console.log(`🍪 [youtubei] Using cookies for ${clientType}`);
      clientConfig.cookie = cookies;
      
      // Also try to set authorization header if we have SAPISID
      if (cookies.SAPISID) {
        const timestamp = Math.floor(Date.now() / 1000);
        const hash = require('crypto')
          .createHash('sha1')
          .update(`${timestamp} ${cookies.SAPISID} ${cookies.ORIGIN || 'https://www.youtube.com'}`)
          .digest('hex');
        
        clientConfig.headers = {
          'Authorization': `SAPISIDHASH ${timestamp}_${hash}`,
          'X-Origin': 'https://www.youtube.com',
        };
      }
    }
  }

  return await Innertube.create(clientConfig);
}

async function getClient(clientType = 'IOS', useCookies = false) {
  const cacheKey = `${clientType}-${useCookies ? 'auth' : 'anon'}`;
  
  if (_pool[cacheKey]) return _pool[cacheKey];

  console.log(`🔧 [youtubei] Creating InnerTube client: ${clientType}${useCookies ? ' (with cookies)' : ''}`);

  _pool[cacheKey] = await createInnerTubeClient(clientType, useCookies);
  return _pool[cacheKey];
}

// ─── Video ID extractor ─────────────────────────────────────
function extractVideoId(url) {
  try {
    if (url.includes('youtu.be/')) {
      return url.split('youtu.be/')[1]?.split(/[?&/#]/)[0];
    }
    const u = new URL(url);
    const v = u.searchParams.get('v');
    if (v && v.length === 11) return v;
    const p = u.pathname;
    if (p.includes('/shorts/') || p.includes('/embed/')) {
      return p.split('/').pop()?.split(/[?&/#]/)[0];
    }
  } catch {
    const m = String(url).match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
    return m ? m[1] : null;
  }
  return null;
}

// ─── Format builder ─────────────────────────────────────────
function buildQualityOptions(streamingData) {
  const videoQualities = [];
  const audioQualities = [];
  const seenHeights = new Set();

  // Muxed (video + audio in one stream)
  const muxed = streamingData.formats ?? [];

  muxed
    .filter(f => f.url && f.has_video && f.has_audio && f.height)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
    .forEach(f => {
      const h = f.height;
      if (seenHeights.has(h) || h < 144) return;
      seenHeights.add(h);

      videoQualities.push({
        quality:     `${h}p`,
        qualityNum:  h,
        url:         f.url,
        type:        'mp4',
        extension:   'mp4',
        filesize:    f.content_length ? Number(f.content_length) : 'unknown',
        fps:         f.fps ?? 30,
        hasAudio:    true,
        hasVideo:    true,
        isAudioOnly: false,
        needsMerge:  false,
        bitrate:     f.bitrate ?? 0,
        itag:        f.itag,
      });
    });

  // Audio-only adaptive streams
  const adaptive = streamingData.adaptive_formats ?? [];

  adaptive
    .filter(f => f.url && !f.has_video && f.has_audio)
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
    .slice(0, 3)
    .forEach(f => {
      const kbps = Math.round((f.bitrate ?? 128000) / 1000);
      const ext  = f.mime_type?.includes('webm') ? 'webm' : 'm4a';

      audioQualities.push({
        quality:     `${kbps}kbps Audio`,
        qualityNum:  0,
        url:         f.url,
        type:        ext,
        extension:   ext,
        filesize:    f.content_length ? Number(f.content_length) : 'unknown',
        hasAudio:    true,
        hasVideo:    false,
        isAudioOnly: true,
        needsMerge:  false,
        bitrate:     kbps,
        itag:        f.itag,
      });
    });

  return { videoQualities, audioQualities };
}

/**
 * Check if error indicates age-restriction
 */
function isAgeRestrictedError(error) {
  const msg = String(error.message || error).toLowerCase();
  return msg.includes('age') || 
         msg.includes('restricted') || 
         msg.includes('sign in') ||
         msg.includes('login') ||
         msg.includes('confirm your age');
}

/**
 * Try one client, return null on soft failures
 */
async function tryClient(videoId, clientType, useCookies = false) {
  console.log(`   → trying client: ${clientType}${useCookies ? ' (with cookies)' : ''}`);
  
  try {
    const yt = await getClient(clientType, useCookies);
    const info = await yt.getInfo(videoId); // Use getInfo instead of getBasicInfo for more data

    if (!info?.streaming_data) {
      // Check if it's age-restricted but we don't have cookies
      if (isAgeRestrictedError(info?.playability_status?.reason) && !useCookies) {
        console.warn(`   ✗ ${clientType}: age-restricted - retry with cookies`);
        return { ageRestricted: true };
      }
      console.warn(`   ✗ ${clientType}: no streaming_data`);
      return null;
    }

    const { videoQualities, audioQualities } = buildQualityOptions(info.streaming_data);

    if (videoQualities.length === 0 && audioQualities.length === 0) {
      console.warn(`   ✗ ${clientType}: 0 usable formats`);
      return null;
    }

    console.log(`   ✓ ${clientType}: ${videoQualities.length}v + ${audioQualities.length}a formats`);
    return { 
      info, 
      videoQualities, 
      audioQualities, 
      clientType,
      playabilityStatus: info.playability_status
    };

  } catch (e) {
    const msg = String(e.message ?? e);
    
    // Check for age-restriction in error
    if (isAgeRestrictedError(e) && !useCookies) {
      console.warn(`   ✗ ${clientType}: age-restricted error - should retry with cookies`);
      return { ageRestricted: true };
    }
    
    // Invalidate cached client on transient errors
    const isSoft = msg.includes('429') || 
                   msg.toLowerCase().includes('timeout') ||
                   msg.includes('ECONNRESET');
    if (isSoft) {
      const cacheKey = `${clientType}-${useCookies ? 'auth' : 'anon'}`;
      delete _pool[cacheKey];
    }
    
    console.warn(`   ✗ ${clientType} error: ${msg.slice(0, 120)}`);
    return null;
  }
}

// ─── Main export ────────────────────────────────────────────
async function fetchYouTubeData(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL');

  console.log(`🎬 [youtubei] Fetching: ${videoId}`);

  let result = null;
  let ageRestricted = false;

  // First try: Standard clients without cookies
  for (const clientType of CLIENT_ORDER) {
    const response = await tryClient(videoId, clientType, false);
    if (response?.ageRestricted) {
      ageRestricted = true;
      continue;
    }
    if (response) {
      result = response;
      break;
    }
  }

  // If age-restricted detected, try with cookies
  if (!result && ageRestricted) {
    console.log(`🔒 Age-restricted video detected, attempting with cookies...`);
    
    for (const clientType of ['IOS', 'WEB']) { // iOS and WEB work best with auth
      const response = await tryClient(videoId, clientType, true);
      if (response && !response.ageRestricted) {
        result = response;
        break;
      }
    }
  }

  if (!result) {
    throw new Error(
      'Cannot access this video (age-restricted or region-locked). ' +
      'To access age-restricted videos, please provide YouTube cookies. ' +
      'Set YT_COOKIES env var or place cookies in /tmp/yt-cookies.json'
    );
  }

  const { info, videoQualities, audioQualities, clientType: usedClient } = result;
  const details = info.basic_info;

  const qualityOptions = [
    ...videoQualities.sort((a, b) => b.qualityNum - a.qualityNum),
    ...audioQualities,
  ];

  const defaultQuality =
    videoQualities.find(q => q.qualityNum === 360) ||
    videoQualities[0] ||
    audioQualities[0];

  // Get thumbnail
  const thumbArr = Array.isArray(details.thumbnail)
    ? details.thumbnail
    : details.thumbnail?.thumbnails ?? [];
  const thumbnail =
    thumbArr[0]?.url ||
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;

  console.log(`✅ [youtubei] Done via ${usedClient}: "${details.title}" — ${qualityOptions.length} formats`);

  return {
    title:        details.title             || 'Unknown',
    thumbnail,
    duration:     details.duration          ?? 0,
    description:  details.short_description || '',
    author:       details.author            || 'Unknown',
    viewCount:    details.view_count        ?? 0,

    formats:      qualityOptions,
    allFormats:   qualityOptions,
    videoFormats: videoQualities,
    audioFormats: audioQualities,

    url:             defaultQuality.url,
    selectedQuality: defaultQuality,

    videoId,
    isShorts: url.includes('/shorts/'),

    metadata: {
      videoId,
      author: details.author || 'Unknown',
      isAgeRestricted: ageRestricted,
    },

    _debug: {
      usedClient,
      usedCookies: result.playabilityStatus?.status === 'OK',
      totalMuxed:     (info.streaming_data?.formats ?? []).length,
      totalAdaptive:  (info.streaming_data?.adaptive_formats ?? []).length,
      videoQualities: videoQualities.length,
      audioQualities: audioQualities.length,
      defaultQuality: defaultQuality.quality,
      playabilityStatus: info.playability_status?.status,
    },
  };
}

module.exports = { fetchYouTubeData };
