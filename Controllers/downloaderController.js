// ===== DEPENDENCIES =====
const { ttdl, twitter } = require('btch-downloader');
const { igdl } = require('btch-downloader');
const { pinterest } = require('ironman-api');
const { BitlyClient } = require('bitly');
const axios = require('axios');
const { ytdl, pindl } = require('jer-api');
const fetch = require('node-fetch'); // ADDED FOR TWITTER FIX

// Local services
const config = require('../Config/config');
const { advancedThreadsDownloader } = require('../Services/advancedThreadsService'); // NEW IMPORT
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
const DOWNLOAD_TIMEOUT = 45000;

// ===== UTILITY FUNCTIONS =====

/**
 * URL shortening function using multiple services
 */
const shortenUrl = async (url) => {
  if (!url || url.length < 200) {
    return url;
  }

  try {
    const tinyResponse = await axios.post('https://tinyurl.com/api-create.php', null, {
      params: { url },
      timeout: 5000
    });

    if (tinyResponse.data && tinyResponse.data.startsWith('https://tinyurl.com/')) {
      console.log('URL shortened with TinyURL');
      return tinyResponse.data;
    }
  } catch (error) {
    console.warn('TinyURL shortening failed:', error.message);
  }

  try {
    const isgdResponse = await axios.get('https://is.gd/create.php', {
      params: {
        format: 'simple',
        url: url
      },
      timeout: 5000
    });

    if (isgdResponse.data && isgdResponse.data.startsWith('https://is.gd/')) {
      console.log('URL shortened with is.gd');
      return isgdResponse.data;
    }
  } catch (error) {
    console.warn('is.gd shortening failed:', error.message);
  }

  if (config.BITLY_ACCESS_TOKEN) {
    try {
      const bitlyResponse = await bitly.shorten(url);
      if (bitlyResponse && bitlyResponse.link) {
        console.log('URL shortened with Bitly');
        return bitlyResponse.link;
      }
    } catch (error) {
      console.warn('Bitly shortening failed:', error.message);
    }
  }

  console.log('URL shortening failed, using original URL');
  return url;
};

/**
 * Identifies the platform based on URL
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
 * Normalizes YouTube URLs (preserves shorts functionality)
 */
const normalizeYouTubeUrl = (url) => {
  let cleanUrl = url.split('#')[0];

  const shortsRegex = /youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/;
  const shortsMatch = cleanUrl.match(shortsRegex);
  if (shortsMatch) {
    return `https://www.youtube.com/shorts/${shortsMatch[1]}`;
  }

  const shortRegex = /youtu\.be\/([a-zA-Z0-9_-]+)/;
  const shortMatch = cleanUrl.match(shortRegex);
  if (shortMatch) {
    return `https://www.youtube.com/watch?v=${shortMatch[1]}`;
  }

  return cleanUrl;
};

/**
 * Validates and cleans URL format
 */
const validateUrl = (url) => {
  if (!url) {
    return { isValid: false, error: 'No URL provided' };
  }

  if (typeof url !== 'string' || url.trim().length === 0) {
    return { isValid: false, error: 'Invalid URL format' };
  }

  const cleanedUrl = url.trim();

  try {
    new URL(cleanedUrl);
  } catch (e) {
    return { isValid: false, error: 'Invalid URL format' };
  }

  return { isValid: true, cleanedUrl };
};

/**
 * Enhanced timeout wrapper
 */
const downloadWithTimeout = (downloadFunction, timeout = DOWNLOAD_TIMEOUT) => {
  return Promise.race([
    downloadFunction(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Download timeout - operation took too long')), timeout)
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

  // ========================================
  // TWITTER/X - UPDATED WITH DIRECT EXTRACTION + FALLBACKS
  // ========================================
  async twitter(url) {
    console.log(`\n🐦 Processing Twitter URL: ${url}`);

    try {
      // METHOD 1: Direct HTML Extraction (Fastest & Most Reliable)
      console.log('📥 Fetching Twitter page content...');
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        }
      });

      if (response.ok) {
        const html = await response.text();
        console.log('🔍 Searching for video URLs in page...');

        // Multiple regex patterns to find video URLs
        const videoUrlPatterns = [
          /video_url":"([^"]+)"/,
          /playbackUrl":"([^"]+)"/,
          /video_info\"\:.*?\{\"bitrate\"\:.*?\"url\"\:\"([^\"]+)\"/,
          /"(?:https?:\/\/video\.twimg\.com\/[^"]+\.mp4[^"]*)"/g,
          /https?:\/\/video\.twimg\.com\/[^"'\s]+\.mp4[^"'\s]*/g
        ];

        const videoUrls = [];

        for (const pattern of videoUrlPatterns) {
          if (pattern.global) {
            const matches = html.match(pattern);
            if (matches && matches.length > 0) {
              matches.forEach(match => {
                const cleanUrl = match.replace(/"/g, '').replace(/&amp;/g, '&');
                if (!videoUrls.includes(cleanUrl)) {
                  videoUrls.push(cleanUrl);
                }
              });
            }
          } else {
            const match = pattern.exec(html);
            if (match && match[1]) {
              const cleanUrl = match[1]
                .replace(/\\u002F/g, '/')
                .replace(/\\\//g, '/')
                .replace(/\\/g, '')
                .replace(/&amp;/g, '&');
              if (!videoUrls.includes(cleanUrl)) {
                videoUrls.push(cleanUrl);
              }
            }
          }
        }

        // If video URLs found, return them
        if (videoUrls.length > 0) {
          console.log(`✅ Found ${videoUrls.length} video URL(s) via direct extraction`);
          
          const results = videoUrls.map((url, index) => {
            let quality = 'unknown';
            const qualityMatch = url.match(/(\d+x\d+)/);
            if (qualityMatch) {
              quality = qualityMatch[1];
            }
            
            return {
              quality: quality,
              type: 'video/mp4',
              url: url
            };
          });

          return results;
        }
      }

      // METHOD 2: btch-downloader (First Fallback)
      console.log('🔄 Direct extraction failed, trying btch-downloader...');
      try {
        const data = await downloadWithTimeout(() => twitter(url));
        const hasValidData = data.data && (data.data.HD || data.data.SD);
        const hasValidUrls = Array.isArray(data.url) &&
          data.url.some(item => item && Object.keys(item).length > 0 && item.url);

        if (hasValidData || hasValidUrls) {
          console.log('✅ Retrieved video via btch-downloader');
          return data;
        }
      } catch (btchError) {
        console.log(`⚠️ btch-downloader failed: ${btchError.message}`);
      }

      // METHOD 3: Custom Service (Last Fallback)
      console.log('🔄 Trying custom Twitter service (twitterService.js)...');
      const fallbackData = await downloadWithTimeout(() => downloadTwmateData(url));

      if (!fallbackData || (!Array.isArray(fallbackData) && !fallbackData.data)) {
        throw new Error('All Twitter download methods failed - video may be private, deleted, or region-locked');
      }

      console.log('✅ Retrieved video via custom service');
      return fallbackData;

    } catch (error) {
      console.error(`❌ Twitter download error: ${error.message}`);
      throw new Error(`Twitter download failed: ${error.message}`);
    }
  },

  async youtube(url) {
    console.log('YouTube: Processing URL:', url);

    try {
      const timeout = url.includes('/shorts/') ? 30000 : 60000;
      const data = await downloadWithTimeout(() => fetchYouTubeData(url), timeout);

      if (!data || !data.title || !data.formats) {
        throw new Error('YouTube service returned invalid data');
      }

      console.log('YouTube: Successfully fetched data, formats count:', data.formats?.length || 0);
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
  },

  async pinterest(url) {
    try {
      const data = await downloadWithTimeout(() => pindl(url));
      if (!data || (!data.data && !data.result && !data.url)) {
        throw new Error('Pinterest service returned invalid data');
      }
      return data;
    } catch (error) {
      console.warn('Pinterest primary downloader failed, trying fallback...', error.message);
      const fallbackData = await downloadWithTimeout(() => pinterest(url));
      if (!fallbackData || (!fallbackData.data && !fallbackData.result)) {
        throw new Error('Pinterest download failed - both primary and fallback methods failed');
      }
      return fallbackData;
    }
  },

  async threads(url) {
    console.log("🧵 Threads: Starting download with advanced service");
    try {
      const data = await downloadWithTimeout(() => advancedThreadsDownloader(url), 60000);

      if (!data || !data.download) {
        throw new Error('Threads service returned invalid data');
      }

      console.log("✅ Threads: Successfully downloaded video");
      return data;
    } catch (error) {
      console.error(`❌ Threads download failed: ${error.message}`);
      throw new Error(`Threads download failed: ${error.message}`);
    }
  },

  async linkedin(url) {
    const data = await downloadWithTimeout(() => fetchLinkedinData(url));
    if (!data || !data.data) {
      throw new Error('LinkedIn service returned invalid data');
    }
    return data;
  }
};

// ===== DATA FORMATTERS =====

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

  // ========================================
  // TWITTER/X - UPDATED DATA FORMATTER
  // ========================================
  twitter(data) {
    console.log('🐦 Formatting Twitter data...');

    // Handle direct extraction format (array of video objects)
    if (Array.isArray(data) && data.length > 0) {
      const bestQuality = data.find(item => item.quality && item.quality.includes('1280x720')) ||
                         data.find(item => item.quality && item.quality.includes('640x360')) ||
                         data[0];

      console.log(`✅ Twitter: Using ${bestQuality.quality || 'unknown'} quality`);

      return {
        title: 'Twitter Video',
        url: bestQuality.url || '',
        thumbnail: PLACEHOLDER_THUMBNAIL,
        sizes: data.map(item => item.quality),
        source: 'twitter',
      };
    }

    // Handle btch-downloader format
    if (data.data && (data.data.HD || data.data.SD)) {
      return {
        title: 'Twitter Video',
        url: data.data.HD || data.data.SD || '',
        thumbnail: PLACEHOLDER_THUMBNAIL,
        sizes: data.data.HD ? ['HD', 'SD'] : ['SD'],
        source: 'twitter',
      };
    }

    // Handle btch-downloader url array format
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

    console.error('❌ Twitter data format not recognized');
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
    return {
      title: data.title || 'Untitled Video',
      url: data.video?.[0] || '',
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: ['Original Quality'],
      audio: data.audio?.[0] || '',
      source: 'tiktok',
    };
  },

  // UPDATED THREADS FORMATTER - HANDLES ADVANCED RESPONSE
  threads(data) {
    console.log("Processing advanced Threads data...");
    return {
      title: data.title || 'Threads Post',
      url: data.download,
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: [data.quality || 'Best Available'],
      source: 'threads',
      metadata: data.metadata || {} // Include advanced metadata
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
  }
};

/**
 * Standardizes the response for different platforms
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

const downloadMedia = async (req, res) => {
  const { url } = req.body;
  console.log("Received URL:", url);

  try {
    const urlValidation = validateUrl(url);
    if (!urlValidation.isValid) {
      console.warn(`Download Media: ${urlValidation.error}`);
      return res.status(400).json({
        error: urlValidation.error,
        success: false
      });
    }

    const cleanedUrl = urlValidation.cleanedUrl;
    const platform = identifyPlatform(cleanedUrl);

    if (!platform) {
      console.warn("Download Media: Unsupported platform for the given URL.");
      return res.status(400).json({
        error: 'Unsupported platform',
        success: false,
        supportedPlatforms: SUPPORTED_PLATFORMS
      });
    }

    let processedUrl = cleanedUrl;
    if (platform === 'youtube') {
      processedUrl = normalizeYouTubeUrl(cleanedUrl);
      console.log(`YouTube URL processed: ${cleanedUrl} -> ${processedUrl}`);
    }

    console.info(`Download Media: Fetching data for platform '${platform}'.`);

    const downloader = platformDownloaders[platform];
    if (!downloader) {
      throw new Error(`No downloader available for platform: ${platform}`);
    }

    const data = await downloader(processedUrl);

    if (!data) {
      console.error("Download Media: No data returned for the platform.");
      return res.status(404).json({
        error: 'No data found for this URL',
        success: false,
        platform: platform
      });
    }

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

    if (!formattedData || !formattedData.url) {
      console.error("Download Media: Formatted data is invalid or missing URL.");
      return res.status(500).json({
        error: 'Invalid media data - no download URL found',
        success: false,
        platform: platform
      });
    }

    console.log(`Final ${platform} URL length:`, formattedData.url.length);
    console.info("Download Media: Media successfully downloaded and formatted.");

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
        finalUrlLength: formattedData.url ? formattedData.url.length : 0
      }
    });

  } catch (error) {
    console.error(`Download Media: Error occurred - ${error.message}`);
    console.error('Error stack:', error.stack);

    let statusCode = 500;
    if (error.message.includes('not available') || error.message.includes('not found')) {
      statusCode = 404;
    } else if (error.message.includes('forbidden') || error.message.includes('access')) {
      statusCode = 403;
    } else if (error.message.includes('timeout')) {
      statusCode = 408;
    }

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

const getErrorSuggestions = (errorMessage, platform) => {
  const suggestions = [];

  if (platform === 'threads') {
    suggestions.push('Ensure the Threads post contains video content (not just images or text)');
    suggestions.push('Check if the post is public and not deleted');
    suggestions.push('Try using a different Threads video post to test');
  }

  if (platform === 'youtube') {
    if (errorMessage.includes('timeout')) {
      suggestions.push('YouTube videos may take longer to process - the API is working but needs time');
      suggestions.push('Check your frontend code to ensure it waits for the full response');
    }
  }

  return suggestions;
};

module.exports = {
  downloadMedia
};
