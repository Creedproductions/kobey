const { ttdl, twitter } = require('btch-downloader');
const { igdl } = require('btch-downloader');
// const { facebook } = require('@mrnima/facebook-downloader');
// const {pintarest} = require("nayan-videos-downloader");

const { pinterest } = require('ironman-api');
const { BitlyClient } = require('bitly');
const tinyurl = require('tinyurl');
const config = require('../Config/config');
const axios = require('axios');
const { ytdl, pindl } = require('jer-api');
const threadsDownloader = require('../Services/threadsService');
const fetchLinkedinData = require('../Services/linkedinService');
const facebookInsta = require('../Services/facebookInstaService');
const { downloadTwmateData } = require('../Services/twitterService');
const { fetchYouTubeData } = require('../Services/youtubeService');

const bitly = new BitlyClient(config.BITLY_ACCESS_TOKEN);

// Function to shorten URL with fallback
const shortenUrl = async (url) => {
  if (!url) {
    console.warn("Shorten URL: No URL provided.");
    return url;
  }

  try {
    console.info("Shorten URL: Attempting to shorten with Bitly.");
    const response = await bitly.shorten(url);
    console.info("Shorten URL: Successfully shortened with Bitly.");
    return response.link;
  } catch (error) {
    console.warn("Shorten URL: Bitly failed, falling back to TinyURL.");
    try {
      const tinyResponse = await tinyurl.shorten(url);
      console.info("Shorten URL: Successfully shortened with TinyURL.");
      return tinyResponse;
    } catch (fallbackError) {
      console.error("Shorten URL: Both shortening methods failed.");
      return url;
    }
  }
};

// Function to identify platform
const identifyPlatform = (url) => {
  console.info("Platform Identification: Determining the platform for the given URL.");
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
  if (url.includes('x.com') || url.includes('twitter.com')) return 'twitter';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('pinterest.com') || url.includes('pin.it')) return 'pinterest';
  if (url.includes('threads.net') || url.includes('threads.com')) return 'threads';
  if (url.includes('linkedin.com')) return 'linkedin';
  console.warn("Platform Identification: Unable to identify the platform.");
  return null;
};

// Function to normalize YouTube URLs (convert shorts to regular format)
function normalizeYouTubeUrl(url) {
  const shortsRegex = /youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/;
  const match = url.match(shortsRegex);
  if (match) {
    return `https://www.youtube.com/watch?v=${match[1]}`;
  }
  return url;
}

// Standardize the response for different platforms
const formatData = async (platform, data) => {
  console.info(`Data Formatting: Formatting data for platform '${platform}'.`);
  const placeholderThumbnail = 'https://via.placeholder.com/300x150';

  switch (platform) {
    case 'youtube': {
      if (!data || !data.title) {
        throw new Error("Data Formatting: YouTube data is incomplete or improperly formatted.");
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
        thumbnail: data.thumbnail || placeholderThumbnail,
        sizes: [...videoWithAudio, ...videoOnly].map(f => f.quality).filter(Boolean),
        audio: bestAudio?.url || '',
        duration: data.duration || 'Unknown',
        source: platform,
      };
    }

    case 'instagram': {
      if (data && data.media && Array.isArray(data.media)) {
        const mediaItem = data.media[0];
        return {
          title: data.title || 'Instagram Media',
          url: mediaItem?.url || '',
          thumbnail: data.thumbnail || placeholderThumbnail,
          sizes: ['Original Quality'],
          source: platform,
        };
      }

      if (!data || !data[0]?.url) {
        console.error("Data Formatting: Instagram data is missing or invalid.");
        throw new Error("Instagram data is missing or invalid.");
      }
      console.info("Data Formatting: Instagram data formatted successfully.");
      return {
        title: data[0]?.wm || 'Instagram Media',
        url: data[0]?.url,
        thumbnail: data[0]?.thumbnail || placeholderThumbnail,
        sizes: ['Original Quality'],
        source: platform,
      };
    }

    case 'twitter': {
      console.log('DEBUG FORMATTING: Twitter data received in formatting:', JSON.stringify(data, null, 2));
      console.log('DEBUG FORMATTING: Data type:', typeof data);
      console.log('DEBUG FORMATTING: Is array:', Array.isArray(data));
      console.log('DEBUG FORMATTING: Has data property:', !!data.data);
      console.log('DEBUG FORMATTING: Data.data is array:', Array.isArray(data.data));

      if (data.data && (data.data.HD || data.data.SD)) {
        const twitterData = data.data;
        console.info("Data Formatting: Twitter data (btch-downloader) formatted successfully.");
        return {
          title: 'Twitter Video',
          url: twitterData.HD || twitterData.SD || '',
          thumbnail: twitterData.thumbnail || placeholderThumbnail,
          sizes: twitterData.HD ? ['HD'] : ['SD'],
          source: platform,
        };
      }
      else if (data.data && Array.isArray(data.data) && data.data.length > 0) {
        const videoArray = data.data;
        const bestQuality = videoArray.find(item => item.quality.includes('1280x720')) ||
                           videoArray.find(item => item.quality.includes('640x360')) ||
                           videoArray[0];
        console.info("Data Formatting: Twitter data (custom service with data wrapper) formatted successfully.");
        return {
          title: 'Twitter Video',
          url: bestQuality.url || '',
          thumbnail: placeholderThumbnail,
          sizes: videoArray.map(item => item.quality),
          source: platform,
        };
      }
      else if (Array.isArray(data) && data.length > 0) {
        const bestQuality = data.find(item => item.quality.includes('1280x720')) ||
                           data.find(item => item.quality.includes('640x360')) ||
                           data[0];
        console.info("Data Formatting: Twitter data (custom service direct array) formatted successfully.");
        return {
          title: 'Twitter Video',
          url: bestQuality.url || '',
          thumbnail: placeholderThumbnail,
          sizes: data.map(item => item.quality),
          source: platform,
        };
      }
      else {
        console.error('DEBUG FORMATTING: No conditions matched, data structure not recognized');
        throw new Error("Data Formatting: Twitter video data is incomplete or improperly formatted.");
      }
    }

    case 'facebook':
      console.log("Processing Facebook data...");

      if (data && data.media && Array.isArray(data.media)) {
        const videoMedia = data.media.find(item => item.type === 'video') || data.media[0];
        return {
          title: data.title || 'Facebook Video',
          url: videoMedia?.url || '',
          thumbnail: data.thumbnail || placeholderThumbnail,
          sizes: [videoMedia?.quality || 'Original Quality'],
          source: platform,
        };
      }

      let fbUrl = '';
      const fbData = data.data || [];
      const hdVideo = fbData.find(video => video.resolution?.includes('720p'));
      const sdVideo = fbData.find(video => video.resolution?.includes('360p'));

      if (hdVideo) {
        fbUrl = hdVideo.url;
      } else if (sdVideo) {
        fbUrl = sdVideo.url;
      }

      return {
        title: data.title || 'Facebook Video',
        url: fbUrl || '',
        thumbnail: (hdVideo?.thumbnail || sdVideo?.thumbnail || placeholderThumbnail),
        sizes: [hdVideo ? '720p' : '360p'],
        source: platform,
      };

    case 'pinterest': {
      let pinterestData = data?.data || data;
      return {
        title: 'Pinterest Image',
        url: pinterestData.result || pinterestData.url || '',
        thumbnail: pinterestData.result || pinterestData.url || placeholderThumbnail,
        sizes: ['Original Quality'],
        source: platform,
      };
    }

    case 'tiktok':
      console.log("Processing TikTok data...");
      return {
        title: data.title || 'Untitled Video',
        url: data.video?.[0] || '',
        thumbnail: data.thumbnail || placeholderThumbnail,
        sizes: ['Original Quality'],
        audio: data.audio?.[0] || '',
        source: platform,
      };

    case 'threads':
      console.log("Processing Threads data...");
      return {
        title: 'Threads Post',
        url: data.download,
        thumbnail: data.thumbnail,
        sizes: [data.quality || 'Unknown'],
        source: platform,
      };

    case 'linkedin':
      console.log("Processing LinkedIn data...");
      const videoUrl = Array.isArray(data?.data?.videos) && data.data.videos.length > 0 ? data.data.videos[0] : '';
      return {
        title: 'LinkedIn Video',
        url: videoUrl,
        thumbnail: videoUrl ? 'https://via.placeholder.com/300x150' : 'Error',
        sizes: ['Original Quality'],
        source: platform,
      };

    default:
      console.warn("Data Formatting: Generic formatting applied.");
      return {
        title: data.title || 'Untitled Media',
        url: data.url || '',
        thumbnail: data.thumbnail || placeholderThumbnail,
        sizes: data.sizes?.length > 0 ? data.sizes : ['Original Quality'],
        source: platform,
      };
  }
};

// Main function to handle media download
exports.downloadMedia = async (req, res) => {
  const { url } = req.body;
  console.log("Received URL:", url);

  // Enhanced request validation
  if (!url) {
    console.warn("Download Media: No URL provided in the request.");
    return res.status(400).json({
      error: 'No URL provided',
      success: false
    });
  }

  // Validate URL format
  if (typeof url !== 'string' || url.trim().length === 0) {
    console.warn("Download Media: Invalid URL format.");
    return res.status(400).json({
      error: 'Invalid URL format',
      success: false
    });
  }

  const platform = identifyPlatform(url);

  if (!platform) {
    console.warn("Download Media: Unsupported platform for the given URL.");
    return res.status(400).json({
      error: 'Unsupported platform',
      success: false,
      supportedPlatforms: ['instagram', 'tiktok', 'facebook', 'twitter', 'youtube', 'pinterest', 'threads', 'linkedin']
    });
  }

  // Normalize YouTube Shorts URLs
  let processedUrl = url;
  if (platform === 'youtube') {
    processedUrl = normalizeYouTubeUrl(url);
  }

  try {
    console.info(`Download Media: Fetching data for platform '${platform}'.`);
    let data;

    // Add timeout wrapper for all download operations
    const downloadWithTimeout = async (downloadFunction) => {
      return Promise.race([
        downloadFunction(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Download timeout - operation took too long')), 30000)
        )
      ]);
    };

    switch (platform) {
      case 'instagram':
        try {
          data = await downloadWithTimeout(() => igdl(url));
          if (!data || (Array.isArray(data) && data.length === 0)) {
            throw new Error('Instagram primary service returned empty data');
          }
        } catch (error) {
          console.warn('Instagram primary downloader failed, trying fallback...', error.message);
          try {
            data = await downloadWithTimeout(() => facebookInsta(url));
            if (!data || !data.media) {
              throw new Error('Instagram fallback service returned empty data');
            }
          } catch (fallbackError) {
            console.error('Instagram fallback also failed:', fallbackError.message);
            throw new Error('Instagram download failed - both primary and fallback methods failed');
          }
        }
        break;

      case 'tiktok':
        try {
          data = await downloadWithTimeout(() => ttdl(url));
          if (!data || !data.video) {
            throw new Error('TikTok service returned invalid data');
          }
        } catch (error) {
          console.error('TikTok download failed:', error.message);
          throw new Error('TikTok download failed - service unavailable');
        }
        break;

      case 'facebook':
        try {
          data = await downloadWithTimeout(() => facebookInsta(url));
          if (!data || (!data.media && !data.data)) {
            throw new Error('Facebook service returned invalid data');
          }
        } catch (error) {
          console.error('Facebook download failed:', error.message);
          throw new Error('Facebook download failed - service unavailable');
        }
        break;

      case 'twitter':
        try {
          data = await downloadWithTimeout(() => twitter(url));

          // Validate Twitter data
          const hasValidData = data.data && (data.data.HD || data.data.SD);
          const hasValidUrls = Array.isArray(data.url) && data.url.some(item =>
            item && Object.keys(item).length > 0 && item.url
          );

          if (!hasValidData && !hasValidUrls) {
            throw new Error("Twitter primary service returned unusable data");
          }
        } catch (error) {
          console.warn("Twitter: Primary service failed, trying custom service...", error.message);
          try {
            data = await downloadWithTimeout(() => downloadTwmateData(url));
            console.log('Twitter custom service returned:', JSON.stringify(data, null, 2));
            if (!data || (!Array.isArray(data) && !data.data)) {
              throw new Error('Twitter custom service returned invalid data');
            }
          } catch (fallbackError) {
            console.error('Twitter fallback also failed:', fallbackError.message);
            throw new Error('Twitter download failed - both primary and fallback methods failed');
          }
        }
        break;

      case 'youtube':
        try {
          data = await downloadWithTimeout(() => fetchYouTubeData(url));
          if (!data || !data.title || !data.formats) {
            throw new Error('YouTube service returned invalid data');
          }
        } catch (error) {
          console.error('YouTube download failed:', error.message);
          throw new Error('YouTube download failed - service unavailable');
        }
        break;

      case 'pinterest':
        try {
          data = await downloadWithTimeout(() => pindl(url));
          if (!data || (!data.result && !data.url)) {
            throw new Error('Pinterest service returned invalid data');
          }
        } catch (error) {
          console.error('Pinterest download failed:', error.message);
          throw new Error('Pinterest download failed - service unavailable');
        }
        break;

      case 'threads':
        try {
          data = await downloadWithTimeout(() => threadsDownloader(url));
          if (!data || !data.download) {
            throw new Error('Threads service returned invalid data');
          }
        } catch (error) {
          console.error('Threads download failed:', error.message);
          throw new Error('Threads download failed - service unavailable');
        }
        break;

      case 'linkedin':
        try {
          data = await downloadWithTimeout(() => fetchLinkedinData(url));
          if (!data || !data.data || !data.data.videos) {
            throw new Error('LinkedIn service returned invalid data');
          }
        } catch (error) {
          console.error('LinkedIn download failed:', error.message);
          throw new Error('LinkedIn download failed - service unavailable');
        }
        break;

      default:
        console.error("Download Media: Platform identification failed unexpectedly.");
        return res.status(500).json({
          error: 'Platform identification failed',
          success: false
        });
    }

    // Validate returned data
    if (!data) {
      console.error("Download Media: No data returned for the platform.");
      return res.status(404).json({
        error: 'No data found for this URL',
        success: false,
        platform: platform
      });
    }

    // Format data with enhanced error handling
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

    // Shorten URLs for all platforms except Threads
    if (platform !== 'threads') {
      try {
        if (formattedData.url) {
          formattedData.url = await shortenUrl(formattedData.url);
        }
        if (formattedData.thumbnail) {
          formattedData.thumbnail = await shortenUrl(formattedData.thumbnail);
        }
      } catch (shortenError) {
        console.warn('URL shortening failed, using original URLs:', shortenError.message);
        // Continue with original URLs - this is not a critical failure
      }
    }

    console.info("Download Media: Media successfully downloaded and formatted.");

    res.status(200).json({
      success: true,
      data: formattedData,
      platform: platform,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error(`Download Media: Error occurred - ${error.message}`);
    console.error('Error stack:', error.stack);

    // Return detailed error response
    res.status(500).json({
      error: 'Failed to download media',
      success: false,
      details: error.message,
      platform: platform,
      timestamp: new Date().toISOString()
    });
  }
};