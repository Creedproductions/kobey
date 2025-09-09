// ===== DEPENDENCIES =====
const { ttdl, twitter } = require('btch-downloader');
const { igdl } = require('btch-downloader');
const { pinterest } = require('ironman-api');
const { BitlyClient } = require('bitly');
const tinyurl = require('tinyurl');
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
const DOWNLOAD_TIMEOUT = 30000; // 30 seconds

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
 * Normalizes YouTube URLs (converts shorts to regular format)
 * @param {string} url - YouTube URL
 * @returns {string} - Normalized URL
 */
const normalizeYouTubeUrl = (url) => {
  const shortsRegex = /youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/;
  const match = url.match(shortsRegex);
  
  if (match) {
    return `https://www.youtube.com/watch?v=${match[1]}`;
  }
  
  return url;
};

/**
 * Validates URL format and content
 * @param {string} url - URL to validate
 * @returns {Object} - Validation result
 */
const validateUrl = (url) => {
  if (!url) {
    return { isValid: false, error: 'No URL provided' };
  }

  if (typeof url !== 'string' || url.trim().length === 0) {
    return { isValid: false, error: 'Invalid URL format' };
  }

  return { isValid: true };
};

/**
 * Adds timeout wrapper for download operations
 * @param {Function} downloadFunction - The download function to wrap
 * @returns {Promise} - Promise with timeout
 */
const downloadWithTimeout = (downloadFunction) => {
  return Promise.race([
    downloadFunction(),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Download timeout - operation took too long')), DOWNLOAD_TIMEOUT)
    )
  ]);
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
    const data = await downloadWithTimeout(() => fetchYouTubeData(url));
    if (!data || !data.title || !data.formats) {
      throw new Error('YouTube service returned invalid data');
    }
    return data;
  },

  async pinterest(url) {
    const data = await downloadWithTimeout(() => pindl(url));
    if (!data || (!data.result && !data.url)) {
      throw new Error('Pinterest service returned invalid data');
    }
    return data;
  },

  async threads(url) {
    const data = await downloadWithTimeout(() => threadsDownloader(url));
    if (!data || !data.download) {
      throw new Error('Threads service returned invalid data');
    }
    return data;
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
    if (!data || !data.title) {
      throw new Error("YouTube data is incomplete or improperly formatted.");
    }

    const videoWithAudio = data.formats?.filter(f => f.type === 'video_with_audio') || [];
    const videoOnly = data.formats?.filter(f => f.type === 'video') || [];
    const audioOnly = data.formats?.filter(f => f.type === 'audio') || [];

    const bestVideo = videoWithAudio.find(f => f.quality?.includes('720p')) ||
                     videoWithAudio.find(f => f.quality?.includes('480p')) ||
                     videoWithAudio.find(f => f.quality?.includes('360p')) ||
                     videoWithAudio[0] ||
                     videoOnly.find(f => f.quality?.includes('720p')) ||
                     videoOnly[0];

    const bestAudio = audioOnly.find(f => f.quality?.includes('131kb/s') || f.extension === 'm4a') ||
                     audioOnly[0];

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
      title: 'Threads Post',
      url: data.download,
      thumbnail: data.thumbnail,
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
    // Validate URL
    const urlValidation = validateUrl(url);
    if (!urlValidation.isValid) {
      console.warn(`Download Media: ${urlValidation.error}`);
      return res.status(400).json({
        error: urlValidation.error,
        success: false
      });
    }

    // Identify platform
    const platform = identifyPlatform(url);
    if (!platform) {
      console.warn("Download Media: Unsupported platform for the given URL.");
      return res.status(400).json({
        error: 'Unsupported platform',
        success: false,
        supportedPlatforms: SUPPORTED_PLATFORMS
      });
    }

    // Process URL (normalize if needed)
    let processedUrl = url;
    if (platform === 'youtube') {
      processedUrl = normalizeYouTubeUrl(url);
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
    console.log('Using original URLs without shortening to avoid redirect issues');
    console.log('Final video URL:', formattedData.url.substring(0, 100) + '...');
    console.info("Download Media: Media successfully downloaded and formatted.");

    // Send successful response
    res.status(200).json({
      success: true,
      data: formattedData,
      platform: platform,
      timestamp: new Date().toISOString(),
      debug: {
        originalUrl: url,
        processedUrl: processedUrl,
        hasValidUrl: !!formattedData.url,
        urlLength: formattedData.url ? formattedData.url.length : 0,
        urlShortening: 'disabled'
      }
    });

  } catch (error) {
    console.error(`Download Media: Error occurred - ${error.message}`);
    console.error('Error stack:', error.stack);

    // Return detailed error response
    res.status(500).json({
      error: 'Failed to download media',
      success: false,
      details: error.message,
      platform: identifyPlatform(url),
      timestamp: new Date().toISOString()
    });
  }
};

// ===== ROUTES =====

const express = require('express');
const router = express.Router();
const mockController = require('../Controllers/mockController');

// POST route to download media
router.post('/download', downloadMedia);

// GET route to fetch mock data
router.get('/mock-videos', mockController.getMockVideos);

// Test endpoint
router.get('/test', (req, res) => {
  res.status(200).json({
    message: 'Download API is working',
    timestamp: new Date().toISOString(),
    supportedPlatforms: SUPPORTED_PLATFORMS
  });
});

// ===== EXPORTS =====

module.exports = {
  downloadMedia,
  router
};