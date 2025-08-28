// Services/youtubeService.js
const ytdl = require('ytdl-core');
const { probe } = require('./universalYtDlp');

function mapYtdlCore(info) {
  const v = info.videoDetails;
  const formats = (info.formats || []).filter(f => f.url).map(f => ({
    itag: String(f.itag),                // real YouTube itag
    quality: f.qualityLabel || (f.audioBitrate ? `${f.audioBitrate} kbps` : 'auto'),
    container: f.container || 'mp4',
    hasVideo: !!f.hasVideo,
    hasAudio: !!f.hasAudio,
    audioCodec: f.audioCodec || null,
    videoCodec: f.videoCodec || null,
    audioBitrate: f.audioBitrate || null,
    contentLength: f.contentLength || null,
    url: f.url,
  }));
  return {
    title: v.title,
    thumbnails: v.thumbnails || [],
    duration: parseInt(v.lengthSeconds || '0', 10) || null,
    formats,
  };
}

async function fetchYouTubeData(url) {
  try {
    const info = await ytdl.getInfo(url);
    return mapYtdlCore(info);
  } catch (e) {
    // fall back to yt-dlp if ytdl-core breaks
    const p = await probe(url);
    return {
      title: p.title,
      thumbnails: p.thumbnails,
      duration: p.duration,
      formats: p.formats,
    };
  }
}

module.exports = { fetchYouTubeData };
