// Services/youtubeService.js
const ytdl = require('ytdl-core');

/**
 * Normalize various YouTube URL formats to a standard watch URL
 */
function normalizeYouTubeUrl(url) {
  if (!url) return '';

  // Short link: https://youtu.be/VIDEOID
  if (url.includes('youtu.be/')) {
    const videoId = url.split('youtu.be/')[1].split('?')[0].split('&')[0];
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  // Mobile: https://m.youtube.com/...
  if (url.includes('m.youtube.com')) {
    return url.replace('m.youtube.com', 'www.youtube.com');
  }

  // Shorts: keep as-is but normalized host
  if (url.includes('/shorts/')) {
    if (!url.includes('www.youtube.com')) {
      return url.replace('youtube.com', 'www.youtube.com');
    }
    return url;
  }

  // Non-www watch URL
  if (url.includes('youtube.com/watch') && !url.includes('www.youtube.com')) {
    return url.replace('youtube.com', 'www.youtube.com');
  }

  return url;
}

/**
 * Extract numeric quality (e.g., "1080p" -> 1080)
 */
function extractQualityNumber(qualityLabel) {
  if (!qualityLabel) return 0;

  const match = qualityLabel.match(/(\d+)p/);
  if (match) return parseInt(match[1], 10);

  if (qualityLabel.includes('1440') || qualityLabel.toLowerCase().includes('2k')) return 1440;
  if (qualityLabel.includes('2160') || qualityLabel.toLowerCase().includes('4k')) return 2160;
  if (qualityLabel.includes('1080')) return 1080;
  if (qualityLabel.includes('720')) return 720;
  if (qualityLabel.includes('480')) return 480;
  if (qualityLabel.includes('360')) return 360;
  if (qualityLabel.includes('240')) return 240;
  if (qualityLabel.includes('144')) return 144;

  return 0;
}

/**
 * Deduplicate formats by quality, preferring mp4 and larger filesize/bitrate
 */
function dedupeFormatsByQuality(formats) {
  const map = new Map(); // key => best format

  formats.forEach((fmt) => {
    const key = fmt.qualityNum || fmt.quality || fmt.itag || Math.random();
    const existing = map.get(key);

    if (!existing) {
      map.set(key, fmt);
      return;
    }

    // Prefer mp4 if one of them is mp4
    const existingIsMp4 = (existing.extension || '').toLowerCase() === 'mp4';
    const currentIsMp4 = (fmt.extension || '').toLowerCase() === 'mp4';

    if (!existingIsMp4 && currentIsMp4) {
      map.set(key, fmt);
      return;
    }

    // Otherwise prefer larger filesize if available
    const existingSize = parseInt(existing.filesize || '0', 10) || 0;
    const currentSize = parseInt(fmt.filesize || '0', 10) || 0;

    if (currentSize > existingSize) {
      map.set(key, fmt);
    }
  });

  return Array.from(map.values());
}

/**
 * Main function: fetch YouTube data (with muxed audio+video when available)
 * NO audio merging, NO ffmpeg. Only direct formats that already have audio.
 */
async function fetchYouTubeData(rawUrl) {
  const url = normalizeYouTubeUrl(rawUrl);
  console.log(`🔍 YouTube: fetching info via ytdl-core for: ${url}`);

  try {
    const info = await ytdl.getInfo(url);
    return processYouTubeData(info, url);
  } catch (err) {
    console.error('❌ YouTube ytdl-core error:', err.message);
    throw new Error(`YouTube download failed: ${err.message}`);
  }
}

/**
 * Process ytdl-core info into your app's format (formats/allFormats/etc.)
 */
function processYouTubeData(info, url) {
  const isShorts = url.includes('/shorts/');
  const formats = info.formats || [];
  console.log(`📊 ytdl-core returned ${formats.length} formats`);

  const videoFormats = [];
  const audioFormats = [];

  formats.forEach((f) => {
    if (!f.url) return;

    const hasVideo = !!f.hasVideo;
    const hasAudio = !!f.hasAudio || typeof f.audioBitrate === 'number';

    if (!hasAudio && !hasVideo) return;

    const container =
      f.container ||
      (f.mimeType ? f.mimeType.split('/')[1].split(';')[0] : 'mp4');

    const qualityLabel =
      f.qualityLabel || (f.height ? `${f.height}p` : 'unknown');
    const qualityNum = hasVideo ? extractQualityNumber(qualityLabel) : 0;

    const bitrate = f.bitrate || f.audioBitrate || 0;
    const isAudioOnly = hasAudio && !hasVideo;
    const isVideoOnly = hasVideo && !hasAudio; // we will NOT use these, no merging

    const base = {
      itag: f.itag,
      url: f.url,
      quality: hasVideo
        ? qualityLabel
        : bitrate
        ? `${bitrate}kb/s`
        : 'audio',
      qualityNum: hasVideo ? qualityNum : bitrate,
      type: f.mimeType || (hasVideo ? 'video/mp4' : 'audio/mp4'),
      extension: container || (hasVideo ? 'mp4' : 'm4a'),
      filesize: f.contentLength || null,
      hasAudio,
      isVideoOnly,
      isAudioOnly,
    };

    if (hasVideo && hasAudio) {
      videoFormats.push(base);
    } else if (isAudioOnly) {
      audioFormats.push(base);
    }
  });

  const uniqueVideo = dedupeFormatsByQuality(videoFormats);
  const uniqueAudio = dedupeFormatsByQuality(audioFormats);

  if (!uniqueVideo.length && !uniqueAudio.length) {
    throw new Error('No downloadable formats with audio found for this video');
  }

  // Add premium flag: >360p = premium for video. Audio is always free.
  const allFormats = [...uniqueVideo, ...uniqueAudio].map((fmt) => {
    const isAudioOnly = fmt.isAudioOnly;
    const isPremium = !isAudioOnly && (fmt.qualityNum || 0) > 360;
    return { ...fmt, isPremium };
  });

  // Sort: all video formats by quality ascending, then audio by bitrate
  allFormats.sort((a, b) => {
    const aAudio = !!a.isAudioOnly;
    const bAudio = !!b.isAudioOnly;
    if (!aAudio && bAudio) return -1; // videos first
    if (aAudio && !bAudio) return 1;

    const aQ = a.qualityNum || 0;
    const bQ = b.qualityNum || 0;
    return aQ - bQ;
  });

  // Default selection: 360p video with audio if available, else lowest video+audio, else first audio
  const selected =
    uniqueVideo.find((v) => v.qualityNum === 360) ||
    uniqueVideo[0] ||
    uniqueAudio[0];

  const thumbs = info.videoDetails.thumbnails || [];
  const bestThumb = thumbs.length ? thumbs[thumbs.length - 1].url : null;

  const result = {
    title: info.videoDetails.title,
    thumbnail: bestThumb,
    duration: parseInt(info.videoDetails.lengthSeconds || '0', 10) || null,
    isShorts,
    formats: allFormats,
    allFormats: allFormats,
    url: selected.url,
    selectedQuality: selected,
    audioGuaranteed: !!selected.hasAudio,
  };

  console.log(
    `✅ YouTube service completed. Formats: ${allFormats.length}, selected: ${selected.quality}`
  );
  return result;
}

module.exports = {
  fetchYouTubeData,
  normalizeYouTubeUrl,
};
