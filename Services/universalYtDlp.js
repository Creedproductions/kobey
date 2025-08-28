// Services/universalYtDlp.js
const ytdlp = require('yt-dlp-exec');

function safeThumb(arr) {
  if (Array.isArray(arr) && arr.length) return [{ url: arr[0].url || arr[0] }];
  return [];
}

function mapYtDlpFormats(fmts = []) {
  return (fmts || [])
    .filter(f => f && (f.url || f.fragment_base_url)) // url must exist for direct fetch
    .map((f, i) => ({
      // keep it compatible with your dialog
      itag: String(f.format_id ?? i),
      quality: f.format_note || (f.height ? `${f.height}p` : 'auto'),
      container: (f.ext || 'mp4'),
      hasVideo: (f.vcodec && f.vcodec !== 'none') ? true : false,
      hasAudio: (f.acodec && f.acodec !== 'none') ? true : false,
      audioCodec: f.acodec || null,
      videoCodec: f.vcodec || null,
      audioBitrate: f.abr || null,
      contentLength: f.filesize || f.filesize_approx || null,
      url: f.url || null,
    }));
}

/**
 * Probe any URL with yt-dlp and return a normalized object
 */
async function probe(url) {
  const json = await ytdlp(url, {
    dumpSingleJson: true,
    noWarnings: true,
    noCallHome: true,
    preferFreeFormats: true,
    // a couple of headers make FB/IG happier
    addHeader: [
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
      `Referer: ${url}`,
    ],
  });

  const formats = mapYtDlpFormats(json.formats);
  return {
    platform: (json.extractor_key || 'Unknown'),
    title: json.title || 'Media',
    thumbnails: safeThumb(json.thumbnails),
    duration: json.duration || null,
    formats,
    originalUrl: url,
  };
}

module.exports = { probe, mapYtDlpFormats };
