const axios = require('axios');
const { igdl, ttdl, twitter, youtube } = require('btch-downloader');
const { facebook } = require('@mrnima/facebook-downloader'); // Import the Facebook downloader
const { pinterestdl } = require('imran-servar');  // Import the Pinterest downloader

// Helper function to shorten URLs using TinyURL API
const shortenUrl = async (url) => {
  try {
    const response = await axios.get(`https://api.tinyurl.com/create?url=${encodeURIComponent(url)}`);
    if (response.data && response.data.result) {
      return response.data.result;
    }
  } catch (error) {
    console.error('Error shortening URL:', error);
    return url;  // Return the original URL if the shortening fails
  }
  return url;  // Return the original URL if TinyURL API doesn't respond as expected
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
  console.log('Formatting data:', platform, data);  // Debug log to see the raw data

  // Handle YouTube-specific data
  if (platform === 'youtube') {
    const videoUrl = data.mp4 || data.mp3 || '';
    return {
      title: data.title || 'Untitled Video',
      url: await shortenUrl(videoUrl),  // Shorten the URL
      thumbnail: data.thumbnail || 'https://via.placeholder.com/300x150',
      sizes: ['Original Quality'],
      source: platform,
    };
  }

  // Standardize data for TikTok
  if (platform === 'tiktok') {
    const videoUrl = data.video && data.video[0] || '';
    return {
      title: data.title || 'Untitled Video',
      url: await shortenUrl(videoUrl),  // Shorten the URL
      thumbnail: data.thumbnail || 'https://via.placeholder.com/300x150',
      sizes: ['Original Quality'],
      audio: data.audio && data.audio[0] || '',
      source: platform,
    };
  }

  // Standardize data for Instagram
  if (platform === 'instagram') {
    const videoUrl = data[0].url || '';  // Using the URL provided in the Instagram data
    return {
      title: data[0].wm || 'Untitled Video',
      url: await shortenUrl(videoUrl),  // Shorten the URL
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
      url: await shortenUrl(videoUrl),  // Shorten the URL
      thumbnail: data.thumbnail || 'https://via.placeholder.com/300x150',
      sizes: ['Original Quality'],
      source: platform,
    };
  }

  // Standardize data for Facebook
  if (platform === 'facebook') {
    const videoUrl = data.result.links.HD || data.result.links.SD || '';
    return {
      title: data.title || 'Untitled Video',
      url: await shortenUrl(videoUrl),  // Shorten the URL
      thumbnail: data.result.thumbnail || 'https://via.placeholder.com/300x150',
      sizes: ['Original Quality'],
      source: platform,
    };
  }

  // Standardize Pinterest (image data)
  if (platform === 'pinterest') {
    return {
      title: data.imran.title || 'Untitled Image',
      url: await shortenUrl(data.imran.url || ''),  // Shorten the URL
      thumbnail: data.imran.url || 'https://via.placeholder.com/300x150',
      sizes: ['Original Quality'],
      source: platform,
    };
  }

  // Handle other cases where URL shortening is needed
  const sizes = data.sizes && data.sizes.length > 0 ? data.sizes : ['Original Quality'];

  const response = {
    title: data.title || 'Untitled Video',
    url: await shortenUrl(data.url || ''),  // Shorten the URL
    thumbnail: data.thumbnail || 'https://via.placeholder.com/300x150',
    sizes: sizes,
  };

  // Add platform-specific properties if needed
  response.source = platform;

  return response;
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

  console.log('Identified platform:', platform);  // Debug log for platform identification

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

    console.log('Fetched data:', data);  // Debug log for fetched data

    // Standardize and format the data before sending to frontend
    const formattedData = await formatData(platform, data);

    res.json({
      success: true,
      data: formattedData,
    });
  } catch (error) {
    console.error('Error downloading media:', error);
    res.status(500).json({ error: 'Failed to download media', details: error.message });
  }
};
