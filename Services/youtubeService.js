'use strict';

/**
 * youtubeService.js — Robust YouTube player-only extractor (no /next parsing)
 *
 * Why this works better:
 * - Avoids Innertube /next parsing, which is what is crashing in your logs.
 * - Uses /player response (streamingData + videoDetails) only.
 * - Deciphers signatureCipher/cipher via yt.session.player.decipher().
 *
 * If you see LOGIN_REQUIRED ("confirm you're not a bot"), set YT_COOKIE env var.
 */

const { Innertube, UniversalCache } = require('youtubei.js');

const CACHE_DIR = process.env.YTJS_CACHE_DIR || '/tmp/ytjs-cache';
let _yt = null;

const CLIENTS = {
  TV_EMBEDDED: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
  IOS: 'iOS',
  ANDROID: 'ANDROID',
  MWEB: 'MWEB',
  WEB: 'WEB'
};

const CLIENT_ORDER = [
  CLIENTS.TV_EMBEDDED,
  CLIENTS.IOS,
  CLIENTS.ANDROID,
  CLIENTS.MWEB,
  CLIENTS.WEB
];

async function getYT() {
  if (_yt) return _yt;

  // Optional: pass cookies to reduce bot-check/login-required blocks
  const cookie = process.env.YT_COOKIE && process.env.YT_COOKIE.trim().length > 0
    ? process.env.YT_COOKIE.trim()
    : undefined;

  _yt = await Innertube.create({
    cache: new UniversalCache(true, CACHE_DIR),
    generate_session_locally: true,
    // Keep player retrieval enabled so deciphering works
    retrieve_player: true,
    lang: 'en',
    location: process.env.YT_LOCATION || 'US',
    cookie
  });

  return _yt;
}

// ─── Video ID extractor ──────────────────────────────────────────────────────
function extractVideoId(url) {
  try {
    const s = String(url);

    if (s.includes('youtu.be/')) {
      return s.split('youtu.be/')[1]?.split(/[?&/#]/)[0] || null;
    }

    const u = new URL(s);
    const v = u.searchParams.get('v');
    if (v && v.length === 11) return v;

    const p = u.pathname || '';
    if (p.includes('/shorts/') || p.includes('/embed/')) {
      return p.split('/').pop()?.split(/[?&/#]/)[0] || null;
    }

    const m = s.match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
    return m ? m[1] : null;
  } catch {
    const m = String(url).match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
    return m ? m[1] : null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function toInt(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function pickBestThumb(thumbnails, videoId) {
  const arr = Array.isArray(thumbnails) ? thumbnails : (thumbnails?.thumbnails || []);
  if (arr.length > 0) {
    // highest res usually last
    return arr[arr.length - 1]?.url || arr[0]?.url;
  }
  return `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
}

function mimeToExt(mimeType = '') {
  const m = String(mimeType).toLowerCase();
  if (m.includes('audio/mp4')) return 'm4a';
  if (m.includes('audio/webm')) return 'webm';
  if (m.includes('video/webm')) return 'webm';
  return 'mp4';
}

async function decipherUrl(yt, fmt, nsigCache) {
  if (!fmt) return null;
  if (fmt.url) return fmt.url;

  const player = yt?.session?.player;
  if (!player || typeof player.decipher !== 'function') return null;

  // YouTube can send either signatureCipher or cipher
  if (fmt.signatureCipher) {
    return await player.decipher(undefined, fmt.signatureCipher, undefined, nsigCache);
  }
  if (fmt.cipher) {
    return await player.decipher(undefined, undefined, fmt.cipher, nsigCache);
  }
  return null;
}

// Build format lists from streamingData (muxed + adaptive)
async function buildFormats(yt, streamingData) {
  const muxed = Array.isArray(streamingData?.formats) ? streamingData.formats : [];
  const adaptive = Array.isArray(streamingData?.adaptiveFormats) ? streamingData.adaptiveFormats : [];

  const nsigCache = new Map(); // improves performance per response

  const videoFormats = [];
  const audioFormats = [];

  // Muxed (video+audio)
  for (const f of muxed) {
    const height = toInt(f.height, 0);
    const hasVideo = !!height;
    const hasAudio = toInt(f.audioChannels, 0) > 0 || !!f.audioQuality;

    if (!hasVideo || !hasAudio) continue;

    const url = await decipherUrl(yt, f, nsigCache);
    if (!url) continue;

    const ext = mimeToExt(f.mimeType);
    videoFormats.push({
      quality: f.qualityLabel || `${height}p`,
      qualityNum: height,
      url,
      type: ext,
      extension: ext,
      filesize: f.contentLength ? toInt(f.contentLength, 'unknown') : 'unknown',
      fps: toInt(f.fps, 30),
      hasAudio: true,
      hasVideo: true,
      isAudioOnly: false,
      needsMerge: false,
      bitrate: toInt(f.bitrate, 0),
      itag: f.itag
    });
  }

  // Adaptive video-only + audio-only
  for (const f of adaptive) {
    const height = toInt(f.height, 0);
    const hasVideo = !!height;
    const hasAudio = toInt(f.audioChannels, 0) > 0 || !!f.audioQuality;

    const url = await decipherUrl(yt, f, nsigCache);
    if (!url) continue;

    const ext = mimeToExt(f.mimeType);

    if (hasAudio && !hasVideo) {
      const kbps = Math.round(toInt(f.bitrate, 128000) / 1000);
      audioFormats.push({
        quality: `${kbps}kbps Audio`,
        qualityNum: 0,
        url,
        type: ext,
        extension: ext,
        filesize: f.contentLength ? toInt(f.contentLength, 'unknown') : 'unknown',
        hasAudio: true,
        hasVideo: false,
        isAudioOnly: true,
        needsMerge: false,
        bitrate: kbps,
        itag: f.itag
      });
    } else if (hasVideo && !hasAudio) {
      // Video-only (best qualities usually require merge)
      videoFormats.push({
        quality: f.qualityLabel || `${height}p`,
        qualityNum: height,
        url,
        type: ext,
        extension: ext,
        filesize: f.contentLength ? toInt(f.contentLength, 'unknown') : 'unknown',
        fps: toInt(f.fps, 30),
        hasAudio: false,
        hasVideo: true,
        isAudioOnly: false,
        needsMerge: true,
        bitrate: toInt(f.bitrate, 0),
        itag: f.itag
      });
    }
  }

  // Sort best-first
  videoFormats.sort((a, b) => (b.qualityNum || 0) - (a.qualityNum || 0));
  audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  return { videoFormats, audioFormats };
}

// Call /player with a specific client (no parser heavy stuff)
async function playerResponse(yt, videoId, client) {
  // parse:false => raw response (avoids parser breakage)
  const res = await yt.actions.execute('/player', {
    videoId,
    client,
    parse: false
  });

  // Different youtubei.js versions may return { data } or raw object
  return res?.data || res;
}

async function tryClient(videoId, client) {
  try {
    const yt = await getYT();
    const data = await playerResponse(yt, videoId, client);

    const status = data?.playabilityStatus?.status;
    const reason =
      data?.playabilityStatus?.reason ||
      data?.playabilityStatus?.errorScreen?.playerErrorMessageRenderer?.reason?.simpleText ||
      data?.playabilityStatus?.errorScreen?.playerErrorMessageRenderer?.subreason?.simpleText ||
      '';

    if (status && status !== 'OK') {
      return { ok: false, client, status, reason: reason || status };
    }

    const streamingData = data?.streamingData;
    if (!streamingData) {
      return { ok: false, client, status: 'NO_STREAMING_DATA', reason: 'No streamingData in /player response' };
    }

    const yt = await getYT();
    const { videoFormats, audioFormats } = await buildFormats(yt, streamingData);

    if (videoFormats.length === 0 && audioFormats.length === 0) {
      return { ok: false, client, status: 'NO_USABLE_FORMATS', reason: '0 usable formats after decipher' };
    }

    const details = data?.videoDetails || {};
    const micro = data?.microformat?.playerMicroformatRenderer || {};

    const title = details.title || micro.title?.simpleText || micro.title || 'Unknown';
    const author = details.author || micro.ownerChannelName || 'Unknown';
    const duration = toInt(details.lengthSeconds, 0);

    const thumbnail = pickBestThumb(details.thumbnail?.thumbnails, videoId);
    const viewCount = toInt(details.viewCount, 0);

    return {
      ok: true,
      client,
      title,
      author,
      duration,
      thumbnail,
      viewCount,
      description: micro.description?.simpleText || micro.description || '',
      videoFormats,
      audioFormats
    };
  } catch (e) {
    return { ok: false, client, status: 'ERROR', reason: String(e?.message || e).slice(0, 200) };
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────
async function fetchYouTubeData(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL');

  console.log(`🎬 [youtube] player-only fetch: ${videoId}`);

  let lastError = null;

  for (const client of CLIENT_ORDER) {
    console.log(`   → trying client: ${client}`);
    const r = await tryClient(videoId, client);

    if (r.ok) {
      const allFormats = [
        ...r.videoFormats,
        ...r.audioFormats
      ];

      // Prefer muxed 360p (no merge) if present, else best muxed, else audio
      const muxedNoMerge = r.videoFormats.filter(f => f.hasAudio && f.hasVideo && !f.needsMerge);
      const defaultQuality =
        muxedNoMerge.find(f => f.qualityNum === 360) ||
        muxedNoMerge[0] ||
        r.audioFormats[0] ||
        r.videoFormats[0];

      console.log(`✅ [youtube] OK via ${r.client}: "${r.title}" formats=${allFormats.length}`);

      return {
        title: r.title,
        thumbnail: r.thumbnail,
        duration: r.duration,
        description: r.description,
        author: r.author,
        viewCount: r.viewCount,

        formats: allFormats,
        allFormats,
        videoFormats: r.videoFormats,
        audioFormats: r.audioFormats,

        url: defaultQuality?.url,
        selectedQuality: defaultQuality,

        videoId,
        isShorts: String(url).includes('/shorts/'),

        metadata: {
          videoId,
          author: r.author
        },

        _debug: {
          usedClient: r.client,
          videoFormats: r.videoFormats.length,
          audioFormats: r.audioFormats.length,
          defaultQuality: defaultQuality?.quality
        }
      };
    } else {
      lastError = r;
      console.warn(`   ✗ ${client}: ${r.status} ${r.reason ? `— ${r.reason}` : ''}`);
    }
  }

  // If we end here, all clients failed
  const msg =
    lastError?.status === 'LOGIN_REQUIRED'
      ? 'YouTube is requiring sign-in (bot check). Set YT_COOKIE env var (Cookie header string).'
      : 'YouTube blocked all client types on this server IP (or the video is restricted).';

  throw new Error(`YouTube download failed: ${msg} Last=${lastError?.status || 'UNKNOWN'} ${lastError?.reason || ''}`);
}

module.exports = { fetchYouTubeData };
