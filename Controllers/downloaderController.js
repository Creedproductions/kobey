// ===== DEPENDENCIES =====
const { ttdl, twitter } = require('btch-downloader');
const { igdl } = require('btch-downloader');
const { pinterest } = require('ironman-api');
const { BitlyClient } = require('bitly');
const axios = require('axios');
const { ytdl, pindl } = require('jer-api');
const fetch = require('node-fetch');
const config = require('../Config/config');
const { advancedThreadsDownloader } = require('../Services/advancedThreadsService');
const fetchLinkedinData = require('../Services/linkedinService');
const facebookInsta = require('../Services/facebookInstaService');
const { downloadTwmateData } = require('../Services/twitterService');
const { fetchYouTubeData } = require('../Services/youtubeService');

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

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Normalize a raw media item from any platform into a uniform shape.
// Returns: { url, thumbnail, type ('video'|'image'), quality, index }
// ─────────────────────────────────────────────────────────────────────────────
const normalizeMediaItem = (item, index, fallbackThumbnail = PLACEHOLDER_THUMBNAIL) => {
  const url = item.url || item.download || item.src || '';
  const thumbnail = item.thumbnail || item.cover || item.image || fallbackThumbnail;

  // Determine media type
  let type = item.type || '';
  if (!type) {
    const lower = url.toLowerCase();
    if (lower.match(/\.(mp4|mov|webm|mkv|avi|ts)(\?|$)/)) type = 'video';
    else if (lower.match(/\.(jpg|jpeg|png|gif|webp|heic)(\?|$)/)) type = 'image';
    else type = 'video'; // default assumption
  }

  return {
    url,
    thumbnail,
    type,
    quality: item.quality || item.resolution || 'Original Quality',
    index,
  };
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
    if (!data || (!data.video && !data.images)) {
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

  // ========================================
  // YOUTUBE - UPDATED FOR AUDIO MERGING
  // ========================================
  async youtube(url, req) {
    console.log('YouTube: Processing URL:', url);

    try {
      const timeout = url.includes('/shorts/') ? 30000 : 60000;
      const data = await downloadWithTimeout(() => fetchYouTubeData(url), timeout);

      if (!data || !data.title) {
        throw new Error('YouTube service returned invalid data');
      }

      console.log('YouTube: Successfully fetched data, formats count:', data.formats?.length || 0);

      if (data.formats) {
        const serverBaseUrl = getServerBaseUrl(req);
        data.formats.forEach(format => {
          if (format.url && format.url.startsWith('MERGE:')) {
            const parts = format.url.split(':');
            if (parts.length >= 3) {
              const videoUrl = parts[1];
              const audioUrl = parts[2];
              format.url = `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(videoUrl)}&audioUrl=${encodeURIComponent(audioUrl)}`;
              console.log(`🔄 Converted merge URL for: ${format.quality}`);
            }
          }
        });

        if (data.url && data.url.startsWith('MERGE:')) {
          const parts = data.url.split(':');
          if (parts.length >= 3) {
            const videoUrl = parts[1];
            const audioUrl = parts[2];
            data.url = `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(videoUrl)}&audioUrl=${encodeURIComponent(audioUrl)}`;
          }
        }
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

  // ─────────────────────────────────────────────────────────────────────────
  // INSTAGRAM
  // Handles: single video, single image, carousel (multiple videos/images)
  // btch-downloader igdl returns:
  //   • Array of { url, thumbnail, quality } for carousels
  //   • Object { media: [{url, type, quality}], title, thumbnail } from fallback
  // ─────────────────────────────────────────────────────────────────────────
  instagram(data) {
    console.log('📸 Instagram: Formatting data, type=', Array.isArray(data) ? 'array' : typeof data);

    // ── Case 1: igdl returns a plain array (most common for carousels) ──
    if (Array.isArray(data)) {
      console.log(`📸 Instagram: ${data.length} item(s) found`);

      const mediaItems = data
        .filter(item => item && item.url)
        .map((item, index) => normalizeMediaItem(item, index, item.thumbnail || PLACEHOLDER_THUMBNAIL));

      if (mediaItems.length === 0) {
        throw new Error('Instagram returned an empty media array');
      }

      const first = mediaItems[0];
      return {
        title: data[0]?.title || 'Instagram Post',
        url: first.url,
        thumbnail: first.thumbnail,
        sizes: ['Original Quality'],
        source: 'instagram',
        // Only attach mediaItems when there are genuinely multiple items
        ...(mediaItems.length > 1 && { mediaItems }),
      };
    }

    // ── Case 2: fallback / snapsave returns { media: [], title, thumbnail } ──
    if (data.media && Array.isArray(data.media)) {
      console.log(`📸 Instagram (media array): ${data.media.length} item(s) found`);

      const mediaItems = data.media
        .filter(item => item && item.url)
        .map((item, index) =>
          normalizeMediaItem(item, index, data.thumbnail || PLACEHOLDER_THUMBNAIL)
        );

      if (mediaItems.length === 0) {
        throw new Error('Instagram media array contained no valid URLs');
      }

      const first = mediaItems[0];
      return {
        title: data.title || 'Instagram Post',
        url: first.url,
        thumbnail: data.thumbnail || first.thumbnail,
        sizes: ['Original Quality'],
        source: 'instagram',
        ...(mediaItems.length > 1 && { mediaItems }),
      };
    }

    // ── Case 3: single media object ──
    console.log('📸 Instagram: Single item (object)');
    return {
      title: data.title || 'Instagram Post',
      url: data.url || '',
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: ['Original Quality'],
      source: 'instagram',
    };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // TIKTOK
  // Handles: single video, image/photo slideshow (data.images array)
  // btch-downloader ttdl returns:
  //   { title, video: [url], audio: [url], thumbnail, images?: [url] }
  // ─────────────────────────────────────────────────────────────────────────
  tiktok(data) {
    console.log('🎵 TikTok: Formatting data');

    // ── Image slideshow post ──
    if (data.images && Array.isArray(data.images) && data.images.length > 0) {
      console.log(`🎵 TikTok: Image slideshow with ${data.images.length} image(s)`);

      const mediaItems = data.images
        .filter(imgUrl => imgUrl && typeof imgUrl === 'string')
        .map((imgUrl, index) => ({
          url: imgUrl,
          thumbnail: imgUrl,
          type: 'image',
          quality: 'Original Quality',
          index,
        }));

      const first = mediaItems[0];
      return {
        title: data.title || 'TikTok Post',
        url: first?.url || '',
        thumbnail: data.thumbnail || first?.url || PLACEHOLDER_THUMBNAIL,
        sizes: ['Original Quality'],
        audio: data.audio?.[0] || '',
        source: 'tiktok',
        isImageSlideshow: true,
        ...(mediaItems.length > 1 && { mediaItems }),
      };
    }

    // ── Standard video post ──
    console.log('🎵 TikTok: Standard video post');
    return {
      title: data.title || 'Untitled Video',
      url: data.video?.[0] || '',
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: ['Original Quality'],
      audio: data.audio?.[0] || '',
      source: 'tiktok',
    };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // FACEBOOK
  // Handles: single video, albums / multiple media
  // facebookInsta (snapsave) returns:
  //   { media: [{url, type, quality, thumbnail}], title, thumbnail }
  //   OR  { data: [{url, resolution, thumbnail}], title }
  // ─────────────────────────────────────────────────────────────────────────
  facebook(data) {
    console.log('📘 Facebook: Formatting data');

    // ── Case 1: snapsave-style { media: [] } ──
    if (data && data.media && Array.isArray(data.media)) {
      console.log(`📘 Facebook (media array): ${data.media.length} item(s)`);

      const mediaItems = data.media
        .filter(item => item && item.url)
        .map((item, index) =>
          normalizeMediaItem(item, index, data.thumbnail || PLACEHOLDER_THUMBNAIL)
        );

      if (mediaItems.length === 0) {
        throw new Error('Facebook media array contained no valid URLs');
      }

      const first = mediaItems[0];
      return {
        title: data.title || 'Facebook Post',
        url: first.url,
        thumbnail: data.thumbnail || first.thumbnail,
        sizes: ['Original Quality'],
        source: 'facebook',
        ...(mediaItems.length > 1 && { mediaItems }),
      };
    }

    // ── Case 2: { data: [{url, resolution}] } (older format) ──
    const fbData = data.data || [];
    if (Array.isArray(fbData) && fbData.length > 0) {
      console.log(`📘 Facebook (data array): ${fbData.length} quality variant(s)`);

      // These are quality variants of the same video, not separate media items
      const hdVideo = fbData.find(v => v.resolution?.includes('720p') || v.resolution?.includes('hd'));
      const sdVideo = fbData.find(v => v.resolution?.includes('360p') || v.resolution?.includes('sd'));
      const selectedVideo = hdVideo || sdVideo || fbData[0];

      return {
        title: data.title || 'Facebook Video',
        url: selectedVideo?.url || '',
        thumbnail: selectedVideo?.thumbnail || PLACEHOLDER_THUMBNAIL,
        sizes: fbData.map(v => v.resolution || 'Unknown'),
        source: 'facebook',
      };
    }

    // ── Fallback ──
    return {
      title: data.title || 'Facebook Video',
      url: data.url || '',
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: ['Original Quality'],
      source: 'facebook',
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

  // ========================================
  // YOUTUBE FORMATTER - FIXED TO PASS QUALITY DATA
  // ========================================
  youtube(data, req) {
    console.log('🎬 Formatting YouTube data...');

    if (!data || !data.title) {
      throw new Error('Invalid YouTube data received');
    }

    const hasFormats = data.formats && data.formats.length > 0;
    const hasAllFormats = data.allFormats && data.allFormats.length > 0;

    console.log(`📊 YouTube data: hasFormats=${hasFormats}, hasAllFormats=${hasAllFormats}`);

    let qualityOptions = [];
    let selectedQuality = null;
    let defaultUrl = data.url;

    if (hasFormats || hasAllFormats) {
      qualityOptions = data.formats || data.allFormats;

      selectedQuality = qualityOptions.find(opt =>
        opt.quality && opt.quality.includes('360p')
      ) || qualityOptions[0];

      defaultUrl = selectedQuality?.url || data.url;

      console.log(`✅ YouTube: ${qualityOptions.length} quality options available`);
      console.log(`🎯 Selected quality: ${selectedQuality?.quality}`);

      const serverBaseUrl = getServerBaseUrl(req);
      qualityOptions.forEach(format => {
        if (format.url && format.url.startsWith('MERGE:')) {
          const parts = format.url.split(':');
          if (parts.length >= 3) {
            const videoUrl = parts[1];
            const audioUrl = parts[2];
            format.url = `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(videoUrl)}&audioUrl=${encodeURIComponent(audioUrl)}`;
            console.log(`🔄 Formatter: Converted merge URL for: ${format.quality}`);
          }
        }
      });

      if (selectedQuality && selectedQuality.url && selectedQuality.url.startsWith('MERGE:')) {
        const parts = selectedQuality.url.split(':');
        if (parts.length >= 3) {
          const videoUrl = parts[1];
          const audioUrl = parts[2];
          selectedQuality.url = `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(videoUrl)}&audioUrl=${encodeURIComponent(audioUrl)}`;
          defaultUrl = selectedQuality.url;
        }
      }
    } else {
      console.log('⚠️ No quality formats found, creating fallback');
      qualityOptions = [
        {
          quality: '360p',
          qualityNum: 360,
          url: data.url,
          type: 'video/mp4',
          extension: 'mp4',
          isPremium: false,
          hasAudio: true
        }
      ];
      selectedQuality = qualityOptions[0];
    }

    const result = {
      title: data.title,
      url: defaultUrl,
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: qualityOptions.map(f => f.quality),
      duration: data.duration || 'unknown',
      source: 'youtube',
      formats: qualityOptions,
      allFormats: qualityOptions,
      selectedQuality: selectedQuality
    };

    console.log(`✅ YouTube formatting complete`);
    console.log(`📦 Sending to client: ${qualityOptions.length} formats`);

    return result;
  },

  // ─────────────────────────────────────────────────────────────────────────
  // THREADS
  // Handles: single video/image, multi-media posts (carousels in threads)
  // advancedThreadsDownloader may return:
  //   { download, title, thumbnail, quality } — single
  //   { items: [{download, thumbnail, type}], title, thumbnail } — multiple
  // ─────────────────────────────────────────────────────────────────────────
  threads(data) {
    console.log("🧵 Processing Threads data, keys:", Object.keys(data || {}));

    // ── Multiple media items ──
    if (data.items && Array.isArray(data.items) && data.items.length > 0) {
      console.log(`🧵 Threads: ${data.items.length} item(s) found`);

      const mediaItems = data.items
        .filter(item => item && (item.download || item.url))
        .map((item, index) => ({
          url: item.download || item.url || '',
          thumbnail: item.thumbnail || data.thumbnail || PLACEHOLDER_THUMBNAIL,
          type: item.type || 'video',
          quality: item.quality || 'Best Available',
          index,
        }));

      const first = mediaItems[0];
      return {
        title: data.title || 'Threads Post',
        url: first?.url || '',
        thumbnail: data.thumbnail || first?.thumbnail || PLACEHOLDER_THUMBNAIL,
        sizes: ['Best Available'],
        source: 'threads',
        metadata: data.metadata || {},
        ...(mediaItems.length > 1 && { mediaItems }),
      };
    }

    // ── Single item ──
    return {
      title: data.title || 'Threads Post',
      url: data.download || '',
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: [data.quality || 'Best Available'],
      source: 'threads',
      metadata: data.metadata || {}
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
    console.warn("Data Formatting: Generic formatting applied.");
    return {
      title: data.title || 'Untitled Media',
      url: data.url || '',
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: data.sizes?.length > 0 ? data.sizes : ['Original Quality'],
      source: platform,
    };
  }

  if (platform === 'youtube') {
    return formatter(data, req);
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

    const data = platform === 'youtube'
      ? await downloader(processedUrl, req)
      : await downloader(processedUrl);

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
      formattedData = await formatData(platform, data, req);
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

    const hasMultiple = formattedData.mediaItems && formattedData.mediaItems.length > 1;
    console.log(`Final ${platform} URL length:`, formattedData.url.length);
    console.log(`Media items: ${formattedData.mediaItems?.length || 1}`);
    if (platform === 'youtube') {
      console.log(`Formats count: ${formattedData.formats?.length || 0}`);
      const mergeFormats = formattedData.formats?.filter(f => f.url?.includes('/api/merge-audio')) || [];
      console.log(`🎵 Merge formats available: ${mergeFormats.length}`);
    }

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
        hasMultipleItems: hasMultiple,
        mediaItemsCount: formattedData.mediaItems?.length || 1,
        hasFormats: !!formattedData.formats,
        formatsCount: formattedData.formats?.length || 0,
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