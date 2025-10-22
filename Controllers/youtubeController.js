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

    // Filter for video+audio formats with minimum 720p quality
    let videoFormats = data.items.filter(item => {
      const label = item.label || '';
      const hasVideo = item.type === 'video' || item.type === 'mp4';
      const isHighQuality = label.includes('1080') || label.includes('720') || 
                           label.includes('2160') || label.includes('4K');
      return hasVideo && isHighQuality && item.url;
    });

    // If no high quality found, get any video format available
    if (videoFormats.length === 0) {
      console.log('⚠️ No 720p+ found, using available formats...');
      videoFormats = data.items.filter(item => 
        (item.type === 'video' || item.type === 'mp4') && item.url
      );
    }

    // Sort by quality (highest first)
    videoFormats.sort((a, b) => {
      const getQualityValue = (label) => {
        if (!label) return 0;
        if (label.includes('4K') || label.includes('2160')) return 2160;
        if (label.includes('1440')) return 1440;
        if (label.includes('1080')) return 1080;
        if (label.includes('720')) return 720;
        if (label.includes('480')) return 480;
        if (label.includes('360')) return 360;
        return 0;
      };
      return getQualityValue(b.label) - getQualityValue(a.label);
    });

    console.log(`✅ YouTube: Filtered to ${videoFormats.length} high-quality formats`);
    if (videoFormats.length > 0) {
      console.log(`🎥 Best quality: ${videoFormats[0].label}`);
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
