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
    // QUALITY FILTERING - PRIORITIZE 720p+
    // ========================================
    
    // Filter for video formats with minimum 720p quality
    let videoFormats = data.items.filter(item => {
      const label = (item.label || '').toLowerCase();
      const type = (item.type || '').toLowerCase();
      
      // Must be a video format
      const isVideo = type.includes('video') || type.includes('mp4');
      
      // Must be high quality (720p or better)
      const isHD = label.includes('1080') || label.includes('720') || 
                   label.includes('2160') || label.includes('4k') ||
                   label.includes('1440');
      
      // Must have a valid URL
      const hasUrl = item.url && item.url.length > 0;
      
      return isVideo && isHD && hasUrl;
    });

    // If no HD formats found, get any video format available
    if (videoFormats.length === 0) {
      console.log('⚠️ No 720p+ found, using all available video formats...');
      videoFormats = data.items.filter(item => {
        const type = (item.type || '').toLowerCase();
        const isVideo = type.includes('video') || type.includes('mp4');
        const hasUrl = item.url && item.url.length > 0;
        return isVideo && hasUrl;
      });
    }

    // If still no formats, use everything
    if (videoFormats.length === 0) {
      console.log('⚠️ No video formats found, using all formats...');
      videoFormats = data.items.filter(item => item.url && item.url.length > 0);
    }

    // ========================================
    // SORT BY QUALITY (HIGHEST FIRST)
    // ========================================
    
    videoFormats.sort((a, b) => {
      const getQualityValue = (label) => {
        if (!label) return 0;
        const labelLower = label.toLowerCase();
        if (labelLower.includes('4k') || labelLower.includes('2160')) return 2160;
        if (labelLower.includes('1440')) return 1440;
        if (labelLower.includes('1080')) return 1080;
        if (labelLower.includes('720')) return 720;
        if (labelLower.includes('480')) return 480;
        if (labelLower.includes('360')) return 360;
        if (labelLower.includes('240')) return 240;
        return 0;
      };
      return getQualityValue(b.label) - getQualityValue(a.label);
    });

    console.log(`✅ YouTube: Filtered to ${videoFormats.length} format(s)`);
    if (videoFormats.length > 0) {
      console.log(`🎥 Best quality available: ${videoFormats[0].label || 'unknown'}`);
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
