// controllers/youtubeController.js

const { ytdown } = require("shaon-media-downloader");

const downloadYouTubeVideo = async (url) => {
  try {
    const videoData = await ytdown(url);
    return videoData;
  } catch (error) {
    console.error("Error downloading YouTube video:", error);
    throw new Error("Failed to download YouTube video");
  }
};

module.exports = { downloadYouTubeVideo };
