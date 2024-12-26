const { alldown } = require('shaon-media-downloader'); // Updated YouTube downloader
const { ttdl, twitter } = require('btch-downloader');
const { igdl } = require('btch-downloader');
const { facebook } = require('@mrnima/facebook-downloader');
const { pinterestdl } = require('imran-servar');
const { threads } = require('shaon-media-downloader'); // Updated Threads downloader
const { BitlyClient } = require('bitly');
const tinyurl = require('tinyurl'); // TinyURL package
const config = require('../Config/config'); // Import the config file

// Initialize Bitly client with your access token
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
    return response.link; // Return shortened URL if successful
  } catch (error) {
    console.warn("Shorten URL: Bitly failed, falling back to TinyURL.");
    try {
      const tinyResponse = await tinyurl.shorten(url);
      console.info("Shorten URL: Successfully shortened with TinyURL.");
      return tinyResponse; // Return shortened URL from TinyURL
    } catch (fallbackError) {
      console.error("Shorten URL: Both shortening methods failed.");
      return url; // Fallback to the original URL if all shortening attempts fail
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
      if (!youtubeData || (!youtubeData.low && !youtubeData.high)) {
        throw new Error("Data Formatting: YouTube data is incomplete or improperly formatted.");
      }
      console.info("Data Formatting: YouTube data formatted successfully.");
      return {
        title: youtubeData.title || 'Untitled Video',
        url: youtubeData.low || youtubeData.high || '',
        thumbnail: youtubeData.thumbnail || placeholderThumbnail,
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
      const twitterData = data?.data;
      const videoUrl = twitterData?.high || twitterData?.low || '';
      console.info("Data Formatting: Twitter data formatted successfully.");
      return {
        title: twitterData?.title || 'Untitled Video',
        url: videoUrl,
        thumbnail: placeholderThumbnail,
        sizes: twitterData?.high && twitterData?.low ? ['High Quality', 'Low Quality'] : ['Original Quality'],
        source: platform,
      };
    }

    case 'facebook': {
      console.info("Data Formatting: Facebook data formatted successfully.");
      return {
        title: data.title || 'Untitled Video',
        url: data.result.links?.HD || data.result.links?.SD || '',
        thumbnail: data.result.thumbnail || placeholderThumbnail,
        sizes: ['Original Quality'],
        source: platform,
      };
    }

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
        data = await facebook(url);
        break;
      case 'twitter':
        data = await alldown(url);
        break;
      case 'youtube':
        data = await alldown(url);
        break;
      case 'pinterest':
        data = await pinterestdl(url);
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
