const { ttdl, twitter } = require('btch-downloader');
const { igdl } = require('btch-downloader');
const { pinterest } = require('ironman-api');
const { BitlyClient } = require('bitly');
const axios = require('axios');
const { pindl } = require('jer-api');

const config = require('../Config/config');
const { advancedThreadsDownloader } = require('../Services/advancedThreadsService');
const fetchLinkedinData = require('../Services/linkedinService');
const facebookInsta = require('../Services/facebookInstaService');
const { downloadTwmateData } = require('../Services/twitterService');
const youtubeService = require('../Services/youtubeService'); // Fixed import
const { universalDownload } = require('../Services/universalDownloaderService');

const bitly = new BitlyClient(config.BITLY_ACCESS_TOKEN);

// Constants
const SUPPORTED_PLATFORMS = [
  'instagram', 'tiktok', 'facebook', 'twitter',
  'youtube', 'pinterest', 'threads', 'linkedin',
  'reddit', 'vimeo', 'dailymotion', 'streamable',
  'douyin', 'twitch', 'pornhub', 'xvideos',
  'likee', 'kwai', 'snapchat', '9gag', 'imgur', 'tumblr', 'universal'
];

const PLACEHOLDER_THUMBNAIL = 'https://via.placeholder.com/300x150';
const DOWNLOAD_TIMEOUT = 45000;
const YOUTUBE_TIMEOUT = 60000;

/**
 * Timeout wrapper for download functions
 */
const downloadWithTimeout = (downloadFunction, timeout = DOWNLOAD_TIMEOUT) => {
  return Promise.race([
    downloadFunction(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Download timeout - operation took too long')), timeout)
    )
  ]);
};

/**
 * Identify platform from URL
 */
const identifyPlatform = (url) => {
  const platformMap = {
    'instagram.com': 'instagram',
    'tiktok.com': 'tiktok',
    'facebook.com': 'facebook',
    'fb.watch': 'facebook',
    'm.facebook.com': 'facebook',
    'x.com': 'twitter',
    'twitter.com': 'twitter',
    'youtube.com': 'youtube',
    'youtu.be': 'youtube',
    'm.youtube.com': 'youtube',
    'pinterest.com': 'pinterest',
    'pin.it': 'pinterest',
    'threads.net': 'threads',
    'threads.com': 'threads',
    'linkedin.com': 'linkedin',
    'reddit.com': 'reddit',
    'redd.it': 'reddit',
    'vimeo.com': 'vimeo',
    'dailymotion.com': 'dailymotion',
    'streamable.com': 'streamable',
    'douyin.com': 'douyin',
    'twitch.tv': 'twitch',
    'pornhub.com': 'universal',
    'xvideos.com': 'universal',
    'likee.video': 'universal',
    'kwai.com': 'universal',
    '9gag.com': 'universal',
    'imgur.com': 'universal',
    'tumblr.com': 'universal',
    'snapchat.com': 'universal'
  };

  const urlLower = url.toLowerCase();
  for (const [domain, platform] of Object.entries(platformMap)) {
    if (urlLower.includes(domain)) {
      return platform;
    }
  }

  return 'universal';
};

/**
 * Normalize YouTube URL to standard format
 */
const normalizeYouTubeUrl = (url) => {
  // Remove fragments and query parameters except 'v'
  let cleanUrl = url.split('#')[0];
  
  // Handle shorts
  const shortsRegex = /youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/;
  const shortsMatch = cleanUrl.match(shortsRegex);
  if (shortsMatch) {
    return `https://www.youtube.com/watch?v=${shortsMatch[1]}`;
  }
  
  // Handle youtu.be
  const shortRegex = /youtu\.be\/([a-zA-Z0-9_-]+)/;
  const shortMatch = cleanUrl.match(shortRegex);
  if (shortMatch) {
    return `https://www.youtube.com/watch?v=${shortMatch[1]}`;
  }
  
  // Handle m.youtube.com
  if (cleanUrl.includes('m.youtube.com')) {
    cleanUrl = cleanUrl.replace('m.youtube.com', 'www.youtube.com');
  }
  
  // Extract video ID from standard URL
  const standardRegex = /[?&]v=([a-zA-Z0-9_-]+)/;
  const standardMatch = cleanUrl.match(standardRegex);
  if (standardMatch) {
    return `https://www.youtube.com/watch?v=${standardMatch[1]}`;
  }
  
  return cleanUrl;
};

/**
 * Validate URL format
 */
const validateUrl = (url) => {
  if (!url || typeof url !== 'string' || url.trim().length === 0) {
    return { isValid: false, error: 'Invalid URL format' };
  }
  
  const trimmedUrl = url.trim();
  
  try {
    new URL(trimmedUrl);
    return { isValid: true, cleanedUrl: trimmedUrl };
  } catch (e) {
    return { isValid: false, error: 'Invalid URL format' };
  }
};

/**
 * Platform-specific downloaders
 */
const platformDownloaders = {
  async instagram(url) {
    try {
      const data = await downloadWithTimeout(() => igdl(url));
      if (!data || (Array.isArray(data) && data.length === 0)) {
        throw new Error('Instagram primary service returned empty data');
      }
      return data;
    } catch (error) {
      console.log('⚠️ Instagram primary failed, trying fallback...');
      const fallbackData = await downloadWithTimeout(() => facebookInsta(url));
      if (!fallbackData || !fallbackData.media) {
        throw new Error('Instagram download failed with all methods');
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
    if (!data) {
      throw new Error('Facebook service returned no data');
    }
    
    // Check for valid media data
    const hasMedia = data.media && Array.isArray(data.media) && data.media.length > 0;
    const hasData = data.data && Array.isArray(data.data) && data.data.length > 0;
    
    if (!hasMedia && !hasData) {
      throw new Error('Facebook service returned invalid data structure');
    }
    
    return data;
  },

  async twitter(url) {
    try {
      const data = await downloadWithTimeout(() => twitter(url));
      const hasValidData = data.data && (data.data.HD || data.data.SD);
      const hasValidUrls = Array.isArray(data.url) && data.url.some(item => item && item.url);
      
      if (!hasValidData && !hasValidUrls) {
        throw new Error("Twitter primary service returned unusable data");
      }
      return data;
    } catch (error) {
      console.log('⚠️ Twitter primary failed, trying fallback...');
      const fallbackData = await downloadWithTimeout(() => downloadTwmateData(url));
      if (!fallbackData || (!Array.isArray(fallbackData) && !fallbackData.data)) {
        throw new Error('Twitter download failed with all methods');
      }
      return fallbackData;
    }
  },

  async youtube(url) {
    console.log('🎬 YouTube: Processing URL:', url);
    try {
      const data = await downloadWithTimeout(
        () => youtubeService.fetchYouTubeData(url),
        YOUTUBE_TIMEOUT
      );
      
      if (!data || !data.url) {
        throw new Error('YouTube service returned invalid data');
      }
      
      console.log(`✅ YouTube: Success with ${data.formats?.length || 0} formats`);
      return data;
    } catch (error) {
      console.error('❌ YouTube download failed:', error.message);
      throw new Error(`YouTube download failed: ${error.message}`);
    }
  },

  async pinterest(url) {
    try {
      const data = await downloadWithTimeout(() => pindl(url));
      if (!data || (!data.data && !data.result && !data.url)) {
        throw new Error('Pinterest primary service returned invalid data');
      }
      return data;
    } catch (error) {
      console.log('⚠️ Pinterest primary failed, trying fallback...');
      const fallbackData = await downloadWithTimeout(() => pinterest(url));
      if (!fallbackData || (!fallbackData.data && !fallbackData.result)) {
        throw new Error('Pinterest download failed with all methods');
      }
      return fallbackData;
    }
  },

  async threads(url) {
    const data = await downloadWithTimeout(() => advancedThreadsDownloader(url), 60000);
    if (!data || !data.download) {
      throw new Error('Threads service returned invalid data');
    }
    return data;
  },

  async linkedin(url) {
    const data = await downloadWithTimeout(() => fetchLinkedinData(url));
    if (!data || !data.data) {
      throw new Error('LinkedIn service returned invalid data');
    }
    return data;
  },

  async reddit(url) {
    return await universalDownload(url);
  },

  async vimeo(url) {
    return await universalDownload(url);
  },

  async dailymotion(url) {
    return await universalDownload(url);
  },

  async streamable(url) {
    return await universalDownload(url);
  },

  async douyin(url) {
    return await universalDownload(url);
  },

  async twitch(url) {
    return await universalDownload(url);
  },

  async universal(url) {
    return await universalDownload(url);
  }
};

/**
 * Data formatters for each platform
 */
const dataFormatters = {
  instagram(data) {
    if (data.media && Array.isArray(data.media)) {
      const videoMedia = data.media.find(item => item.type === 'video') || data.media[0];
      return {
        title: data.title || 'Instagram Post',
        url: videoMedia?.url || '',
        thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
        sizes: [videoMedia?.quality || 'Original Quality'],
        source: 'instagram',
      };
    }
    
    if (Array.isArray(data)) {
      const firstMedia = data[0];
      return {
        title: firstMedia?.title || 'Instagram Post',
        url: firstMedia?.url || '',
        thumbnail: firstMedia?.thumbnail || PLACEHOLDER_THUMBNAIL,
        sizes: [firstMedia?.quality || 'Original Quality'],
        source: 'instagram',
      };
    }
    
    return {
      title: data.title || 'Instagram Post',
      url: data.url || '',
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: ['Original Quality'],
      source: 'instagram',
    };
  },

  twitter(data) {
    if (data.data && (data.data.HD || data.data.SD)) {
      return {
        title: 'Twitter Video',
        url: data.data.HD || data.data.SD || '',
        thumbnail: PLACEHOLDER_THUMBNAIL,
        sizes: data.data.HD ? ['HD', 'SD'] : ['SD'],
        source: 'twitter',
      };
    }
    
    if (data.url && Array.isArray(data.url)) {
      const videoArray = data.url.filter(item => item && item.url);
      const bestQuality = videoArray.find(item => item.quality && item.quality.includes('1280x720')) ||
                         videoArray.find(item => item.quality && item.quality.includes('640x360')) ||
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
    const selectedVideo = hdVideo || sdVideo || fbData[0];
    
    if (!selectedVideo || !selectedVideo.url) {
      throw new Error('No valid Facebook video URL found');
    }
    
    return {
      title: data.title || 'Facebook Video',
      url: selectedVideo.url,
      thumbnail: selectedVideo.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: [selectedVideo.resolution || 'Unknown'],
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
    return {
      title: data.title || 'Untitled Video',
      url: data.video?.[0] || '',
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: ['Original Quality'],
      audio: data.audio?.[0] || '',
      source: 'tiktok',
    };
  },

  youtube(data) {
    console.log('📦 Formatting YouTube data...');
    if (!data || !data.title) {
      throw new Error('Invalid YouTube data received');
    }
    
    const qualityOptions = data.formats || data.allFormats || [];
    const selectedQuality = data.selectedQuality || qualityOptions[0];
    
    console.log(`✅ YouTube: ${qualityOptions.length} formats available`);
    
    return {
      title: data.title,
      url: data.url,
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: qualityOptions.map(f => f.quality),
      duration: data.duration || 'unknown',
      source: 'youtube',
      formats: qualityOptions,
      allFormats: qualityOptions,
      selectedQuality: selectedQuality
    };
  },

  threads(data) {
    return {
      title: data.title || 'Threads Post',
      url: data.download,
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: [data.quality || 'Best Available'],
      source: 'threads',
      metadata: data.metadata || {}
    };
  },

  linkedin(data) {
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
  },

  universal(data) {
    return {
      title: data.title || 'Video Download',
      url: data.url,
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: data.sizes || ['Original Quality'],
      source: data.source || 'universal'
    };
  },

  reddit(data) { return dataFormatters.universal(data); },
  vimeo(data) { return dataFormatters.universal(data); },
  dailymotion(data) { return dataFormatters.universal(data); },
  streamable(data) { return dataFormatters.universal(data); },
  douyin(data) { return dataFormatters.universal(data); },
  twitch(data) { return dataFormatters.universal(data); }
};

/**
 * Format data for specific platform
 */
const formatData = async (platform, data) => {
  console.info(`📋 Data Formatting: Formatting data for platform '${platform}'.`);
  
  const formatter = dataFormatters[platform];
  
  if (!formatter) {
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

/**
 * Main download media controller
 */
const downloadMedia = async (req, res) => {
  const { url } = req.body;
  console.log("📥 Received URL:", url);

  try {
    // Validate URL
    const urlValidation = validateUrl(url);
    if (!urlValidation.isValid) {
      return res.status(400).json({
        error: urlValidation.error,
        success: false
      });
    }

    const cleanedUrl = urlValidation.cleanedUrl;
    const platform = identifyPlatform(cleanedUrl);

    console.log(`🎯 Identified platform: ${platform}`);

    if (!platform) {
      return res.status(400).json({
        error: 'Unsupported platform',
        success: false,
        supportedPlatforms: SUPPORTED_PLATFORMS
      });
    }

    // Process URL (special handling for YouTube)
    let processedUrl = cleanedUrl;
    if (platform === 'youtube') {
      processedUrl = normalizeYouTubeUrl(cleanedUrl);
      console.log(`🔄 YouTube URL normalized: ${processedUrl}`);
    }

    console.info(`🚀 Download Media: Fetching data for platform '${platform}'.`);

    // Get downloader
    const downloader = platformDownloaders[platform];
    if (!downloader) {
      throw new Error(`No downloader available for platform: ${platform}`);
    }

    // Download data
    const data = await downloader(processedUrl);

    if (!data) {
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
      console.error(`❌ Data formatting failed: ${formatError.message}`);
      return res.status(500).json({
        error: 'Failed to format media data',
        success: false,
        details: formatError.message,
        platform: platform
      });
    }

    // Validate formatted data
    if (!formattedData || !formattedData.url) {
      return res.status(500).json({
        error: 'Invalid media data - no download URL found',
        success: false,
        platform: platform
      });
    }

    console.log(`✅ ${platform} download successful`);
    console.log(`📊 URL length: ${formattedData.url.length}`);
    console.log(`📊 Formats count: ${formattedData.formats?.length || 0}`);

    // Send response
    res.status(200).json({
      success: true,
      data: formattedData,
      platform: platform,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error(`❌ Download Media Error: ${error.message}`);

    // Determine status code
    let statusCode = 500;
    if (error.message.includes('not available') || error.message.includes('not found')) {
      statusCode = 404;
    } else if (error.message.includes('forbidden') || error.message.includes('access')) {
      statusCode = 403;
    } else if (error.message.includes('timeout')) {
      statusCode = 408;
    } else if (error.message.includes('410')) {
      statusCode = 410;
    }

    res.status(statusCode).json({
      error: 'Failed to download media',
      success: false,
      details: error.message,
      platform: identifyPlatform(url) || 'unknown',
      timestamp: new Date().toISOString()
    });
  }
};

module.exports = { downloadMedia };
