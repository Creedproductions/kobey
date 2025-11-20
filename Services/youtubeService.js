const ytdl = require('ytdl-core');

async function fetchYouTubeData(url) {
  console.log('🎬 YouTube: Processing with ytdl-core');
  
  try {
    // Get video info
    const info = await ytdl.getInfo(url);
    
    if (!info || !info.videoDetails) {
      throw new Error('Could not fetch video info');
    }

    // Get formats with both video and audio
    const formats = ytdl.filterFormats(info.formats, 'videoandaudio')
      .map(format => {
        const quality = format.qualityLabel || format.quality || 'unknown';
        const qualityNum = parseInt(quality.replace('p', '')) || 0;
        
        return {
          quality: `mp4 (${quality})`,
          qualityNum: qualityNum,
          url: format.url,
          type: format.mimeType?.split(';')[0] || 'video/mp4',
          extension: format.container || 'mp4',
          isPremium: qualityNum > 360,
          hasAudio: true,
          filesize: format.contentLength || 'unknown'
        };
      })
      .filter(f => f.qualityNum > 0)
      .sort((a, b) => a.qualityNum - b.qualityNum);

    if (formats.length === 0) {
      throw new Error('No video formats with audio found');
    }

    // Select default format (360p or closest)
    const defaultFormat = formats.find(f => f.qualityNum === 360) ||
                         formats.find(f => f.qualityNum >= 240 && f.qualityNum <= 480) ||
                         formats[0];

    const result = {
      title: info.videoDetails.title,
      thumbnail: info.videoDetails.thumbnails?.[info.videoDetails.thumbnails.length - 1]?.url || '',
      duration: info.videoDetails.lengthSeconds || 0,
      formats: formats,
      allFormats: formats,
      url: defaultFormat.url,
      selectedQuality: defaultFormat,
      audioGuaranteed: true
    };

    console.log(`✅ YouTube: Found ${formats.length} formats with audio`);
    return result;

  } catch (error) {
    console.error('❌ YouTube error:', error.message);
    throw new Error(`YouTube download failed: ${error.message}`);
  }
}

module.exports = { fetchYouTubeData };
