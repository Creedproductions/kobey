const express = require('express');
const router = express.Router();
const { downloadMedia } = require('../Controllers/downloaderController');
const mockController = require('../Controllers/mockController');

// POST route to download media
router.post('/download', downloadMedia);

// GET route to fetch mock data
router.get('/mock-videos', mockController.getMockVideos);

// Test endpoint
router.get('/test', (req, res) => {
  res.status(200).json({
    message: 'Download API is working',
    timestamp: new Date().toISOString(),
    supportedPlatforms: [
      'instagram',
      'tiktok',
      'facebook',
      'twitter',
      'youtube',
      'pinterest',
      'threads',
      'linkedin'
    ]
  });
});

module.exports = router;
