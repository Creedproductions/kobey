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
        timeout: 30000,
      }
    );
    
    const data = res.data?.data;
    if (!data || !data.items || !data.title) {
      throw new Error("Invalid or empty response from YouTube downloader API");
    }

    // Detect if it's a Shorts video
    const isShorts = url.includes('/shorts/');
    console.log(`📊 YouTube: Found ${data.items.length} total formats (${isShorts ? 'SHORTS 🎬' : 'VIDEO 📺'})`);

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
      
      // Exclude video-only and audio-only formats
      const hasAudio = !label.includes('video only') && 
                       !label.includes('audio only') &&
                       !type.includes('video only');
      
      return isMp4 && hasUrl && hasAudio;
    });

    // Fallback: try all MP4 formats if none with audio
    if (videoFormats.length === 0) {
      console.log('⚠️ No MP4 with audio found, trying all MP4 formats...');
      videoFormats = data.items.filter(item => {
        const type = (item.type || '').toLowerCase();
        const ext = (item.ext || item.extension || '').toLowerCase();
        const isMp4 = type.includes('mp4') || ext.includes('mp4') || type.includes('video');
        const hasUrl = item.url && item.url.length > 0;
        return isMp4 && hasUrl;
      });
    }

    // Still no formats? Use anything
    if (videoFormats.length === 0) {
      console.log('⚠️ No MP4 found, using any available format...');
      videoFormats = data.items.filter(item => item.url && item.url.length > 0);
    }

    // ========================================
    // QUALITY SELECTION: SHORTS = 720p, VIDEOS = 360p
    // ========================================
    
    const targetQuality = isShorts ? '720' : '360';
    console.log(`🎯 Target quality: ${targetQuality}p (${isShorts ? 'HD for Shorts' : 'Fast for Videos'})`);

    // Try to find exact target quality match
    const targetFormat = videoFormats.find(f => {
      const label = (f.label || '').toLowerCase();
      return label.includes(`${targetQuality}p`) || label.includes(targetQuality);
    });

    if (targetFormat) {
      console.log(`✅ Found ${targetQuality}p format - using it!`);
      // Put target format first, then others
      videoFormats = [targetFormat, ...videoFormats.filter(f => f !== targetFormat)];
    } else {
      console.log(`⚠️ No ${targetQuality}p found, using closest match...`);
      
      // Sort by closest to target quality
      videoFormats.sort((a, b) => {
        const getQualityValue = (label) => {
          if (!label) return 9999;
          const labelLower = label.toLowerCase();
          
          // Extract number from quality (e.g., "360" from "360p")
          const match = labelLower.match(/(\d+)p/);
          if (match) {
            const quality = parseInt(match[1]);
            // Return distance from target (closer = better)
            return Math.abs(quality - parseInt(targetQuality));
          }
          
          // Fallback values
          if (labelLower.includes('240')) return Math.abs(240 - parseInt(targetQuality));
          if (labelLower.includes('360')) return Math.abs(360 - parseInt(targetQuality));
          if (labelLower.includes('480')) return Math.abs(480 - parseInt(targetQuality));
          if (labelLower.includes('720')) return Math.abs(720 - parseInt(targetQuality));
          if (labelLower.includes('1080')) return Math.abs(1080 - parseInt(targetQuality));
          if (labelLower.includes('1440')) return Math.abs(1440 - parseInt(targetQuality));
          if (labelLower.includes('2160') || labelLower.includes('4k')) return Math.abs(2160 - parseInt(targetQuality));
          
          return 9999;
        };
        
        // Sort by closest to target (ascending distance)
        return getQualityValue(a.label) - getQualityValue(b.label);
      });
    }

    console.log(`✅ YouTube: Filtered to ${videoFormats.length} format(s)`);
    if (videoFormats.length > 0) {
      const selected = videoFormats[0];
      console.log(`🎯 SELECTED: ${selected.label || 'unknown'}`);
      console.log(`📦 Type: ${selected.type || 'unknown'}`);
      console.log(`📦 Extension: ${selected.extension || 'mp4'}`);
      console.log(`🔊 Audio: ${!(selected.label || '').toLowerCase().includes('video only') ? '✅ YES' : '❌ NO'}`);
      
      // Show top 3 available qualities
      const top3 = videoFormats.slice(0, 3).map(f => f.label || 'unknown').join(', ');
      console.log(`📋 Top 3 available: ${top3}`);
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
    console.error('❌ YouTube service error:', err.message);
    throw new Error(`YouTube downloader request failed: ${err.message}`);
  }
}

module.exports = { fetchYouTubeData };
