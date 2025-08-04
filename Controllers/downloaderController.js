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
  if (url.includes('threads.net') || url.includes('threads.com')) return 'threads'; // <-- add threads.com support
  if (url.includes('linkedin.com')) return 'linkedin'; // Add LinkedIn support
  console.warn("Platform Identification: Unable to identify the platform.");
  return null;
};

// Function to normalize YouTube URLs (convert shorts to regular format)
function normalizeYouTubeUrl(url) {
  // Convert shorts URLs to standard watch URLs
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
      const ytData = data.data;
      if (!ytData || !ytData.info) {
        throw new Error("Data Formatting: YouTube data is incomplete or improperly formatted.");
      }
      return {
        title: ytData.info.title || 'Untitled Video',
        url: ytData.mp4 || '',
        thumbnail: ytData.info.thumbnail || placeholderThumbnail,
        sizes: ['mp4', 'mp3'],
        audio: ytData.mp3 || '',
        source: platform,
      };
    }

    case 'instagram': {
      // Handle metadownloader response structure
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
      
      // Handle btch-downloader response structure
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
      // Handle btch-downloader format
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
      // Handle custom Twitter service format (array of results)
      else if (Array.isArray(data) && data.length > 0) {
        const bestQuality = data.find(item => item.quality.includes('720p')) || 
                           data.find(item => item.quality.includes('480p')) || 
                           data[0];
        console.info("Data Formatting: Twitter data (custom service) formatted successfully.");
        return {
          title: 'Twitter Video',
          url: bestQuality.url || '',
          thumbnail: placeholderThumbnail,
          sizes: [bestQuality.quality || 'Unknown'],
          source: platform,
        };
      }
      else {
        throw new Error("Data Formatting: Twitter video data is incomplete or improperly formatted.");
      }
    }
    
    case 'facebook':
      console.log("Processing Facebook data...");
      
      // Handle metadownloader response structure
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
      
      // Fallback to old format if needed
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
      // Support jer-api style response
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
      // Extract the first video URL from the LinkedIn API response
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
  console.log("Received URL:", url); // Add this line

  if (!url) {
    console.warn("Download Media: No URL provided in the request.");
    return res.status(400).json({ error: 'No URL provided' });
  }

  const platform = identifyPlatform(url);

  if (!platform) {
    console.warn("Download Media: Unsupported platform for the given URL.");
    return res.status(400).json({ error: 'Unsupported platform' });
  }

  // Normalize YouTube Shorts URLs
  let processedUrl = url;
  if (platform === 'youtube') {
    processedUrl = normalizeYouTubeUrl(url);
  }

  try {
    console.info(`Download Media: Fetching data for platform '${platform}'.`);
    let data;

    switch (platform) {
      case 'instagram':
        try {
          data = await igdl(url);
        } catch (error) {
          console.warn('Instagram primary downloader failed, trying fallback...');
          data = await facebookInsta(url); // Fallback to metadownloader
        }
        break;
      case 'tiktok':
        data = await ttdl(url);
        break;
      case 'facebook':
        data = await facebookInsta(url); // Use metadownloader for Facebook
        break;
      case 'twitter':
        try {
          data = await twitter(url); // Try btch-downloader first
        } catch (error) {
          console.warn("Twitter: btch-downloader failed, trying custom Twitter service...");
          data = await downloadTwmateData(url); // Fallback to custom service
        }
        break;
      case 'youtube':
        data = await ytdl(processedUrl);
        break;
      case 'pinterest':
        data = await pindl(url); 
        break;
      case 'threads':
        data = await threadsDownloader(url); // Use new service
        break;
      case 'linkedin':
        data = await fetchLinkedinData(url);
        break;
      default:
        console.error("Download Media: Platform identification failed unexpectedly.");
        return res.status(500).json({ error: 'Platform identification failed' });
    }

    if (!data) {
      console.error("Download Media: No data returned for the platform.");
      return res.status(404).json({ error: 'Data not found for the platform' });
    }

    const formattedData = await formatData(platform, data);

    // Shorten URLs for all platforms except Threads
    if (platform !== 'threads') {
      formattedData.url = await shortenUrl(formattedData.url);
      formattedData.thumbnail = await shortenUrl(formattedData.thumbnail);
    }

    console.info("Download Media: Media successfully downloaded and formatted.");

    res.status(200).json({
      success: true,
      data: formattedData,
    });
  } catch (error) {
    console.error(`Download Media: Error occurred - ${error.message}`);
    res.status(500).json({ error: 'Failed to download media' });
  }
};


