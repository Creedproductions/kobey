const { alldown } = require('shaon-media-downloader'); 
const { ttdl, twitter } = require('btch-downloader');
const { igdl } = require('btch-downloader');
// const { facebook } = require('@mrnima/facebook-downloader');
const { ytdown } = require("nayan-videos-downloader");
const { ndown } = require("nayan-videos-downloader");
const { twitterdown } = require("nayan-videos-downloader");
// const {pintarest} = require("nayan-videos-downloader");

const { pinterest } = require('ironman-api');
const { threads } = require('shaon-media-downloader'); 
const { BitlyClient } = require('bitly');
const tinyurl = require('tinyurl'); 
const config = require('../Config/config'); 
const axios = require('axios'); 

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
  if (url.includes('threads.net')) return 'threads';
  console.warn("Platform Identification: Unable to identify the platform.");
  return null;
};

// Standardize the response for different platforms
const formatData = async (platform, data) => {
  console.info(`Data Formatting: Formatting data for platform '${platform}'.`);
  const placeholderThumbnail = 'https://via.placeholder.com/300x150';

  switch (platform) {
    case 'youtube': {
      const youtubeData = data.data;
      if (!youtubeData || !youtubeData.video) {
        throw new Error("Data Formatting: YouTube video data is incomplete or improperly formatted.");
      }
      console.info("Data Formatting: YouTube data formatted successfully.");
      return {
        title: youtubeData.title || 'Untitled Video',
        url: youtubeData.video_hd || '',
        thumbnail: youtubeData.thumb || placeholderThumbnail,
        sizes: ['Low Quality', 'High Quality'],
        source: platform,
      };
    }

    case 'instagram': {
      if (!data || !data[0]?.url) {
        console.error("Data Formatting: Instagram data is missing or invalid.");
        throw new Error("Instagram data is missing or invalid.");
      }
      console.info("Data Formatting: Instagram data formatted successfully.");
      return {
        title: data[0]?.wm || 'Untitled Media',
        url: data[0]?.url,
        thumbnail: data[0]?.thumbnail || placeholderThumbnail,
        sizes: ['Original Quality'],
        source: platform,
      };
    }

    case 'twitter': {
      const twitterData = data.data;
      if (!twitterData || !twitterData.HD || !twitterData.SD) {
        throw new Error("Data Formatting: Twitter video data is incomplete or improperly formatted.");
      }
      console.info("Data Formatting: Twitter data formatted successfully.");
      return {
        title: 'Untitled Video',  // No title provided in the given data
        url: twitterData.HD || twitterData.SD || '',  // HD first, fall back to SD
        thumbnail: twitterData.thumbnail || placeholderThumbnail,
        sizes: twitterData.HD ? ['HD'] : ['SD'],
        source: platform,
      };
    }
    
    
    

    case 'facebook':
  console.log("Processing Facebook data...");

  // Extract 720p or fallback to 360p
  let fbUrl = '';
  const fbData = data.data || [];

  const hdVideo = fbData.find(video => video.resolution.includes('720p'));
  const sdVideo = fbData.find(video => video.resolution.includes('360p'));

  if (hdVideo) {
    fbUrl = hdVideo.url;
  } else if (sdVideo) {
    fbUrl = sdVideo.url;
  }

  return {
    title: data.title || 'Untitled Video',
    url: fbUrl || '',
    thumbnail: (hdVideo?.thumbnail || sdVideo?.thumbnail || placeholderThumbnail),
    sizes: [hdVideo ? '720p' : '360p'],
    source: platform,
  };

    case 'pinterest': {
      console.info("Data Formatting: Pinterest data formatted successfully.");
      return {
        title: data.imran?.title || 'Untitled Image',
        url: data.imran?.url || '',
        thumbnail: data.imran?.url || placeholderThumbnail,
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
        title: data.title || 'Untitled Post',
        url: data.data?.video || '',
        thumbnail: data.thumbnail || placeholderThumbnail,
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

  if (!url) {
    console.warn("Download Media: No URL provided in the request.");
    return res.status(400).json({ error: 'No URL provided' });
  }

  const platform = identifyPlatform(url);

  if (!platform) {
    console.warn("Download Media: Unsupported platform for the given URL.");
    return res.status(400).json({ error: 'Unsupported platform' });
  }

  try {
    console.info(`Download Media: Fetching data for platform '${platform}'.`);
    let data;

    switch (platform) {
      case 'instagram':
        data = await igdl(url);
        break;
      case 'tiktok':
        data = await ttdl(url);
        break;
      case 'facebook':
        data = await ndown(url);
        break;
      case 'twitter':
        data = await twitterdown(url);
        break;
      case 'youtube':
        data = await ytdown(url);
        break;
      case 'pinterest':
        data = await pinterest(url);
        break;
      case 'threads':
        data = await threads(url);
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

    // 200 OK: Successful response
    res.status(200).json({
      success: true,
      data: formattedData,
    });
  } catch (error) {
    console.error(`Download Media: Error occurred - ${error.message}`);
    res.status(500).json({ error: 'Failed to download media' });
  }
};
