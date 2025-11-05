const axios = require("axios");

// In your Node.js YouTube service
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
        timeout: 30000,
      }
    );
    
    const data = res.data?.data;
    if (!data || !data.items || !data.title) {
      throw new Error("Invalid or empty response from YouTube downloader API");
    }

    const isShorts = url.includes('/shorts/');
    console.log(`📊 YouTube: Found ${data.items.length} total formats`);

    // Filter for available formats with audio
    let availableFormats = data.items.filter(item => {
      const label = (item.label || '').toLowerCase();
      const hasUrl = item.url && item.url.length > 0;
      const hasAudio = !label.includes('video only') && !label.includes('audio only');
      return hasUrl && hasAudio;
    });

    // If no formats with audio, include all formats
    if (availableFormats.length === 0) {
      availableFormats = data.items.filter(item => item.url && item.url.length > 0);
    }

    // Sort by quality (extract quality number)
    availableFormats.sort((a, b) => {
      const getQualityValue = (label) => {
        if (!label) return 0;
        const match = label.match(/(\d+)p/);
        return match ? parseInt(match[1]) : 0;
      };
      return getQualityValue(b.label) - getQualityValue(a.label);
    });

    // Define premium and free qualities
    const premiumQualities = ['1080p', '720p', '480p', '360p', '240p'];
    const freeQualities = isShorts ? ['720p', '480p'] : ['360p', '480p'];

    // Map available formats to quality options
    const qualityOptions = availableFormats.map(format => {
      const quality = format.label || 'unknown';
      const isPremiumOnly = !freeQualities.some(fq => quality.toLowerCase().includes(fq));
      
      return {
        quality: quality,
        url: format.url,
        type: format.type || 'video/mp4',
        extension: format.ext || format.extension || 'mp4',
        filesize: format.filesize || 'unknown',
        isPremium: isPremiumOnly
      };
    });

    return {
      title: data.title,
      thumbnail: data.cover,
      duration: data.duration,
      isShorts: isShorts,
      formats: qualityOptions,
    };
  } catch (err) {
    console.error('❌ YouTube service error:', err.message);
    throw new Error(`YouTube downloader request failed: ${err.message}`);
  }
}

module.exports = { fetchYouTubeData };
