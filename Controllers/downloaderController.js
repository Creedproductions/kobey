// controllers/downloaderController.js

const { igdl, ttdl, fbdown, twitter, youtube } = require('btch-downloader');

// Helper function to identify the platform from a URL
const identifyPlatform = (url) => {
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
  if (url.includes('x.com')) return 'twitter';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  return null; // Unsupported platform
};

// Main download function
exports.downloadMedia = async (req, res) => {
  const { url } = req.body; // Expecting URL in the request body

  if (!url) {
    return res.status(400).json({ error: 'No URL provided' });
  }

  const platform = identifyPlatform(url);

  if (!platform) {
    return res.status(400).json({ error: 'Unsupported platform' });
  }

  try {
    let data;

    switch (platform) {
      case 'instagram':
        data = await igdl(url);
        break;
      case 'tiktok':
        data = await ttdl(url);
        break;
      case 'facebook':
        data = await fbdown(url);
        break;
      case 'twitter':
        data = await twitter(url);
        break;
      case 'youtube':
        data = await youtube(url);
        break;
      default:
        return res.status(500).json({ error: 'Platform identification failed' });
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error downloading media:', error);
    res.status(500).json({ error: 'Failed to download media', details: error.message });
  }
};
