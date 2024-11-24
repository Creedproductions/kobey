const { igdl, ttdl, twitter, youtube } = require('btch-downloader');
const { facebook } = require('@mrnima/facebook-downloader'); // Import the Facebook downloader
const { pinterestdl } = require('imran-servar');  // Import the Pinterest downloader



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
const formatData = (platform, data) => {
  console.log('Formatting data:', platform, data);  // Debug log to see the raw data

  // Handle YouTube-specific data
  if (platform === 'youtube') {
    return {
      title: data.title || 'Untitled Video',
      url: data.mp4 || data.mp3 || '',  // Prefer MP4 if available, otherwise MP3
      thumbnail: data.thumbnail || 'https://via.placeholder.com/300x150',
      sizes: ['Original Quality'],
      source: platform,
    };
  }

  // Standardize data for TikTok
  if (platform === 'tiktok') {
    return {
      title: data.title || 'Untitled Video',
      url: data.video && data.video[0] || '', // Using the first video URL
      thumbnail: data.thumbnail || 'https://via.placeholder.com/300x150',
      sizes: ['Original Quality'],
      audio: data.audio && data.audio[0] || '', // Using the first audio URL
      source: platform,
    };
  }

  // Standardize data for Instagram
  if (platform === 'instagram') {
    const videoUrl = data[0].url || '';  // Using the URL provided in the Instagram data
    return {
      title: data[0].wm || 'Untitled Video',  // Using the watermark (username) as title if available
      url: videoUrl || '',  // Ensure URL is extracted properly
      thumbnail: data[0].thumbnail || 'https://via.placeholder.com/300x150',  // Extract the thumbnail
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
      url: data.result.links.HD || data.result.links.SD || '', // Prefer HD if available
      thumbnail: data.result.thumbnail || 'https://via.placeholder.com/300x150',
      sizes: ['Original Quality'],
      source: platform,
    };
  }

  // Standardize Pinterest (image data)
  if (platform === 'pinterest') {
    return {
      title: data.imran.title || 'Untitled Image',  // Default title if not provided
      url: data.imran.url || '',  // Pinterest image URL
      thumbnail: data.imran.url || 'https://via.placeholder.com/300x150',  // Use image URL as thumbnail
      sizes: ['Original Quality'],  // Pinterest doesn't typically have video sizes
      source: platform,
    };
  }

  // For other platforms (e.g., Pinterest), the previous logic applies
  const sizes = data.sizes && data.sizes.length > 0 ? data.sizes : ['Original Quality'];

  const response = {
    title: data.title || 'Untitled Video',
    url: data.url || '',
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
    const formattedData = formatData(platform, data);

    res.json({
      success: true,
      data: formattedData,
    });
  } catch (error) {
    console.error('Error downloading media:', error);
    res.status(500).json({ error: 'Failed to download media', details: error.message });
  }
};
