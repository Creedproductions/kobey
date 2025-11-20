const youtubedl = require('youtube-dl-exec');
const axios = require('axios');

async function fetchYouTubeData(url) {
  console.log('🎬 YouTube: Processing with youtube-dl-exec');
  
  try {
    // Get video info with formats
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      addHeader: ['referer:youtube.com', 'user-agent:googlebot']
    });

    if (!info || !info.title) {
      throw new Error('Could not fetch video info');
    }

    // Filter formats with both video and audio
    const videoFormats = (info.formats || [])
      .filter(f => {
        const hasVideo = f.vcodec && f.vcodec !== 'none';
        const hasAudio = f.acodec && f.acodec !== 'none';
        const hasUrl = f.url && f.url.length > 0;
        return hasVideo && hasAudio && hasUrl;
      })
      .map(format => {
        const height = format.height || 0;
        const quality = height > 0 ? `${height}p` : (format.format_note || 'unknown');
        
        return {
          quality: `mp4 (${quality})`,
          qualityNum: height,
          url: format.url,
          type: format.ext === 'mp4' ? 'video/mp4' : 'video/webm',
          extension: format.ext || 'mp4',
          isPremium: height > 360,
          hasAudio: true,
          filesize: format.filesize || 'unknown'
        };
      })
      .filter(f => f.qualityNum > 0)
      .sort((a, b) => a.qualityNum - b.qualityNum);

    if (videoFormats.length === 0) {
      throw new Error('No suitable video formats found');
    }

    // Select default format (360p or closest)
    const defaultFormat = videoFormats.find(f => f.qualityNum === 360) ||
                         videoFormats.find(f => f.qualityNum >= 240 && f.qualityNum <= 480) ||
                         videoFormats[0];

    const result = {
      title: info.title,
      thumbnail: info.thumbnail || '',
      duration: info.duration || 0,
      formats: videoFormats,
      allFormats: videoFormats,
      url: defaultFormat.url,
      selectedQuality: defaultFormat,
      audioGuaranteed: true
    };

    console.log(`✅ YouTube: Found ${videoFormats.length} formats with audio`);
    return result;

  } catch (error) {
    console.error('❌ YouTube error:', error.message);
    throw new Error(`YouTube download failed: ${error.message}`);
  }
}

module.exports = { fetchYouTubeData };
