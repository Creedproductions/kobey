const axios = require("axios");

async function fetchYouTubeData(url) {
  try {
    const res = await axios.get(
      "https://api.vidfly.ai/api/media/youtube/download",
      {
        params: { url },
        headers: {
          accept: "*/*",
          "content-type": "application/json",
          "x-app-name": "vidfly-web",
          "x-app-version": "1.0.0",
          Referer: "https://vidfly.ai/",
        },
      }
    );
    
    const data = res.data?.data;
    if (!data || !data.items || !data.title) {
      throw new Error("Invalid or empty response from YouTube downloader API");
    }

    console.log(`📊 YouTube: Found ${data.items.length} total formats`);

    // ========================================
    // FILTER FOR MP4 WITH AUDIO
    // ========================================
    
    let videoFormats = data.items.filter(item => {
      const label = (item.label || '').toLowerCase();
      const type = (item.type || '').toLowerCase();
      const ext = (item.ext || item.extension || '').toLowerCase();
      
      // Must be MP4 or video format
      const isMp4 = type.includes('mp4') || ext.includes('mp4') || type.includes('video');
      
      // Must have valid URL
      const hasUrl = item.url && item.url.length > 0;
      
      // Check if it's NOT a video-only or audio-only format
      // Usually video-only formats have "video only" or similar in label
      const hasAudio = !label.includes('video only') && 
                       !label.includes('audio only') &&
                       !type.includes('video only');
      
      return isMp4 && hasUrl && hasAudio;
    });

    // If no formats with audio found, try all MP4 formats
    if (videoFormats.length === 0) {
      console.log('⚠️ No MP4 with audio found, trying all MP4 formats...');
      videoFormats = data.items.filter(item => {
        const type = (item.type || '').toLowerCase();
        const ext = (item.ext || item.extension || '').toLowerCase();
        const isMp4 = type.includes('mp4') || ext.includes('mp4');
        const hasUrl = item.url && item.url.length > 0;
        return isMp4 && hasUrl;
      });
    }

    // ========================================
    // SORT TO PRIORITIZE 360p (FAST + AUDIO)
    // ========================================
    
    videoFormats.sort((a, b) => {
      const getQualityValue = (label) => {
        if (!label) return 0;
        const labelLower = label.toLowerCase();
        
        // 360p gets highest priority (faster download + has audio)
        if (labelLower.includes('360')) return 1000;
        
        // Then 480p
        if (labelLower.includes('480')) return 900;
        
        // Then 720p
        if (labelLower.includes('720')) return 800;
        
        // Then 240p (low quality)
        if (labelLower.includes('240')) return 700;
        
        // Then 1080p (slower)
        if (labelLower.includes('1080')) return 600;
        
        // 1440p and 4K last (too slow)
        if (labelLower.includes('1440')) return 200;
        if (labelLower.includes('4k') || labelLower.includes('2160')) return 100;
        
        return 0;
      };
      
      return getQualityValue(b.label) - getQualityValue(a.label);
    });

    console.log(`✅ YouTube: Filtered to ${videoFormats.length} format(s)`);
    if (videoFormats.length > 0) {
      const top3 = videoFormats.slice(0, 3).map(f => f.label || 'unknown').join(', ');
      console.log(`🎥 Top 3 qualities: ${top3}`);
      console.log(`🎯 Default selected: ${videoFormats[0].label || 'unknown'}`);
      console.log(`🔊 Audio included: YES`);
    }

    return {
      title: data.title,
      thumbnail: data.cover,
      duration: data.duration,
      formats: videoFormats.map((item) => ({
        type: item.type,
        quality: item.label || "unknown",
        extension: item.ext || item.extension || "mp4",
        url: item.url,
        filesize: item.filesize || 'unknown'
      })),
    };
  } catch (err) {
    throw new Error(`YouTube downloader request failed: ${err.message}`);
  }
}

module.exports = { fetchYouTubeData };
