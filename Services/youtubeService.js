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

    // Log all available formats for debugging
    console.log('🔍 Available formats:');
    data.items.forEach((item, index) => {
      console.log(`  ${index + 1}. ${item.label} - ${item.type} - URL: ${item.url ? 'YES' : 'NO'}`);
    });

    // ========================================
    // ENHANCED FILTERING FOR BOTH SHORTS & REGULAR VIDEOS
    // ========================================
    
    let availableFormats = data.items.filter(item => {
      const label = (item.label || '').toLowerCase();
      const type = (item.type || '').toLowerCase();
      const hasUrl = item.url && item.url.length > 0;
      
      // Enhanced audio detection
      const hasAudio = !label.includes('video only') && 
                       !label.includes('audio only') &&
                       !type.includes('video only') &&
                       !label.includes('vid only');

      // For Shorts, be more lenient with format types
      if (isShorts) {
        return hasUrl && (hasAudio || type.includes('audio') || label.includes('audio'));
      }
      
      // For regular videos, prioritize formats with audio
      return hasUrl && hasAudio;
    });

    console.log(`✅ Found ${availableFormats.length} formats with audio`);

    // If no formats with audio found, try alternative approach
    if (availableFormats.length === 0) {
      console.log('⚠️ No formats with audio found, trying alternative filtering...');
      
      availableFormats = data.items.filter(item => {
        const label = (item.label || '').toLowerCase();
        const hasUrl = item.url && item.url.length > 0;
        
        // Exclude clearly audio-only formats
        const isAudioOnly = label.includes('audio only') || 
                           label.includes('audio');
        
        return hasUrl && !isAudioOnly;
      });
      
      console.log(`🔄 Alternative filtering found ${availableFormats.length} formats`);
    }

    // Final fallback - use all available formats
    if (availableFormats.length === 0) {
      console.log('🚨 No suitable formats found, using all available formats...');
      availableFormats = data.items.filter(item => item.url && item.url.length > 0);
    }

    // ========================================
    // QUALITY SORTING AND PRIORITIZATION
    // ========================================
    
    // Sort by quality (highest first)
    availableFormats.sort((a, b) => {
      const getQualityValue = (label) => {
        if (!label) return 0;
        const labelLower = label.toLowerCase();
        const match = labelLower.match(/(\d+)p/);
        if (match) return parseInt(match[1]);
        
        // Handle quality labels without 'p'
        if (labelLower.includes('1440') || labelLower.includes('2k')) return 1440;
        if (labelLower.includes('2160') || labelLower.includes('4k')) return 2160;
        if (labelLower.includes('1080')) return 1080;
        if (labelLower.includes('720')) return 720;
        if (labelLower.includes('480')) return 480;
        if (labelLower.includes('360')) return 360;
        if (labelLower.includes('240')) return 240;
        if (labelLower.includes('144')) return 144;
        
        return 0;
      };
      
      const qualityA = getQualityValue(a.label);
      const qualityB = getQualityValue(b.label);
      return qualityB - qualityA;
    });

    console.log('📊 Sorted formats:');
    availableFormats.forEach((format, index) => {
      console.log(`  ${index + 1}. ${format.label} - ${format.type}`);
    });

    // ========================================
    // QUALITY RESTRICTIONS BASED ON PREMIUM STATUS
    // ========================================
    
    // Define quality restrictions
    const premiumQualities = ['1440p', '2160p', '4k', '1080p', '720p', '480p', '360p', '240p'];
    
    // SHORTS: 480p or 360p only (to avoid audio issues with higher qualities)
    // REGULAR: 360p for free users, higher qualities for premium
    const freeQualities = isShorts ? ['480p', '360p'] : ['360p', '480p'];

    // Map to quality options
    const qualityOptions = availableFormats.map(format => {
      const quality = format.label || 'unknown';
      
      // Check if this quality is premium-only
      let isPremiumOnly = true;
      for (const freeQ of freeQualities) {
        if (quality.toLowerCase().includes(freeQ)) {
          isPremiumOnly = false;
          break;
        }
      }
      
      // If it's not in free qualities but is in premium qualities, mark as premium
      if (isPremiumOnly) {
        for (const premQ of premiumQualities) {
          if (quality.toLowerCase().includes(premQ)) {
            isPremiumOnly = true;
            break;
          }
        }
      }
      
      return {
        quality: quality,
        url: format.url,
        type: format.type || 'video/mp4',
        extension: format.ext || format.extension || 'mp4',
        filesize: format.filesize || 'unknown',
        isPremium: isPremiumOnly
      };
    });

    // ========================================
    // SMART DEFAULT QUALITY SELECTION
    // ========================================
    
    let defaultUrl = availableFormats[0]?.url;
    let selectedQuality = qualityOptions[0];
    
    // For Shorts: Prefer 480p or 360p to avoid audio issues
    if (isShorts) {
      console.log('🎬 Shorts detected - prioritizing 480p/360p for audio compatibility');
      
      const shortsPreferredQualities = ['480p', '360p'];
      
      for (const preferredQuality of shortsPreferredQualities) {
        const preferredFormat = qualityOptions.find(q => 
          q.quality.toLowerCase().includes(preferredQuality) && !q.isPremium
        );
        
        if (preferredFormat) {
          defaultUrl = preferredFormat.url;
          selectedQuality = preferredFormat;
          console.log(`✅ Selected Shorts quality: ${preferredFormat.quality}`);
          break;
        }
      }
      
      // If no preferred quality found, use first available free quality
      if (defaultUrl === availableFormats[0]?.url) {
        const freeFormat = qualityOptions.find(q => !q.isPremium);
        if (freeFormat) {
          defaultUrl = freeFormat.url;
          selectedQuality = freeFormat;
          console.log(`🔄 Using available free quality for Shorts: ${freeFormat.quality}`);
        }
      }
    } else {
      // For regular videos: Use first free quality
      const freeFormat = qualityOptions.find(q => !q.isPremium);
      if (freeFormat) {
        defaultUrl = freeFormat.url;
        selectedQuality = freeFormat;
        console.log(`✅ Selected regular video quality: ${freeFormat.quality}`);
      } else {
        console.log(`🎯 Using first available quality: ${selectedQuality?.quality}`);
      }
    }

    const result = {
      title: data.title,
      thumbnail: data.cover,
      duration: data.duration,
      isShorts: isShorts,
      formats: qualityOptions,
      url: defaultUrl,
      selectedQuality: selectedQuality // Include the selected quality info
    };

    console.log(`✅ YouTube service completed: ${result.formats.length} formats available`);
    console.log(`🎯 Default quality: ${selectedQuality?.quality} (Shorts: ${isShorts})`);
    return result;
    
  } catch (err) {
    console.error('❌ YouTube service error:', err.message);
    
    // Enhanced error information
    if (err.response) {
      console.error('📡 Response status:', err.response.status);
      console.error('📡 Response data:', err.response.data);
    }
    
    throw new Error(`YouTube downloader request failed: ${err.message}`);
  }
}

module.exports = { fetchYouTubeData };
