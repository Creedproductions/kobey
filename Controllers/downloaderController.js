const { igdl, ttdl, twitter, youtube } = require('btch-downloader');
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
    const response = await bitly.shorten(url);
    return response.link; // Return shortened URL if successful
  } catch {
    try {
      // If Bitly fails, attempt shortening with TinyURL
      const tinyResponse = await tinyurl.shorten(url);
      return tinyResponse; // Return shortened URL from TinyURL
    } catch {
      // Fallback to the original URL if both services fail
      return url;
    }
  }
};

// Function to identify platform
const identifyPlatform = (url) => {
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

  switch (platform) {
    case 'youtube':
      // Check for available URLs and prioritize mp4 (video) or mp3 (audio) if available
      const videoUrl = data.mp4 || data.mp3 || data.url || '';
      return {
        title: data.title || 'Untitled Video',
        url: videoUrl,
        thumbnail: data.thumbnail || placeholderThumbnail,
        sizes: ['Original Quality'],
        source: platform,
      };
    case 'tiktok':
      return {
        title: data.title || 'Untitled Video',
        url: data.video?.[0] || '',
        thumbnail: data.thumbnail || placeholderThumbnail,
        sizes: ['Original Quality'],
        audio: data.audio?.[0] || '',
        source: platform,
      };
    case 'instagram':
      return {
        title: data[0]?.wm || 'Untitled Video',
        url: data[0]?.url || '',
        thumbnail: data[0]?.thumbnail || placeholderThumbnail,
        sizes: ['Original Quality'],
        source: platform,
      };
    case 'twitter':
      const videoUrlTwitter = data.url?.find((v) => v.hd)?.hd || '';
      return {
        title: data.title || 'Untitled Video',
        url: videoUrlTwitter,
        thumbnail: data.thumbnail || placeholderThumbnail,
        sizes: ['Original Quality'],
        source: platform,
      };
    case 'facebook':
      return {
        title: data.title || 'Untitled Video',
        url: data.result.links?.HD || data.result.links?.SD || '',
        thumbnail: data.result.thumbnail || placeholderThumbnail,
        sizes: ['Original Quality'],
        source: platform,
      };
    case 'pinterest':
      return {
        title: data.imran?.title || 'Untitled Image',
        url: data.imran?.url || '',
        thumbnail: data.imran?.url || placeholderThumbnail,
        sizes: ['Original Quality'],
        source: platform,
      };
    case 'threads':
      return {
        title: data.title || 'Untitled Post',
        url: data.data?.video || '',
        thumbnail: data.thumbnail || placeholderThumbnail,
        sizes: ['Original Quality'],
        source: platform,
      };
    case 'googleDrive':
      return {
        title: data.title || 'Untitled File',
        url: data.data || '',
        thumbnail: placeholderThumbnail,
        sizes: ['Original Quality'],
        source: platform,
      };
    default:
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
    let data;

    // Fetch data based on the identified platform
    switch (platform) {
      case 'instagram':
        data = await igdl(url);
        break;
      case 'tiktok':
        data = await ttdl(url);
        break;
      case 'facebook':
        data = await facebook(url);
        break;
      case 'twitter':
        data = await twitter(url);
        break;
      case 'youtube':
        data = await youtube(url);
        break;
      case 'pinterest':
        data = await pinterestdl(url);
        break;
      case 'threads':
        data = await threads(url);
        break;
      case 'googleDrive':
        data = await GDLink(url);
        break;
      default:
        return res.status(500).json({ error: 'Platform identification failed' });
    }

    // Format the data
    let formattedData = await formatData(platform, data);

    // Skip shortening for Threads platform, otherwise shorten the URL
    if (platform !== 'threads') {
      const shortenedUrl = await shortenUrl(formattedData.url);
      formattedData.url = shortenedUrl;

      // Shorten the thumbnail URL for all platforms except Google Drive
      if (platform !== 'googleDrive') {
        const shortenedThumbnail = await shortenUrl(formattedData.thumbnail);
        formattedData.thumbnail = shortenedThumbnail;
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
