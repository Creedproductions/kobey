const {alldown} = require("shaon-media-downloader") // For YouTube video downloads
const { igdl, ttdl, twitter } = require('btch-downloader');
const { facebook } = require('@mrnima/facebook-downloader');
const { pinterestdl } = require('imran-servar');
const { threads } = require('shaon-media-downloader'); // Updated Threads downloader
const { BitlyClient } = require('bitly');
const tinyurl = require('tinyurl'); // TinyURL package
const config = require('../Config/config'); // Import the config file

// Initialize Bitly client with your access token from config
const bitly = new BitlyClient(config.BITLY_ACCESS_TOKEN);

// Function to shorten URL with fallback
const shortenUrl = async (url) => {
  if (!url) {
    console.error("Invalid or missing URL, skipping shortening:", url);
    return url;
  }

  try {
    console.log("Attempting to shorten URL with Bitly:", url);
    const response = await bitly.shorten(url);
    console.log("Bitly shortened URL:", response.link);
    return response.link; // Return shortened URL if successful
  } catch (error) {
    console.error("Bitly shortening failed:", error.message);
    try {
      console.log("Attempting to shorten URL with TinyURL:", url);
      const tinyResponse = await tinyurl.shorten(url);
      console.log("TinyURL shortened URL:", tinyResponse);
      return tinyResponse; // Return shortened URL from TinyURL
    } catch (error) {
      console.error("TinyURL shortening failed:", error.message);
      return url; // Fallback to the original URL if all shortening attempts fail
    }
  }
};

// Function to identify platform
const identifyPlatform = (url) => {
  console.log("Identifying platform for URL:", url);
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
  if (url.includes('x.com') || url.includes('twitter.com')) return 'twitter';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('pinterest.com') || url.includes('pin.it')) return 'pinterest';
  if (url.includes('threads.net')) return 'threads';
  return null;
};

// Standardize the response for different platforms
const formatData = async (platform, data) => {
  const placeholderThumbnail = 'https://via.placeholder.com/300x150';

  console.log(`Formatting data for platform: ${platform}`);

  switch (platform) {
    case 'youtube':
      console.log("Processing YouTube data...");
      const youtubeData = data.data;
      if (!youtubeData || (!youtubeData.low && !youtubeData.high)) {
        throw new Error("YouTube data is incomplete or improperly formatted");
      }

      return {
        title: youtubeData.title || 'Untitled Video',
        url: youtubeData.low || youtubeData.high || '',
        thumbnail: youtubeData.thumbnail || placeholderThumbnail,
        sizes: ['Low Quality', 'High Quality'],
        source: platform,
      };

    case 'threads':
      console.log("Processing Threads data...");
      const threadsData = data.data;
      return {
        title: threadsData?.title || 'Untitled Post',
        url: threadsData?.video || '',
        thumbnail: placeholderThumbnail, // Threads typically don't have thumbnails
        sizes: ['Original Quality'],
        source: platform,
      };

    case 'pinterest':
      console.log("Processing Pinterest data...");
      return {
        title: data.imran?.title || 'Untitled Image',
        url: data.imran?.url || '',
        thumbnail: data.imran?.url || placeholderThumbnail,
        sizes: ['Original Quality'],
        source: platform,
      };

    default:
      console.log("Processing generic data...");
      return {
        title: data.title || 'Untitled Media',
        url: data.url || '',
        thumbnail: data.thumbnail || placeholderThumbnail,
        sizes: data.sizes?.length > 0 ? data.sizes : ['Original Quality'],
        source: platform,
      };
  }
};

exports.downloadMedia = async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'No URL provided' });
  }

  const platform = identifyPlatform(url);

  if (!platform) {
    return res.status(400).json({ error: 'Unsupported platform' });
  }

  try {
    console.log(`Identified platform: ${platform} for URL: ${url}`);
    let data;

    // Fetch data based on the identified platform
    switch (platform) {
      case 'instagram':
        console.log("Fetching Instagram data...");
        data = await igdl(url);
        break;
      case 'tiktok':
        console.log("Fetching TikTok data...");
        data = await ttdl(url);
        break;
      case 'facebook':
        console.log("Fetching Facebook data...");
        data = await facebook(url);
        break;
      case 'twitter':
        console.log("Fetching Twitter data...");
        data = await twitter(url);
        break;
      case 'youtube':
        console.log("Fetching YouTube data...");
        try {
          data = await alldown(url);
          console.log("YouTube data fetched successfully:", data);
        } catch (error) {
          console.error("Error fetching YouTube data:", error);
          return res.status(500).json({ error: 'Failed to fetch YouTube data' });
        }
        break;
      case 'pinterest':
        console.log("Fetching Pinterest data...");
        data = await pinterestdl(url);
        break;
      case 'threads':
        console.log("Fetching Threads data...");
        try {
          data = await threads(url);
          console.log("Threads data fetched successfully:", data);
        } catch (error) {
          console.error("Error fetching Threads data:", error.message);
          return res.status(500).json({ error: 'Failed to fetch Threads data' });
        }
        break;
      default:
        return res.status(500).json({ error: 'Platform identification failed' });
    }

    // Check if data was successfully fetched
    if (!data) {
      console.error("No data returned for platform:", platform);
      return res.status(500).json({ error: 'Failed to fetch data for the platform' });
    }

    // Format the data
    let formattedData;
    try {
      formattedData = await formatData(platform, data);
    } catch (error) {
      console.error("Error formatting data:", error.message);
      return res.status(500).json({ error: error.message });
    }

    // Shorten URLs for all platforms except Threads
    if (platform !== 'threads') {
      formattedData.url = await shortenUrl(formattedData.url);
      formattedData.thumbnail = await shortenUrl(formattedData.thumbnail);
    }

    // Send the response
    res.json({
      success: true,
      data: formattedData,
    });
  } catch (error) {
    console.error('Error downloading media:', error);
    res.status(500).json({ error: 'Failed to download media' });
  }
};
