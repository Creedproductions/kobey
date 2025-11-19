// Helper function to decode MERGE URLs
function decodeMergeUrl(mergeUrl, serverBaseUrl) {
  if (!mergeUrl) return mergeUrl;
  
  // Handle new MERGE_V2 format with base64 encoding
  if (mergeUrl.startsWith('MERGE_V2|')) {
    const parts = mergeUrl.split('|');
    if (parts.length >= 3) {
      try {
        const videoUrl = Buffer.from(parts[1], 'base64').toString('utf-8');
        const audioUrl = Buffer.from(parts[2], 'base64').toString('utf-8');
        return `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(videoUrl)}&audioUrl=${encodeURIComponent(audioUrl)}`;
      } catch (error) {
        console.error('❌ Failed to decode MERGE_V2 URL:', error.message);
        return mergeUrl;
      }
    }
  }
  
  // Legacy MERGE format (kept for compatibility)
  if (mergeUrl.startsWith('MERGE:')) {
    // Try to parse old format - this is fragile due to colons in URLs
    const content = mergeUrl.substring(6); // Remove 'MERGE:'
    // Try to find the second https:// which indicates the start of audio URL
    const audioUrlStart = content.indexOf('https://', content.indexOf('https://') + 8);
    if (audioUrlStart > 0) {
      const videoUrl = content.substring(0, audioUrlStart);
      const audioUrl = content.substring(audioUrlStart);
      return `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(videoUrl)}&audioUrl=${encodeURIComponent(audioUrl)}`;
    }
  }
  
  return mergeUrl;
}

// Helper function to convert all MERGE URLs in formats array
function convertMergeUrls(formats, serverBaseUrl) {
  if (!formats || !Array.isArray(formats)) return formats;
  
  return formats.map(format => {
    if (format.url && (format.url.startsWith('MERGE') || format.url.includes('MERGE'))) {
      const convertedUrl = decodeMergeUrl(format.url, serverBaseUrl);
      console.log(`🔄 Converted merge URL for ${format.quality}: ${convertedUrl.substring(0, 100)}...`);
      return {
        ...format,
        url: convertedUrl
      };
    }
    return format;
  });
}

// YouTube formatter - FIXED to properly convert MERGE URLs
function formatYouTubeData(data, req) {
  console.log('🎬 Formatting YouTube data...');
  
  if (!data || !data.title) {
    throw new Error('Invalid YouTube data received');
  }

  // Check if we have quality formats
  const hasFormats = data.formats && data.formats.length > 0;
  const hasAllFormats = data.allFormats && data.allFormats.length > 0;
  
  console.log(`📊 YouTube data: hasFormats=${hasFormats}, hasAllFormats=${hasAllFormats}`);
  
  let qualityOptions = [];
  let selectedQuality = null;
  let defaultUrl = data.url;
  
  // Get server base URL for merge endpoint conversion
  const serverBaseUrl = getServerBaseUrl(req);

  if (hasFormats || hasAllFormats) {
    // Use formats if available, otherwise use allFormats
    const rawFormats = data.formats || data.allFormats;
    
    // CRITICAL: Convert all MERGE URLs to actual merge endpoint URLs
    qualityOptions = convertMergeUrls(rawFormats, serverBaseUrl);
    
    // Find the default selected quality (360p or first available)
    selectedQuality = qualityOptions.find(opt => 
      opt.quality && opt.quality.includes('360p')
    ) || qualityOptions[0];
    
    // Convert the default URL if it's a MERGE URL
    defaultUrl = decodeMergeUrl(selectedQuality?.url || data.url, serverBaseUrl);
    
    console.log(`✅ YouTube: ${qualityOptions.length} quality options available`);
    console.log(`🎯 Selected quality: ${selectedQuality?.quality}`);
    
    // Count merged formats for debugging
    const mergeFormats = qualityOptions.filter(f => 
      f.url && f.url.includes('/api/merge-audio')
    );
    console.log(`🎵 Merge formats available: ${mergeFormats.length}`);
    
  } else {
    console.log('⚠️ No quality formats found, creating fallback');
    // Fallback: create basic quality option
    defaultUrl = decodeMergeUrl(data.url, serverBaseUrl);
    qualityOptions = [
      {
        quality: '360p',
        qualityNum: 360,
        url: defaultUrl,
        type: 'video/mp4',
        extension: 'mp4',
        isPremium: false,
        hasAudio: true
      }
    ];
    selectedQuality = qualityOptions[0];
  }

  // Build the response object
  const result = {
    title: data.title,
    url: defaultUrl,
    thumbnail: data.thumbnail || 'https://via.placeholder.com/300x150',
    sizes: qualityOptions.map(f => f.quality),
    duration: data.duration || 'unknown',
    source: 'youtube',
    formats: qualityOptions,
    allFormats: qualityOptions,
    selectedQuality: selectedQuality
  };

  console.log(`✅ YouTube formatting complete`);
  console.log(`📦 Sending to client: ${qualityOptions.length} formats`);
  console.log(`🔗 Default URL: ${defaultUrl?.substring(0, 100)}...`);
  
  return result;
}

// Helper function to get server base URL
function getServerBaseUrl(req) {
  const host = req.get('host');
  const protocol = req.secure || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
  return process.env.SERVER_BASE_URL || `${protocol}://${host}`;
}

// YouTube downloader - FIXED to properly convert MERGE URLs
async function downloadYouTube(url, req) {
  const fetchYouTubeData = require('../Services/youtubeService').fetchYouTubeData;
  
  console.log('YouTube: Processing URL:', url);

  try {
    const timeout = url.includes('/shorts/') ? 30000 : 60000;
    
    // Create promise wrapper for timeout
    const dataPromise = fetchYouTubeData(url);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Download timeout')), timeout)
    );
    
    const data = await Promise.race([dataPromise, timeoutPromise]);

    if (!data || !data.title) {
      throw new Error('YouTube service returned invalid data');
    }

    console.log('YouTube: Successfully fetched data, formats count:', data.formats?.length || 0);
    
    // Get server base URL for merge endpoint conversion
    const serverBaseUrl = getServerBaseUrl(req);
    
    // Convert MERGE URLs in formats array
    if (data.formats) {
      data.formats = convertMergeUrls(data.formats, serverBaseUrl);
    }
    
    // Convert MERGE URLs in allFormats array
    if (data.allFormats) {
      data.allFormats = convertMergeUrls(data.allFormats, serverBaseUrl);
    }
    
    // Convert the default URL if it's a MERGE URL
    if (data.url) {
      data.url = decodeMergeUrl(data.url, serverBaseUrl);
    }
    
    // Convert selectedQuality URL if it exists
    if (data.selectedQuality && data.selectedQuality.url) {
      data.selectedQuality.url = decodeMergeUrl(data.selectedQuality.url, serverBaseUrl);
    }

    return data;
  } catch (error) {
    if (error.message.includes('Status code: 410')) {
      throw new Error('YouTube video not available (removed or private)');
    }
    if (error.message.includes('Status code: 403')) {
      throw new Error('YouTube video access forbidden (age-restricted or region-locked)');
    }
    if (error.message.includes('Status code: 404')) {
      throw new Error('YouTube video not found (invalid URL or removed)');
    }
    if (error.message.includes('timeout')) {
      throw new Error('YouTube download timed out - video processing may be slow, please try again');
    }

    throw new Error(`YouTube download failed: ${error.message}`);
  }
}

module.exports = {
  downloadYouTube,
  formatYouTubeData,
  decodeMergeUrl,
  convertMergeUrls,
  getServerBaseUrl
};
