const { alldl } = require('imran-dlmedia'); // For YouTube video downloads
const { igdl, ttdl, twitter } = require('btch-downloader');
const { facebook } = require('@mrnima/facebook-downloader');
const { pinterestdl } = require('imran-servar');
const { BitlyClient } = require('bitly');
const { threads, GDLink } = require("nayan-media-downloader");
const tinyurl = require('tinyurl'); // TinyURL package
const config = require('../Config/config'); // Import the config file

// Initialize Bitly client with your access token from config
const bitly = new BitlyClient(config.BITLY_ACCESS_TOKEN);

// Function to shorten URL with fallback
const shortenUrl = async (url) => {
  try {
    // Attempt shortening with Bitly
    console.log("Attempting to shorten URL with Bitly:", url);
    const response = await bitly.shorten(url);
    console.log("Bitly shortened URL:", response.link);
    return response.link; // Return shortened URL if successful
  } catch (error) {
    console.error("Bitly shortening failed:", error);
    try {
      // If Bitly fails, attempt shortening with TinyURL
      console.log("Attempting to shorten URL with TinyURL:", url);
      const tinyResponse = await tinyurl.shorten(url);
      console.log("TinyURL shortened URL:", tinyResponse);
      return tinyResponse; // Return shortened URL from TinyURL
    } catch (error) {
      console.error("TinyURL shortening failed:", error);
      // Fallback to the original URL if both services fail
      return url;
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
  if (url.includes('drive.google.com')) return 'googleDrive';
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
        throw new Error("YouTube data is incomplete or improperly formatte");
      }

      return {
        title: youtubeData.title || 'Untitled Video',
        url: youtubeData.low || youtubeData.high || '',
        thumbnail: youtubeData.thumbnail || placeholderThumbnail,
        sizes: ['Low Quality', 'High Quality'],
        source: platform,
      };

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
    case 'instagram':
      console.log("Processing Instagram data...");
      return {
        title: data[0]?.wm || 'Untitled Video',
        url: data[0]?.url || '',
        thumbnail: data[0]?.thumbnail || placeholderThumbnail,
        sizes: ['Original Quality'],
        source: platform,
      };
    case 'twitter':
      console.log("Processing Twitter data...");
      const videoUrlTwitter = data.url?.find((v) => v.hd)?.hd || '';
      console.log("Twitter video URL:", videoUrlTwitter);
      return {
        title: data.title || 'Untitled Video',
        url: videoUrlTwitter,
        thumbnail: data.thumbnail || placeholderThumbnail,
        sizes: ['Original Quality'],
        source: platform,
      };
    case 'facebook':
      console.log("Processing Facebook data...");
      return {
        title: data.title || 'Untitled Video',
        url: data.result.links?.HD || data.result.links?.SD || '',
        thumbnail: data.result.thumbnail || placeholderThumbnail,
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
    case 'threads':
      console.log("Processing Threads data...");
      return {
        title: data.title || 'Untitled Post',
        url: data.data?.video || '',
        thumbnail: data.thumbnail || placeholderThumbnail,
        sizes: ['Original Quality'],
        source: platform,
      };
    case 'googleDrive':
      console.log("Processing Google Drive data...");
      return {
        title: data.title || 'Untitled File',
        url: data.data || '',
        thumbnail: placeholderThumbnail,
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
          data = await alldl(url);
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
        data = await threads(url);
        break;
      case 'googleDrive':
        console.log("Fetching Google Drive data...");
        data = await GDLink(url);
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
    let formattedData = await formatData(platform, data);
    console.log("Formatted data:", formattedData);

    // Skip shortening for Threads platform, otherwise shorten the URL
    if (platform !== 'threads') {
      const shortenedUrl = await shortenUrl(formattedData.url);
      formattedData.url = shortenedUrl;
      console.log("Shortened URL:", formattedData.url);

      // Shorten the thumbnail URL for all platforms except Google Drive
      if (platform !== 'googleDrive') {
        const shortenedThumbnail = await shortenUrl(formattedData.thumbnail);
        formattedData.thumbnail = shortenedThumbnail;
        console.log("Shortened Thumbnail:", formattedData.thumbnail);
      }
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
