const ytdl = require('ytdl-core');

function mapFormat(fmt) {
  const hasVideo = !!fmt.hasVideo;
  const hasAudio = !!fmt.hasAudio;
  const type = hasVideo && hasAudio ? 'video_with_audio' : (hasVideo ? 'video' : 'audio');
  const quality = fmt.qualityLabel || (fmt.audioBitrate ? `${fmt.audioBitrate}kb/s` : 'unknown');
  const extension = fmt.container || 'mp4';
  return {
    itag: fmt.itag,
    type,
    quality,
    extension,
    url: fmt.url
  };
}

async function fetchYouTubeData(url) {
  const info = await ytdl.getInfo(url);

  const title = info.videoDetails?.title || 'YouTube Video';
  const lengthSeconds = parseInt(info.videoDetails?.lengthSeconds || '0', 10);
  const duration = lengthSeconds ? `${Math.floor(lengthSeconds/60)}:${String(lengthSeconds%60).padStart(2, '0')}` : null;
  const thumbnail = info.videoDetails?.thumbnails?.slice(-1)[0]?.url || null;

  const progressive = ytdl.filterFormats(info.formats, 'audioandvideo');
  const audioOnly = ytdl.filterFormats(info.formats, 'audioonly');

  const formats = [
    ...progressive.map(mapFormat),
    ...audioOnly.map(mapFormat)
  ];

  return { title, thumbnail, duration, formats };
}

module.exports = { fetchYouTubeData };
