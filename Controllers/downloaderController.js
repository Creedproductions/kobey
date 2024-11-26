const { igdl, ttdl, twitter, youtube } = require('btch-downloader');
const { facebook } = require('@mrnima/facebook-downloader');
const { pinterestdl } = require('imran-servar');
const { BitlyClient } = require('bitly');

const config = require('../Config/config');  // Import the config file

// Initialize Bitly client with your access token from config
const bitly = new BitlyClient(config.BITLY_ACCESS_TOKEN);

// Function to shorten URL
const shortenUrl = async (url) => {
  try {
    const response = await bitly.shorten(url);
    return response.link; // returns the shortened URL
  } catch (error) {
    console.error('Error shortening URL:', error);
    return url; // fallback to original URL if shortening fails
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
  
  return null;
};

// Standardizing the response for different platforms
const formatData = async (platform, data) => {
  // Handle YouTube-specific data
  if (platform === 'youtube') {
    return {
      title: data.title || 'Untitled Video',
      url: data.mp4 || data.mp3 || '',
      thumbnail: data.thumbnail || 'https://via.placeholder.com/300x150',
      sizes: ['Original Quality'],
      source: platform,
    };
  }

  // Standardize data for TikTok
  if (platform === 'tiktok') {
    return {
      title: data.title || 'Untitled Video',
      url: data.video && data.video[0] || '',
      thumbnail: data.thumbnail || 'https://via.placeholder.com/300x150',
      sizes: ['Original Quality'],
      audio: data.audio && data.audio[0] || '',
      source: platform,
    };
  }

  // Standardize data for Instagram
  if (platform === 'instagram') {
    const videoUrl = data[0].url || '';
    return {
      title: data[0].wm || 'Untitled Video',
      url: videoUrl || '',
      thumbnail: data[0].thumbnail || 'https://via.placeholder.com/300x150',
      sizes: ['Original Quality'],
      source: platform,
    };
  }

  // Standardize data for Twitter
  if (platform === 'twitter') {
    const videoUrl = data.url && data.url.find(v => v.hd) ? data.url.find(v => v.hd).hd : '';
    return {
      title: data.title || 'Untitled Video',
      url: videoUrl || '',
      thumbnail: data.thumbnail || 'https://via.placeholder.com/300x150',
      sizes: ['Original Quality'],
      source: platform,
    };
  }

  // Standardize data for Facebook
  if (platform === 'facebook') {
    return {
      title: data.title || 'Untitled Video',
      url: data.result.links.HD || data.result.links.SD || '',
      thumbnail: data.result.thumbnail || 'https://via.placeholder.com/300x150',
      sizes: ['Original Quality'],
      source: platform,
    };
  }

  // Standardize Pinterest (image data)
  if (platform === 'pinterest') {
    return {
      title: data.imran.title || 'Untitled Image',
      url: data.imran.url || '',
      thumbnail: data.imran.url || 'https://via.placeholder.com/300x150',
      sizes: ['Original Quality'],
      source: platform,
    };
  }

  // Default return for other platforms
  const sizes = data.sizes && data.sizes.length > 0 ? data.sizes : ['Original Quality'];
  return {
    title: data.title || 'Untitled Video',
    url: data.url || '',
    thumbnail: data.thumbnail || 'https://via.placeholder.com/300x150',
    sizes: sizes,
    source: platform,
  };
};

// Main media download function
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
      default:
        return res.status(500).json({ error: 'Platform identification failed' });
    }

    // Format the data
    let formattedData = await formatData(platform, data);

    // Shorten the media URL
    const shortenedUrl = await shortenUrl(formattedData.url);
    formattedData.url = shortenedUrl;

    // Shorten the thumbnail URL
    const shortenedThumbnail = await shortenUrl(formattedData.thumbnail);
    formattedData.thumbnail = shortenedThumbnail;

    // Send the response
    res.json({
      success: true,
      data: formattedData,
    });
  } catch (error) {
    console.error('Error downloading media:', error);
    res.status(500).json({ error: 'Failed to download media', details: error.message });
  }
};
