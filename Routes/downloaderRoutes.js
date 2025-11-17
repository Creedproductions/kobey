const express = require('express');
const router = express.Router();
const { downloadMedia } = require('../Controllers/downloaderController');
const mockController = require('../Controllers/mockController');
const audioMergerService = require('../Services/audioMergerService');

// POST route to download media
router.post('/download', downloadMedia);

// GET route to fetch mock data
router.get('/mock-videos', mockController.getMockVideos);

// Audio merging endpoint for YouTube videos
router.get('/merge-audio', async (req, res) => {
  try {
    const { videoUrl, audioUrl } = req.query;
    
    if (!videoUrl || !audioUrl) {
      return res.status(400).json({
        error: 'Both videoUrl and audioUrl parameters are required',
        success: false
      });
    }

    console.log(`🎬 Starting audio merge request`);
    console.log(`📹 Video URL: ${videoUrl.substring(0, 100)}...`);
    console.log(`🎵 Audio URL: ${audioUrl.substring(0, 100)}...`);

    await audioMergerService.mergeVideoAudio(videoUrl, audioUrl, res);

  } catch (error) {
    console.error('❌ Audio merge failed:', error);
    res.status(500).json({
      error: 'Audio merging failed',
      success: false,
      details: error.message
    });
  }
});

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
    ],
    features: [
      'media_download',
      'audio_merging',
      'multiple_qualities'
    ]
  });
});

module.exports = router;
