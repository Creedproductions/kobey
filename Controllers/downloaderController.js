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
const DOWNLOAD_TIMEOUT = 45000;

// ===== UTILITY FUNCTIONS =====

/**
 * URL shortening function using multiple services
 * @param {string} url - URL to shorten
 * @returns {string} - Shortened URL or original if shortening fails
 */
const shortenUrl = async (url) => {
  if (!url || url.length < 200) {
    return url; // Don't shorten already short URLs
  }

  try {
    // Try TinyURL first (more reliable, no API key needed)
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
    // Fallback to is.gd
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

  // If both fail, try Bitly if token exists
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
  return url; // Return original if all shortening fails
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

  // Handle YouTube Shorts - PRESERVE YOUR EXISTING LOGIC
  const shortsRegex = /youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/;
  const shortsMatch = cleanUrl.match(shortsRegex);
  if (shortsMatch) {
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

// ===== ADVANCED THREADS HANDLER =====

/**
 * Advanced Threads downloader with multiple extraction methods
 */
const advancedThreadsDownloader = async (url) => {
  console.log('Advanced Threads: Starting comprehensive download for URL:', url);

  // Method 1: Original service
  try {
    const data = await downloadWithTimeout(() => threadsDownloader(url), 30000);
    console.log('Advanced Threads: Original service succeeded');
    return data;
  } catch (error) {
    console.warn('Advanced Threads: Original service failed:', error.message);
  }

  // Method 2: Direct HTML parsing with multiple approaches
  try {
    let cleanUrl = url.replace('threads.com', 'threads.net').split('#')[0].split('?')[0];
    console.log('Advanced Threads: Trying direct parsing for:', cleanUrl);

    const response = await axios.get(cleanUrl, {
      timeout: 25000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'no-cache'
      }
    });

    const html = response.data;
    console.log('Advanced Threads: HTML fetched, length:', html.length);

    // Multiple video extraction patterns
    const extractionMethods = [
      // Method A: Direct video URLs
      {
        name: 'Direct MP4',
        regex: /https:\/\/[^"']*\.mp4[^"']*/gi,
        process: (matches) => matches ? matches[0] : null
      },

      // Method B: JSON embedded video URLs
      {
        name: 'JSON video_url',
        regex: /"video_url"\s*:\s*"([^"]+)"/gi,
        process: (matches) => matches ? matches[0].replace(/"video_url"\s*:\s*"/, '').replace(/"/g, '') : null
      },

      // Method C: Playback URLs
      {
        name: 'JSON playback_url',
        regex: /"playback_url"\s*:\s*"([^"]+)"/gi,
        process: (matches) => matches ? matches[0].replace(/"playback_url"\s*:\s*"/, '').replace(/"/g, '') : null
      },

      // Method D: Meta video tags
      {
        name: 'Meta video',
        regex: /<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/gi,
        process: (matches) => matches ? matches[0].match(/content=["']([^"']+)["']/)?.[1] : null
      },

      // Method E: Script tag video data
      {
        name: 'Script video data',
        regex: /"video":\s*{\s*"uri"\s*:\s*"([^"]+)"/gi,
        process: (matches) => matches ? matches[0].match(/"uri"\s*:\s*"([^"]+)"/)?.[1] : null
      }
    ];

    for (const method of extractionMethods) {
      console.log(`Advanced Threads: Trying extraction method: ${method.name}`);
      const matches = html.match(method.regex);

      if (matches && matches.length > 0) {
        for (const match of matches) {
          const videoUrl = method.process([match]);

          if (videoUrl && videoUrl.startsWith('http') && videoUrl.includes('.mp4')) {
            console.log(`Advanced Threads: Found video URL using ${method.name}:`, videoUrl.substring(0, 100));

            // Validate the video URL
            try {
              const headResponse = await axios.head(videoUrl, { timeout: 10000 });
              if (headResponse.status === 200) {
                return {
                  title: 'Threads Post',
                  download: videoUrl,
                  thumbnail: extractThumbnail(html) || PLACEHOLDER_THUMBNAIL,
                  quality: 'Best'
                };
              }
            } catch (validationError) {
              console.log(`Advanced Threads: URL validation failed for ${method.name}:`, validationError.message);
              continue;
            }
          }
        }
      }
    }
  } catch (parseError) {
    console.error('Advanced Threads: Direct parsing failed:', parseError.message);
  }

  // Method 3: Try with mobile user agent
  try {
    const mobileUrl = url.replace('threads.com', 'threads.net');
    const mobileResponse = await axios.get(mobileUrl, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36'
      }
    });

    const videoMatch = mobileResponse.data.match(/video_url['":\s]+([^'">\s]+\.mp4[^'">\s]*)/i);
    if (videoMatch && videoMatch[1]) {
      console.log('Advanced Threads: Mobile extraction succeeded');
      return {
        title: 'Threads Post',
        download: videoMatch[1],
        thumbnail: extractThumbnail(mobileResponse.data) || PLACEHOLDER_THUMBNAIL,
        quality: 'Best'
      };
    }
  } catch (mobileError) {
    console.error('Advanced Threads: Mobile extraction failed:', mobileError.message);
  }

  throw new Error('Threads download failed: Unable to extract video content. The post may contain only images/text, be private, or use an unsupported video format.');
};

/**
 * Extract thumbnail from HTML
 */
const extractThumbnail = (html) => {
  const thumbnailPatterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /"image":\s*"([^"]+)"/i
  ];

  for (const pattern of thumbnailPatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
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

      if (!fallbackData || (!Array.isArray(fallbackData) && !fallbackData.data)) {
        throw new Error('Twitter download failed - both primary and fallback methods failed');
      }
      return fallbackData;
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
    const data = await downloadWithTimeout(() => pindl(url));
    if (!data || (!data.result && !data.url)) {
      throw new Error('Pinterest service returned invalid data');
    }
    return data;
  },

  async threads(url) {
    return await advancedThreadsDownloader(url);
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
  async youtube(data) {
    console.log('YouTube Formatter: Processing data with formats:', data.formats?.length || 0);

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

    console.log('YouTube Formatter: Best video format:', bestVideo?.quality || 'none');
    console.log('YouTube Formatter: Video URL length:', bestVideo?.url?.length || 0);

    // Apply URL shortening for long YouTube URLs
    let finalVideoUrl = bestVideo?.url || '';
    let finalAudioUrl = bestAudio?.url || '';

    if (finalVideoUrl.length > 500) {
      console.log('YouTube Formatter: Shortening long video URL...');
      finalVideoUrl = await shortenUrl(finalVideoUrl);
    }

    if (finalAudioUrl.length > 500) {
      console.log('YouTube Formatter: Shortening long audio URL...');
      finalAudioUrl = await shortenUrl(finalAudioUrl);
    }

    return {
      title: data.title || 'Untitled Video',
      url: finalVideoUrl,
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: [...videoWithAudio, ...videoOnly].map(f => f.quality).filter(Boolean),
      audio: finalAudioUrl,
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

  threads(data) {
    return {
      title: data.title || 'Threads Post',
      url: data.download,
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: [data.quality || 'Unknown'],
      source: 'threads',
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
    console.log(`URL shortened: ${formattedData.url.length < 200 ? 'No' : 'Yes'}`);
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
        finalUrlLength: formattedData.url ? formattedData.url.length : 0,
        urlShortened: formattedData.url && formattedData.url.length < 200
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
    suggestions.push('Some Threads videos may use formats not yet supported');
    suggestions.push('Try using a different Threads video post');
  }

  if (platform === 'youtube') {
    if (errorMessage.includes('timeout')) {
      suggestions.push('YouTube videos may take longer to process - the API is working but needs time');
      suggestions.push('Check your frontend code to ensure it waits for the full response');
      suggestions.push('Consider implementing a loading indicator for user feedback');
    }
  }

  if (errorMessage.includes('not available') || errorMessage.includes('410')) {
    suggestions.push('The content may have been removed or made private');
    suggestions.push('Try checking if the content is still accessible in a browser');
  }

  return suggestions;
};

module.exports = {
  downloadMedia
};