const ytdl = require('@distube/ytdl-core');

async function fetchYouTubeData(url) {
  console.log('🎬 YouTube: Starting download with @distube/ytdl-core');
  
  try {
    const info = await ytdl.getInfo(url);
    
    // Get ALL formats with both video and audio
    const videoAndAudioFormats = ytdl.filterFormats(info.formats, 'videoandaudio');
    
    if (videoAndAudioFormats.length === 0) {
      throw new Error('No formats with audio available');
    }

    // Process and sort formats
    const processedFormats = videoAndAudioFormats
      .filter(f => f.hasVideo && f.hasAudio)
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
          filesize: format.contentLength || 'unknown',
          bitrate: format.bitrate || 0
        };
      })
      .sort((a, b) => a.qualityNum - b.qualityNum);

    if (processedFormats.length === 0) {
      throw new Error('No valid video formats found');
    }

    // Select default quality (360p or first available)
    const defaultFormat = processedFormats.find(f => f.qualityNum === 360) || 
                         processedFormats.find(f => f.qualityNum <= 480) ||
                         processedFormats[0];

    const result = {
      title: info.videoDetails.title,
      thumbnail: info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1]?.url || '',
      duration: info.videoDetails.lengthSeconds,
      formats: processedFormats,
      allFormats: processedFormats,
      url: defaultFormat.url,
      selectedQuality: defaultFormat,
      audioGuaranteed: true
    };

    console.log(`✅ YouTube: Found ${processedFormats.length} formats with audio`);
    return result;
    
  } catch (error) {
    console.error('❌ YouTube error:', error.message);
    throw new Error(`YouTube download failed: ${error.message}`);
  }
}

module.exports = { fetchYouTubeData };
