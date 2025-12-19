// ===== DEPENDENCIES =====
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

// ===== NEW YOUTUBE SERVICE =====
const { fetchYouTubeData } = require('../Services/youtubeServiceNew');

// ===== MERGE TOKEN STORE (SERVER-SIDE AUDIO FIX) =====
const mergeTokenStore = require('../Services/mergeTokenStore');

const bitly = new BitlyClient(config.BITLY_ACCESS_TOKEN);

// ===== CONSTANTS =====
const SUPPORTED_PLATFORMS = [
  'instagram', 'tiktok', 'facebook', 'twitter',
  'youtube', 'pinterest', 'threads', 'linkedin'
];

const PLACEHOLDER_THUMBNAIL = 'https://via.placeholder.com/300x150';
const DOWNLOAD_TIMEOUT = 45000;

// ===== UTILITY FUNCTIONS =====

const shortenUrl = async (url) => {
  if (!url || url.length < 200) return url;

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
      params: { format: 'simple', url },
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
    if (url.includes(domain)) return platform;
  }

  console.warn("Platform Identification: Unable to identify the platform.");
  return null;
};

const normalizeYouTubeUrl = (url) => {
  let cleanUrl = url.split('#')[0];

  const shortsRegex = /youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/;
  const shortsMatch = cleanUrl.match(shortsRegex);
  if (shortsMatch) return `https://www.youtube.com/shorts/${shortsMatch[1]}`;

  const shortRegex = /youtu\.be\/([a-zA-Z0-9_-]+)/;
  const shortMatch = cleanUrl.match(shortRegex);
  if (shortMatch) return `https://www.youtube.com/watch?v=${shortMatch[1]}`;

  return cleanUrl;
};

const validateUrl = (url) => {
  if (!url) return { isValid: false, error: 'No URL provided' };
  if (typeof url !== 'string' || url.trim().length === 0) return { isValid: false, error: 'Invalid URL format' };

  const cleanedUrl = url.trim();
  try { new URL(cleanedUrl); } catch (_) { return { isValid: false, error: 'Invalid URL format' }; }

  return { isValid: true, cleanedUrl };
};

const downloadWithTimeout = (downloadFunction, timeout = DOWNLOAD_TIMEOUT) => {
  return Promise.race([
    downloadFunction(),
    new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Download timeout - operation took too long')), timeout)
    )
  ]);
};

// Helper function to get server base URL
function getServerBaseUrl(req) {
  const host = req.get('host');
  const protocol = req.secure ? 'https' : 'http';
  return process.env.SERVER_BASE_URL || `${protocol}://${host}`;
}

/**
 * ✅ Core server-only audio fix:
 * For any format with needsMerging + videoUrl + audioUrl, replace its url with /api/merge/<token>.mp4
 */
function applyYouTubeMergeUrls(qualityOptions, req) {
  const base = getServerBaseUrl(req);

  return (qualityOptions || []).map((f) => {
    if (f && f.needsMerging && f.videoUrl && f.audioUrl) {
      const token = mergeTokenStore.create(f.videoUrl, f.audioUrl);
      return {
        ...f,
        url: `${base}/api/merge/${token}.mp4`,
        needsMerging: false,
        hasAudio: true
      };
    }
    return f;
  });
}

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
    if (!data || !data.video) throw new Error('TikTok service returned invalid data');
    return data;
  },

  async facebook(url) {
    const data = await downloadWithTimeout(() => facebookInsta(url));
    if (!data || (!data.media && !data.data)) throw new Error('Facebook service returned invalid data');
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

  async youtube(url, req) {
    console.log('🎬 YouTube: Processing URL:', url);

    try {
      const data = await fetchYouTubeData(url);

      if (!data || !data.title) {
        console.error('❌ YouTube service returned invalid data:', data);
        throw new Error('YouTube service returned invalid data');
      }

      console.log('✅ YouTube: Successfully fetched data');
      console.log(`📊 Total formats: ${data.formats?.length || 0}`);
      console.log(`📹 Video formats: ${data.videoFormats?.length || 0}`);
      console.log(`🎵 Audio formats: ${data.audioFormats?.length || 0}`);

      if (data.error) return data;

      if (!data.url && (data.formats?.length || 0) === 0) {
        return { ...data, error: data.error || "No downloadable formats available" };
      }

      return data;
    } catch (error) {
      console.error('❌ YouTube download error:', error.message);
      if (error.message.includes('Invalid YouTube URL')) throw new Error('Invalid YouTube URL format.');
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
    const data = await downloadWithTimeout(() => advancedThreadsDownloader(url), 60000);
    if (!data || !data.download) throw new Error('Threads service returned invalid data');
    return data;
  },

  async linkedin(url) {
    const data = await downloadWithTimeout(() => fetchLinkedinData(url));
    if (!data || !data.data) throw new Error('LinkedIn service returned invalid data');
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
      const bestQuality =
          videoArray.find(item => item.quality && item.quality.includes('1280x720')) ||
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
      const bestQuality =
          data.find(item => item.quality.includes('1280x720')) ||
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

  // ✅ UPDATED YOUTUBE FORMATTER (MERGE TOKEN URLS)
  youtube(data, req) {
    console.log('🎬 Formatting YouTube data...');

    if (!data || !data.title) {
      console.error('❌ Invalid YouTube data received:', data);
      throw new Error('Invalid YouTube data received');
    }

    if (data.error) {
      return {
        title: data.title || "YouTube Video",
        url: null,
        thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
        sizes: [],
        duration: data.duration || 'unknown',
        source: 'youtube',
        formats: [],
        allFormats: [],
        videoFormats: [],
        audioFormats: [],
        selectedQuality: null,
        error: data.error,
      };
    }

    let qualityOptions = Array.isArray(data.formats) ? data.formats : [];
    console.log(`📊 YouTube data: formatCount=${qualityOptions.length}`);

    // ✅ Convert merge-needed formats to server URLs
    qualityOptions = applyYouTubeMergeUrls(qualityOptions, req);

    // pick default 360p if exists, else first
    let selectedQuality =
        qualityOptions.find(opt => (opt.qualityNum === 360) || (String(opt.quality || '').includes('360'))) ||
        qualityOptions[0] ||
        null;

    // Ensure selectedQuality has a valid URL
    let defaultUrl = selectedQuality?.url || data.url || null;

    // If data.url exists but points to a merge-needed original, still prefer selectedQuality.url
    if (!defaultUrl && qualityOptions.length > 0) {
      defaultUrl = qualityOptions[0].url;
      selectedQuality = qualityOptions[0];
    }

    const result = {
      title: data.title || 'YouTube Video',
      url: defaultUrl,
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: qualityOptions.map(f => f.quality || `${f.qualityNum || 0}p`),
      duration: data.duration || 'unknown',
      source: 'youtube',
      formats: qualityOptions,
      allFormats: qualityOptions,
      videoFormats: qualityOptions,
      audioFormats: data.audioFormats || [],
      selectedQuality
    };

    console.log(`✅ YouTube formatting complete`);
    console.log(`📦 Sending to client: ${qualityOptions.length} formats`);
    console.log(`🔗 Default URL: ${defaultUrl ? 'present' : 'missing'}`);

    return result;
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
  }
};

const formatData = async (platform, data, req) => {
  console.info(`Data Formatting: Formatting data for platform '${platform}'.`);

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

  if (platform === 'youtube') return formatter(data, req);
  return formatter(data);
};

// ===== MAIN CONTROLLER =====

const downloadMedia = async (req, res) => {
  const { url } = req.body;
  console.log("📥 Received URL:", url);

  try {
    const urlValidation = validateUrl(url);
    if (!urlValidation.isValid) {
      return res.status(400).json({ error: urlValidation.error, success: false });
    }

    const cleanedUrl = urlValidation.cleanedUrl;
    const platform = identifyPlatform(cleanedUrl);

    if (!platform) {
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

    console.info(`🚀 Download Media: Fetching data for platform '${platform}'.`);

    const downloader = platformDownloaders[platform];
    if (!downloader) throw new Error(`No downloader available for platform: ${platform}`);

    const data = platform === 'youtube'
        ? await downloader(processedUrl, req)
        : await downloader(processedUrl);

    if (!data) {
      return res.status(404).json({ error: 'No data found for this URL', success: false, platform });
    }

    let formattedData;
    formattedData = await formatData(platform, data, req);
// If YouTube returned an error, return it cleanly (do NOT treat as server error)
    if (platform === 'youtube' && formattedData?.error) {
      return res.status(200).json({
        success: false,
        platform,
        data: formattedData,
        timestamp: new Date().toISOString()
      });
    }

    if (!formattedData || !formattedData.url) {
      return res.status(404).json({
        error: 'No downloadable URL found',
        success: false,
        platform: platform,
        data: formattedData || null
      });
    }


    console.log(`✅ Final ${platform} URL: ${formattedData.url ? 'present' : 'missing'}`);
    console.log(`📊 Formats count: ${formattedData.formats?.length || 0}`);
    console.log(`📹 Video formats: ${formattedData.videoFormats?.length || 0}`);
    console.log(`🎵 Audio formats: ${formattedData.audioFormats?.length || 0}`);

    res.status(200).json({
      success: true,
      data: formattedData,
      platform,
      timestamp: new Date().toISOString(),
      debug: {
        originalUrl: url,
        cleanedUrl,
        processedUrl,
        hasValidUrl: !!formattedData.url,
        formatsCount: formattedData.formats?.length || 0,
        videoFormatsCount: formattedData.videoFormats?.length || 0,
        audioFormatsCount: formattedData.audioFormats?.length || 0
      }
    });

  } catch (error) {
    console.error(`❌ Download Media: Error occurred - ${error.message}`);
    console.error('Error stack:', error.stack);

    let statusCode = 500;
    if (error.message.includes('not available') || error.message.includes('not found')) statusCode = 404;
    else if (error.message.includes('forbidden') || error.message.includes('access')) statusCode = 403;
    else if (error.message.includes('timeout')) statusCode = 408;

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
