'use strict';

const { Innertube, UniversalCache } = require('youtubei.js');

// ─── Singleton: create once and reuse across requests ────────────────────────
let _innertube = null;

async function getInnertube() {
  if (_innertube) return _innertube;

  _innertube = await Innertube.create({
    cache: new UniversalCache(true, '/tmp/youtubei-cache'),

    client_type: 'ANDROID',
    generate_session_locally: true,
  });

  return _innertube;
}

// ─── ID extractor (unchanged from your original) ─────────────────────────────
function extractVideoId(url) {
  try {
    if (url.includes('youtu.be/')) {
      return url.split('youtu.be/')[1]?.split(/[?&/#]/)[0];
    }
    const urlObj = new URL(url);
    const v = urlObj.searchParams.get('v');
    if (v && v.length === 11) return v;
    const p = urlObj.pathname;
    if (p.includes('/shorts/') || p.includes('/embed/')) {
      return p.split('/').pop()?.split(/[?&/#]/)[0];
    }
  } catch {
    const m = String(url).match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
    return m ? m[1] : null;
  }
  return null;
}

// ─── Format helpers ───────────────────────────────────────────────────────────

/**
 * InnerTube returns two arrays:
 *   formats          → muxed (video+audio together), usually up to 360p
 *   adaptive_formats → separate video-only OR audio-only streams
 *
 * For a downloader that returns direct URLs we want:
 *   1. Muxed streams  → ready to download immediately, no merge needed
 *   2. Audio-only     → for music downloads
 *
 * We intentionally skip video-only adaptive streams because merging requires
 * FFmpeg on the server. If you add FFmpeg later, uncomment the video-only block.
 */
function buildQualityOptions(streamingData) {
  const videoQualities = [];
  const audioQualities = [];
  const seenHeights = new Set();

  // ── 1. Muxed streams (have both video+audio, direct download) ─────────────
  const muxed = streamingData.formats ?? [];

  muxed
    .filter(f => f.url && f.has_video && f.has_audio && f.height)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
    .forEach(f => {
      const h = f.height;
      if (seenHeights.has(h) || h < 144) return;
      seenHeights.add(h);

      videoQualities.push({
        quality:      `${h}p`,
        qualityNum:   h,
        url:          f.url,
        type:         f.mime_type?.split(';')[0]?.split('/')[1] || 'mp4',
        extension:    'mp4',
        filesize:     f.content_length ? Number(f.content_length) : 'unknown',
        fps:          f.fps ?? 30,
        hasAudio:     true,
        hasVideo:     true,
        isAudioOnly:  false,
        needsMerge:   false,
        bitrate:      f.bitrate ?? 0,
        itag:         f.itag,
      });
    });

  // ── 2. Audio-only adaptive streams ────────────────────────────────────────
  const adaptive = streamingData.adaptive_formats ?? [];

  adaptive
    .filter(f => f.url && !f.has_video && f.has_audio)
    .sort((a, b) => (b.audio_quality === 'AUDIO_QUALITY_HIGH' ? 1 : 0) -
                    (a.audio_quality === 'AUDIO_QUALITY_HIGH' ? 1 : 0) ||
                    (b.bitrate ?? 0) - (a.bitrate ?? 0))
    .slice(0, 3)
    .forEach(f => {
      const kbps = Math.round((f.bitrate ?? 128000) / 1000);
      const ext  = f.mime_type?.includes('webm') ? 'webm' : 'm4a';

      audioQualities.push({
        quality:      `${kbps}kbps Audio`,
        qualityNum:   0,
        url:          f.url,
        type:         ext,
        extension:    ext,
        filesize:     f.content_length ? Number(f.content_length) : 'unknown',
        hasAudio:     true,
        hasVideo:     false,
        isAudioOnly:  true,
        needsMerge:   false,
        bitrate:      kbps,
        itag:         f.itag,
      });
    });

  return { videoQualities, audioQualities };
}

// ─── Main export (same signature as your old service) ────────────────────────

async function fetchYouTubeData(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL');

  console.log(`🎬 [youtubei.js] Processing: ${videoId}`);

  let yt;
  try {
    yt = await getInnertube();
  } catch (e) {
    throw new Error(`Failed to initialise InnerTube session: ${e.message}`);
  }

  let info;
  try {
    // getBasicInfo is faster than getInfo (skips recommendations/comments)
    info = await yt.getBasicInfo(videoId, 'ANDROID');
  } catch (e) {
    const msg = String(e.message ?? e);
    console.error('❌ [youtubei.js] getBasicInfo error:', msg);

    if (msg.toLowerCase().includes('private') || msg.includes('LOGIN_REQUIRED')) {
      throw new Error('Video is private or age-restricted');
    }
    if (msg.toLowerCase().includes('unavailable') || msg.includes('removed')) {
      throw new Error('Video not found or has been removed');
    }
    if (msg.includes('429') || msg.toLowerCase().includes('too many requests')) {
      throw new Error('YouTube rate limit hit. Try again in a moment.');
    }

    throw new Error(`YouTube fetch failed: ${msg}`);
  }

  const streamingData = info.streaming_data;
  if (!streamingData) {
    throw new Error('No streaming data returned — video may be restricted or region-locked');
  }

  const details = info.basic_info;

  const { videoQualities, audioQualities } = buildQualityOptions(streamingData);

  console.log(`🎥 Video (muxed): ${videoQualities.length}  🎵 Audio-only: ${audioQualities.length}`);

  if (videoQualities.length === 0 && audioQualities.length === 0) {
    throw new Error('No downloadable formats found for this video');
  }

  const qualityOptions = [
    ...videoQualities.sort((a, b) => b.qualityNum - a.qualityNum),
    ...audioQualities,
  ];

  const defaultQuality =
    videoQualities.find(q => q.qualityNum === 360) ||
    videoQualities[0] ||
    audioQualities[0];

  const thumbnail =
    details.thumbnail?.[0]?.url ||
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;

  return {
    title:           details.title   || 'Unknown',
    thumbnail,
    duration:        details.duration ?? 0,
    description:     details.short_description || '',
    author:          details.author || 'Unknown',
    viewCount:       details.view_count ?? 0,

    formats:         qualityOptions,
    allFormats:      qualityOptions,
    videoFormats:    videoQualities,
    audioFormats:    audioQualities,

    url:             defaultQuality.url,
    selectedQuality: defaultQuality,

    videoId,
    isShorts: url.includes('/shorts/'),

    metadata: {
      videoId,
      author:  details.author || 'Unknown',
    },

    _debug: {
      totalMuxed:     (streamingData.formats ?? []).length,
      totalAdaptive:  (streamingData.adaptive_formats ?? []).length,
      videoQualities: videoQualities.length,
      audioQualities: audioQualities.length,
      defaultQuality: defaultQuality.quality,
      client:         'ANDROID (InnerTube)',
    },
  };
}

module.exports = {
  fetchYouTubeData,
};
