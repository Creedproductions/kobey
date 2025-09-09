// ===== DEPENDENCIES =====
const { ttdl, twitter } = require('btch-downloader');
const { igdl } = require('btch-downloader');
const { pinterest } = require('ironman-api');
const { BitlyClient } = require('bitly');
const axios = require('axios');
const { ytdl, pindl } = require('jer-api');

// Local services
const config = require('../Config/config');
const threadsDownloader = require('../Services/threadsService');
const fetchLinkedinData = require('../Services/linkedinService');
const facebookInsta = require('../Services/facebookInstaService');
const { downloadTwmateData } = require('../Services/twitterService');
const { fetchYouTubeData } = require('../Services/youtubeService');

// Initialize external services
const bitly = new BitlyClient(config.BITLY_ACCESS_TOKEN);

// ===== CONSTANTS =====
const SUPPORTED_PLATFORMS = [
  'instagram', 'tiktok', 'facebook', 'twitter',
  'youtube', 'pinterest', 'threads', 'linkedin'
];

const PLACEHOLDER_THUMBNAIL = 'https://via.placeholder.com/300x150';
const DOWNLOAD_TIMEOUT = 45000; // Increased to 45 seconds for better reliability

// ===== UTILITY FUNCTIONS =====

/**
 * Identifies the platform based on URL
 * @param {string} url - The URL to analyze
 * @returns {string|null} - The identified platform or null
 */
const identifyPlatform = (url) => {
  console.info("Platform Identification: Determining the platform for the given URL.");

  const platformMap = {
    'instagram.com': 'instagram',
    'tiktok.com': 'tiktok',
    'facebook.com': 'facebook',
    'fb.watch': 'facebook',
    'x.com': 'twitter',
    'twitter.com': 'twitter',
    'youtube.com': 'youtube',
    'youtu.be': 'youtube',
    'pinterest.com': 'pinterest',
    'pin.it': 'pinterest',
    'threads.net': 'threads',
    'threads.com': 'threads',
    'linkedin.com': 'linkedin'
  };

  for (const [domain, platform] of Object.entries(platformMap)) {
    if (url.includes(domain)) {
      return platform;
    }
  }

  console.warn("Platform Identification: Unable to identify the platform.");
  return null;
};

/**
 * Normalizes and cleans YouTube URLs (preserves shorts functionality)
 * @param {string} url - YouTube URL
 * @returns {string} - Normalized URL
 */
const normalizeYouTubeUrl = (url) => {
  // Remove fragments but preserve query parameters for regular videos
  let cleanUrl = url.split('#')[0];

  // Handle YouTube Shorts - PRESERVE YOUR EXISTING LOGIC
  const shortsRegex = /youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/;
  const shortsMatch = cleanUrl.match(shortsRegex);
  if (shortsMatch) {
    // Keep shorts as shorts for your existing functionality
    return `https://www.youtube.com/shorts/${shortsMatch[1]}`;
  }

  // Handle youtu.be links
  const shortRegex = /youtu\.be\/([a-zA-Z0-9_-]+)/;
  const shortMatch = cleanUrl.match(shortRegex);
  if (shortMatch) {
    return `https://www.youtube.com/watch?v=${shortMatch[1]}`;
  }

  return cleanUrl;
};

/**
 * Validates and cleans URL format
 * @param {string} url - URL to validate
 * @returns {Object} - Validation result with cleaned URL
 */
const validateUrl = (url) => {
  if (!url) {
    return { isValid: false, error: 'No URL provided' };
  }

  if (typeof url !== 'string' || url.trim().length === 0) {
    return { isValid: false, error: 'Invalid URL format' };
  }

  // Clean URL
  const cleanedUrl = url.trim();

  // Basic URL validation
  try {
    new URL(cleanedUrl);
  } catch (e) {
    return { isValid: false, error: 'Invalid URL format' };
  }

  return { isValid: true, cleanedUrl };
};

/**
 * Enhanced timeout wrapper with better error handling
 * @param {Function} downloadFunction - The download function to wrap
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise} - Promise with timeout
 */
const downloadWithTimeout = (downloadFunction, timeout = DOWNLOAD_TIMEOUT) => {
  return Promise.race([
    downloadFunction(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Download timeout - operation took too long')), timeout)
    )
  ]);
};

// ===== ENHANCED THREADS HANDLER =====

/**
 * Enhanced Threads downloader with better error handling
 */
const enhancedThreadsDownloader = async (url) => {
  console.log('Enhanced Threads: Starting download for URL:', url);

  try {
    // First attempt with original service
    const data = await downloadWithTimeout(() => threadsDownloader(url), 30000);
    console.log('Enhanced Threads: Original service succeeded');
    return data;
  } catch (error) {
    console.warn('Enhanced Threads: Original service failed, trying alternative approach...', error.message);

    // Alternative approach for Threads
    try {
      // Clean URL and ensure proper format
      let cleanUrl = url.replace('threads.com', 'threads.net').split('#')[0];

      // Try fetching with different user agent
      const response = await axios.get(cleanUrl, {
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
        }
      });

      const html = response.data;

      // Look for video URLs in different formats
      const videoPatterns = [
        /https:\/\/[^"']*\.mp4[^"']*/gi,
        /"video_url":"([^"]+)"/gi,
        /"playback_url":"([^"]+)"/gi,
        /videoUrl.*?["']([^"']*\.mp4[^"']*)/gi
      ];

      let videoUrl = null;
      for (const pattern of videoPatterns) {
        const matches = html.match(pattern);
        if (matches && matches.length > 0) {
          videoUrl = matches[0].replace(/"/g, '').replace('video_url:', '').replace('playback_url:', '');
          if (videoUrl.startsWith('http')) {
            break;
          }
        }
      }

      if (videoUrl) {
        console.log('Enhanced Threads: Alternative extraction succeeded');
        return {
          title: 'Threads Post',
          download: videoUrl,
          thumbnail: PLACEHOLDER_THUMBNAIL,
          quality: 'Best'
        };
      }
    } catch (altError) {
      console.error('Enhanced Threads: Alternative approach also failed:', altError.message);
    }

    throw new Error(`Threads download failed: ${error.message}. This may be due to the post being private, deleted, or containing only images/text without video content.`);
  }
};

// ===== PLATFORM-SPECIFIC DOWNLOADERS =====

const platformDownloaders = {
  async instagram(url) {
    try {
      const data = await downloadWithTimeout(() => igdl(url));
      if (!data || (Array.isArray(data) && data.length === 0)) {
        throw new Error('Instagram primary service returned empty data');
      }
      return data;
    } catch (error) {
      console.warn('Instagram primary downloader failed, trying fallback...', error.message);
      const fallbackData = await downloadWithTimeout(() => facebookInsta(url));
      if (!fallbackData || !fallbackData.media) {
        throw new Error('Instagram download failed - both primary and fallback methods failed');
      }
      return fallbackData;
    }
  },

  async tiktok(url) {
    const data = await downloadWithTimeout(() => ttdl(url));
    if (!data || !data.video) {
      throw new Error('TikTok service returned invalid data');
    }
    return data;
  },

  async facebook(url) {
    const data = await downloadWithTimeout(() => facebookInsta(url));
    if (!data || (!data.media && !data.data)) {
      throw new Error('Facebook service returned invalid data');
    }
    return data;
  },

  async twitter(url) {
    try {
      const data = await downloadWithTimeout(() => twitter(url));
      const hasValidData = data.data && (data.data.HD || data.data.SD);
      const hasValidUrls = Array.isArray(data.url) &&
        data.url.some(item => item && Object.keys(item).length > 0 && item.url);

      if (!hasValidData && !hasValidUrls) {
        throw new Error("Twitter primary service returned unusable data");
      }
      return data;
    } catch (error) {
      console.warn("Twitter: Primary service failed, trying custom service...", error.message);
      const fallbackData = await downloadWithTimeout(() => downloadTwmateData(url));
      console.log('Twitter custom service returned:', JSON.stringify(fallbackData, null, 2));

      if (!fallbackData || (!Array.isArray(fallbackData) && !fallbackData.data)) {
        throw new Error('Twitter download failed - both primary and fallback methods failed');
      }
      return fallbackData;
    }
  },

  async youtube(url) {
    console.log('YouTube: Processing URL:', url);

    try {
      // Use your existing YouTube service with longer timeout for regular videos
      const timeout = url.includes('/shorts/') ? 30000 : 60000; // Longer timeout for regular videos
      const data = await downloadWithTimeout(() => fetchYouTubeData(url), timeout);

      if (!data || !data.title || !data.formats) {
        throw new Error('YouTube service returned invalid data');
      }

      console.log('YouTube: Successfully fetched data');
      return data;
    } catch (error) {
      // Handle specific YouTube errors
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
  },

  async pinterest(url) {
    const data = await downloadWithTimeout(() => pindl(url));
    if (!data || (!data.result && !data.url)) {
      throw new Error('Pinterest service returned invalid data');
    }
    return data;
  },

  async threads(url) {
    return await enhancedThreadsDownloader(url);
  },

  async linkedin(url) {
    const data = await downloadWithTimeout(() => fetchLinkedinData(url));
    if (!data || !data.data || !data.data.videos) {
      throw new Error('LinkedIn service returned invalid data');
    }
    return data;
  }
};

// ===== DATA FORMATTERS =====

const dataFormatters = {
  youtube(data) {
    console.log('YouTube Formatter: Processing data...');

    if (!data || !data.title) {
      throw new Error("YouTube data is incomplete or improperly formatted.");
    }

    const videoWithAudio = data.formats?.filter(f => f.type === 'video_with_audio') || [];
    const videoOnly = data.formats?.filter(f => f.type === 'video') || [];
    const audioOnly = data.formats?.filter(f => f.type === 'audio') || [];

    // Prioritize video with audio formats
    const bestVideo = videoWithAudio.find(f => f.quality?.includes('720p')) ||
                     videoWithAudio.find(f => f.quality?.includes('480p')) ||
                     videoWithAudio.find(f => f.quality?.includes('360p')) ||
                     videoWithAudio[0] ||
                     videoOnly.find(f => f.quality?.includes('720p')) ||
                     videoOnly[0];

    const bestAudio = audioOnly.find(f => f.quality?.includes('131kb/s') || f.extension === 'm4a') ||
                     audioOnly[0];

    console.log('YouTube Formatter: Best video format selected:', bestVideo?.quality || 'none');

    return {
      title: data.title || 'Untitled Video',
      url: bestVideo?.url || '',
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: [...videoWithAudio, ...videoOnly].map(f => f.quality).filter(Boolean),
      audio: bestAudio?.url || '',
      duration: data.duration || 'Unknown',
      source: 'youtube',
    };
  },

  instagram(data) {
    if (data && data.media && Array.isArray(data.media)) {
      const mediaItem = data.media[0];
      return {
        title: data.title || 'Instagram Media',
        url: mediaItem?.url || '',
        thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
        sizes: ['Original Quality'],
        source: 'instagram',
      };
    }

    if (!data || !data[0]?.url) {
      throw new Error("Instagram data is missing or invalid.");
    }

    return {
      title: data[0]?.wm || 'Instagram Media',
      url: data[0]?.url,
      thumbnail: data[0]?.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: ['Original Quality'],
      source: 'instagram',
    };
  },

  twitter(data) {
    console.log('DEBUG FORMATTING: Twitter data received in formatting:', JSON.stringify(data, null, 2));

    if (data.data && (data.data.HD || data.data.SD)) {
      const twitterData = data.data;
      return {
        title: 'Twitter Video',
        url: twitterData.HD || twitterData.SD || '',
        thumbnail: twitterData.thumbnail || PLACEHOLDER_THUMBNAIL,
        sizes: twitterData.HD ? ['HD'] : ['SD'],
        source: 'twitter',
      };
    }

    if (data.data && Array.isArray(data.data) && data.data.length > 0) {
      const videoArray = data.data;
      const bestQuality = videoArray.find(item => item.quality.includes('1280x720')) ||
                         videoArray.find(item => item.quality.includes('640x360')) ||
                         videoArray[0];

      return {
        title: 'Twitter Video',
        url: bestQuality.url || '',
        thumbnail: PLACEHOLDER_THUMBNAIL,
        sizes: videoArray.map(item => item.quality),
        source: 'twitter',
      };
    }

    if (Array.isArray(data) && data.length > 0) {
      const bestQuality = data.find(item => item.quality.includes('1280x720')) ||
                         data.find(item => item.quality.includes('640x360')) ||
                         data[0];

      return {
        title: 'Twitter Video',
        url: bestQuality.url || '',
        thumbnail: PLACEHOLDER_THUMBNAIL,
        sizes: data.map(item => item.quality),
        source: 'twitter',
      };
    }

    throw new Error("Twitter video data is incomplete or improperly formatted.");
  },

  facebook(data) {
    console.log("Processing Facebook data...");

    if (data && data.media && Array.isArray(data.media)) {
      const videoMedia = data.media.find(item => item.type === 'video') || data.media[0];
      return {
        title: data.title || 'Facebook Video',
        url: videoMedia?.url || '',
        thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
        sizes: [videoMedia?.quality || 'Original Quality'],
        source: 'facebook',
      };
    }

    const fbData = data.data || [];
    const hdVideo = fbData.find(video => video.resolution?.includes('720p'));
    const sdVideo = fbData.find(video => video.resolution?.includes('360p'));
    const selectedVideo = hdVideo || sdVideo;

    return {
      title: data.title || 'Facebook Video',
      url: selectedVideo?.url || '',
      thumbnail: selectedVideo?.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: [selectedVideo ? (hdVideo ? '720p' : '360p') : 'Unknown'],
      source: 'facebook',
    };
  },

  pinterest(data) {
    const pinterestData = data?.data || data;
    return {
      title: 'Pinterest Image',
      url: pinterestData.result || pinterestData.url || '',
      thumbnail: pinterestData.result || pinterestData.url || PLACEHOLDER_THUMBNAIL,
      sizes: ['Original Quality'],
      source: 'pinterest',
    };
  },

  tiktok(data) {
    console.log("Processing TikTok data...");
    return {
      title: data.title || 'Untitled Video',
      url: data.video?.[0] || '',
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: ['Original Quality'],
      audio: data.audio?.[0] || '',
      source: 'tiktok',
    };
  },

  threads(data) {
    console.log("Processing Threads data...");
    return {
      title: data.title || 'Threads Post',
      url: data.download,
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: [data.quality || 'Unknown'],
      source: 'threads',
    };
  },

  linkedin(data) {
    console.log("Processing LinkedIn data...");
    const videoUrl = Array.isArray(data?.data?.videos) && data.data.videos.length > 0
      ? data.data.videos[0]
      : '';

    return {
      title: 'LinkedIn Video',
      url: videoUrl,
      thumbnail: videoUrl ? PLACEHOLDER_THUMBNAIL : 'Error',
      sizes: ['Original Quality'],
      source: 'linkedin',
    };
  }
};

/**
 * Standardizes the response for different platforms
 * @param {string} platform - The platform name
 * @param {Object} data - Raw data from platform
 * @returns {Object} - Formatted data
 */
const formatData = async (platform, data) => {
  console.info(`Data Formatting: Formatting data for platform '${platform}'.`);

  const formatter = dataFormatters[platform];
  if (!formatter) {
    console.warn("Data Formatting: Generic formatting applied.");
    return {
      title: data.title || 'Untitled Media',
      url: data.url || '',
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: data.sizes?.length > 0 ? data.sizes : ['Original Quality'],
      source: platform,
    };
  }

  return formatter(data);
};

// ===== MAIN CONTROLLER =====

/**
 * Main function to handle media download
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const downloadMedia = async (req, res) => {
  const { url } = req.body;
  console.log("Received URL:", url);

  try {
    // Validate and clean URL
    const urlValidation = validateUrl(url);
    if (!urlValidation.isValid) {
      console.warn(`Download Media: ${urlValidation.error}`);
      return res.status(400).json({
        error: urlValidation.error,
        success: false
      });
    }

    const cleanedUrl = urlValidation.cleanedUrl;

    // Identify platform
    const platform = identifyPlatform(cleanedUrl);
    if (!platform) {
      console.warn("Download Media: Unsupported platform for the given URL.");
      return res.status(400).json({
        error: 'Unsupported platform',
        success: false,
        supportedPlatforms: SUPPORTED_PLATFORMS
      });
    }

    // Process URL (normalize if needed) - PRESERVE SHORTS FUNCTIONALITY
    let processedUrl = cleanedUrl;
    if (platform === 'youtube') {
      processedUrl = normalizeYouTubeUrl(cleanedUrl);
      console.log(`YouTube URL processed: ${cleanedUrl} -> ${processedUrl}`);
    }

    console.info(`Download Media: Fetching data for platform '${platform}'.`);

    // Download data using platform-specific downloader
    const downloader = platformDownloaders[platform];
    if (!downloader) {
      throw new Error(`No downloader available for platform: ${platform}`);
    }

    const data = await downloader(processedUrl);

    // Validate returned data
    if (!data) {
      console.error("Download Media: No data returned for the platform.");
      return res.status(404).json({
        error: 'No data found for this URL',
        success: false,
        platform: platform
      });
    }

    // Format data
    let formattedData;
    try {
      formattedData = await formatData(platform, data);
    } catch (formatError) {
      console.error(`Download Media: Data formatting failed - ${formatError.message}`);
      return res.status(500).json({
        error: 'Failed to format media data',
        success: false,
        details: formatError.message,
        platform: platform
      });
    }

    // Validate formatted data
    if (!formattedData || !formattedData.url) {
      console.error("Download Media: Formatted data is invalid or missing URL.");
      return res.status(500).json({
        error: 'Invalid media data - no download URL found',
        success: false,
        platform: platform
      });
    }

    // Log success and prepare response
    console.log('Final video URL length:', formattedData.url.length);
    console.info("Download Media: Media successfully downloaded and formatted.");

    // Send successful response
    res.status(200).json({
      success: true,
      data: formattedData,
      platform: platform,
      timestamp: new Date().toISOString(),
      debug: {
        originalUrl: url,
        cleanedUrl: cleanedUrl,
        processedUrl: processedUrl,
        hasValidUrl: !!formattedData.url,
        urlLength: formattedData.url ? formattedData.url.length : 0
      }
    });

  } catch (error) {
    console.error(`Download Media: Error occurred - ${error.message}`);
    console.error('Error stack:', error.stack);

    // Determine appropriate status code based on error
    let statusCode = 500;
    if (error.message.includes('not available') || error.message.includes('not found')) {
      statusCode = 404;
    } else if (error.message.includes('forbidden') || error.message.includes('access')) {
      statusCode = 403;
    } else if (error.message.includes('timeout')) {
      statusCode = 408;
    }

    // Return detailed error response
    res.status(statusCode).json({
      error: 'Failed to download media',
      success: false,
      details: error.message,
      platform: identifyPlatform(url) || 'unknown',
      timestamp: new Date().toISOString(),
      suggestions: getErrorSuggestions(error.message, identifyPlatform(url))
    });
  }
};

/**
 * Provides user-friendly suggestions based on error type and platform
 * @param {string} errorMessage - The error message
 * @param {string} platform - The platform name
 * @returns {Array} - Array of suggestions
 */
const getErrorSuggestions = (errorMessage, platform) => {
  const suggestions = [];

  if (platform === 'threads') {
    suggestions.push('Make sure the Threads post contains video content (not just images or text)');
    suggestions.push('Check if the post is public and not deleted');
    suggestions.push('Try copying the URL again from the Threads app/website');
  }

  if (platform === 'youtube') {
    if (errorMessage.includes('timeout')) {
      suggestions.push('YouTube videos may take longer to process - try again in a moment');
      suggestions.push('Large videos may need more time to download');
    }
  }

  if (errorMessage.includes('not available') || errorMessage.includes('410')) {
    suggestions.push('The content may have been removed or made private');
    suggestions.push('Try checking if the content is still accessible in a browser');
  }

  if (errorMessage.includes('forbidden') || errorMessage.includes('403')) {
    suggestions.push('The content may be age-restricted or region-locked');
    suggestions.push('Try using a different content URL');
  }

  if (errorMessage.includes('timeout')) {
    suggestions.push('The server may be slow or the content is very large');
    suggestions.push('Try again in a few minutes');
  }

  return suggestions;
};

// ===== EXPORTS =====
module.exports = {
  downloadMedia
};