const express = require('express');
const router = express.Router();
const { downloadMedia } = require('../Controllers/downloaderController');
const mockController = require('../Controllers/mockController');

router.post('/download', downloadMedia);
router.get('/mock-videos', mockController.getMockVideos);

router.get('/test', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Download API is working',
    timestamp: new Date().toISOString(),
    supportedPlatforms: [
      'instagram', 'tiktok', 'facebook', 'twitter', 'youtube', 'pinterest',
      'threads', 'linkedin', 'douyin', 'reddit', 'vimeo', 'dailymotion',
      'streamable', 'twitch', 'pornhub', 'xvideos', 'universal'
    ],
    features: ['media_download', 'multiple_qualities', 'universal_downloader']
  });
});

router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

module.exports = router;