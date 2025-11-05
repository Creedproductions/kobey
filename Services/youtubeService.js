const axios = require("axios");

async function fetchYouTubeData(url) {
  try {
    console.log(`🔍 Fetching YouTube data for: ${url}`);
    
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
    console.log(`📊 YouTube: Found ${data.items.length} total formats (${isShorts ? 'SHORTS' : 'REGULAR'})`);

    // ========================================
    // STRICT AUDIO FILTERING FOR SHORTS
    // ========================================
    
    let availableFormats = data.items.filter(item => {
      const label = (item.label || '').toLowerCase();
      const type = (item.type || '').toLowerCase();
      const hasUrl = item.url && item.url.length > 0;
      
      // STRICT audio detection - be very aggressive about excluding video-only
      const isVideoOnly = label.includes('video only') || 
                         label.includes('vid only') ||
                         label.includes('without audio') ||
                         type.includes('video only') ||
                         (type.includes('video') && !type.includes('audio'));
      
      const isAudioOnly = label.includes('audio only') || 
                         type.includes('audio only');
      
      // For Shorts: ONLY accept formats that definitely have audio
      if (isShorts) {
        // Accept formats that are NOT video-only and NOT audio-only
        return hasUrl && !isVideoOnly && !isAudioOnly;
      }
      
      // For regular videos: be slightly more lenient
      return hasUrl && !isVideoOnly;
    });

    console.log(`✅ Found ${availableFormats.length} formats with audio after strict filtering`);

    // If no formats with audio found, try to find ANY format that might work
    if (availableFormats.length === 0) {
      console.log('🚨 No audio formats found, emergency fallback...');
      
      // Emergency fallback: take any format that has a URL
      availableFormats = data.items.filter(item => {
        const label = (item.label || '').toLowerCase();
        const hasUrl = item.url && item.url.length > 0;
        
        // Still exclude obvious audio-only formats
        const isAudioOnly = label.includes('audio only');
        
        return hasUrl && !isAudioOnly;
      });
      
      console.log(`🆘 Emergency fallback found ${availableFormats.length} formats`);
    }

    // If STILL no formats, use everything
    if (availableFormats.length === 0) {
      console.log('💀 Using ALL available formats as last resort');
      availableFormats = data.items.filter(item => item.url && item.url.length > 0);
    }

    // Log filtered formats for debugging
    console.log('🔊 Audio-compatible formats:');
    availableFormats.forEach((format, index) => {
      const label = (format.label || '').toLowerCase();
      const hasAudio = !label.includes('video only') && !label.includes('audio only');
      console.log(`  ${index + 1}. ${format.label} - Audio: ${hasAudio ? '✅' : '❌'}`);
    });

    // ========================================
    // QUALITY SORTING - PRIORITIZE LOWER QUALITIES FOR SHORTS
    // ========================================
    
    // Sort by quality, but prioritize lower qualities for Shorts
    availableFormats.sort((a, b) => {
      const getQualityValue = (label) => {
        if (!label) return isShorts ? 9999 : 0; // For Shorts, prefer lower numbers
        
        const labelLower = label.toLowerCase();
        const match = labelLower.match(/(\d+)p/);
        if (match) return parseInt(match[1]);
        
        if (labelLower.includes('1440') || labelLower.includes('2k')) return isShorts ? 1440 : 1440;
        if (labelLower.includes('2160') || labelLower.includes('4k')) return isShorts ? 2160 : 2160;
        if (labelLower.includes('1080')) return isShorts ? 1080 : 1080;
        if (labelLower.includes('720')) return isShorts ? 720 : 720;
        if (labelLower.includes('480')) return isShorts ? 480 : 480;
        if (labelLower.includes('360')) return isShorts ? 360 : 360;
        if (labelLower.includes('240')) return isShorts ? 240 : 240;
        if (labelLower.includes('144')) return isShorts ? 144 : 144;
        
        return isShorts ? 9999 : 0;
      };
      
      const qualityA = getQualityValue(a.label);
      const qualityB = getQualityValue(b.label);
      
      // For Shorts: sort ascending (lowest quality first)
      // For Regular: sort descending (highest quality first)
      return isShorts ? qualityA - qualityB : qualityB - qualityA;
    });

    console.log('📊 Sorted formats (Shorts prefer lower quality):');
    availableFormats.forEach((format, index) => {
      console.log(`  ${index + 1}. ${format.label}`);
    });

    // ========================================
    // FORCE 360p FOR SHORTS - AUDIO COMPATIBILITY
    // ========================================
    
    const qualityOptions = availableFormats.map(format => {
      const quality = format.label || 'unknown';
      
      // For Shorts: ONLY allow 360p and below for free users
      // Higher qualities often have separate audio streams
      const isPremiumOnly = isShorts ? 
        !['360p', '240p', '144p'].some(q => quality.toLowerCase().includes(q)) :
        !['360p', '480p'].some(q => quality.toLowerCase().includes(q));
      
      return {
        quality: quality,
        url: format.url,
        type: format.type || 'video/mp4',
        extension: format.ext || format.extension || 'mp4',
        filesize: format.filesize || 'unknown',
        isPremium: isPremiumOnly,
        hasAudio: !(format.label || '').toLowerCase().includes('video only')
      };
    });

    // ========================================
    // SMART DEFAULT SELECTION - FORCE 360p FOR SHORTS
    // ========================================
    
    let defaultUrl = availableFormats[0]?.url;
    let selectedQuality = qualityOptions[0];
    
    if (isShorts) {
      console.log('🎬 SHORTS DETECTED - FORCING 360p FOR AUDIO COMPATIBILITY');
      
      // STRICT: Only allow 360p, 240p, 144p for Shorts
      const shortsSafeQualities = ['360p', '240p', '144p'];
      
      for (const safeQuality of shortsSafeQualities) {
        const safeFormat = availableFormats.find((format, index) => {
          const quality = (format.label || '').toLowerCase();
          return quality.includes(safeQuality) && qualityOptions[index]?.hasAudio;
        });
        
        if (safeFormat) {
          const qualityIndex = availableFormats.indexOf(safeFormat);
          defaultUrl = safeFormat.url;
          selectedQuality = qualityOptions[qualityIndex];
          console.log(`✅ FORCED Shorts quality: ${selectedQuality.quality} (AUDIO SAFE)`);
          break;
        }
      }
      
      // If no safe quality found, use the first format that has audio
      if (defaultUrl === availableFormats[0]?.url) {
        const audioFormat = availableFormats.find((format, index) => 
          qualityOptions[index]?.hasAudio
        );
        
        if (audioFormat) {
          const qualityIndex = availableFormats.indexOf(audioFormat);
          defaultUrl = audioFormat.url;
          selectedQuality = qualityOptions[qualityIndex];
          console.log(`🔄 Using first audio format: ${selectedQuality.quality}`);
        } else {
          console.log('⚠️ WARNING: No audio formats found for Shorts!');
        }
      }
    } else {
      // Regular videos: use first free quality
      const freeFormat = qualityOptions.find(q => !q.isPremium && q.hasAudio);
      if (freeFormat) {
        const qualityIndex = qualityOptions.indexOf(freeFormat);
        defaultUrl = availableFormats[qualityIndex]?.url;
        selectedQuality = freeFormat;
        console.log(`✅ Regular video quality: ${selectedQuality.quality}`);
      }
    }

    const result = {
      title: data.title,
      thumbnail: data.cover,
      duration: data.duration,
      isShorts: isShorts,
      formats: qualityOptions,
      url: defaultUrl,
      selectedQuality: selectedQuality,
      audioGuaranteed: selectedQuality?.hasAudio || false
    };

    console.log(`✅ YouTube service completed`);
    console.log(`🎯 Final selection: ${selectedQuality?.quality}`);
    console.log(`🔊 Audio guaranteed: ${result.audioGuaranteed}`);
    console.log(`📺 Is Shorts: ${isShorts}`);
    
    return result;
    
  } catch (err) {
    console.error('❌ YouTube service error:', err.message);
    
    if (err.response) {
      console.error('📡 Response status:', err.response.status);
      console.error('📡 Response data:', err.response.data);
    }
    
    throw new Error(`YouTube downloader request failed: ${err.message}`);
  }
}

module.exports = { fetchYouTubeData };
