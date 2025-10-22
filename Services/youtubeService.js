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
    // FILTER FOR MP4 ONLY (NO WEBM)
    // ========================================
    
    let videoFormats = data.items.filter(item => {
      const label = (item.label || '').toLowerCase();
      const type = (item.type || '').toLowerCase();
      const ext = (item.ext || item.extension || '').toLowerCase();
      
      // Must be MP4 format
      const isMp4 = type.includes('mp4') || ext.includes('mp4');
      
      // Must be video
      const isVideo = type.includes('video');
      
      // Must have valid URL
      const hasUrl = item.url && item.url.length > 0;
      
      return isMp4 && isVideo && hasUrl;
    });

    if (videoFormats.length === 0) {
      console.log('⚠️ No MP4 formats found, trying all video formats...');
      videoFormats = data.items.filter(item => {
        const type = (item.type || '').toLowerCase();
        const isVideo = type.includes('video');
        const hasUrl = item.url && item.url.length > 0;
        return isVideo && hasUrl;
      });
    }

    // ========================================
    // SORT TO PRIORITIZE 720p (DEFAULT)
    // ========================================
    
    videoFormats.sort((a, b) => {
      const getQualityValue = (label) => {
        if (!label) return 0;
        const labelLower = label.toLowerCase();
        
        // 720p gets highest priority (return 1000)
        if (labelLower.includes('720')) return 1000;
        
        // Then 1080p
        if (labelLower.includes('1080')) return 900;
        
        // Then 480p
        if (labelLower.includes('480')) return 800;
        
        // Then 1440p
        if (labelLower.includes('1440')) return 700;
        
        // Then 360p
        if (labelLower.includes('360')) return 600;
        
        // 4K/2160p last (too large)
        if (labelLower.includes('4k') || labelLower.includes('2160')) return 100;
        
        return 0;
      };
      
      return getQualityValue(b.label) - getQualityValue(a.label);
    });

    console.log(`✅ YouTube: Filtered to ${videoFormats.length} MP4 format(s)`);
    if (videoFormats.length > 0) {
      const qualities = videoFormats.map(f => f.label || 'unknown').join(', ');
      console.log(`🎥 Available qualities: ${qualities}`);
      console.log(`🎯 Default selected: ${videoFormats[0].label || 'unknown'}`);
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
