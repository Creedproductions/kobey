const express = require('express');
const router = express.Router();
const { getDownloadUrl } = require('../Services/youtubeService_y2mate');

// Endpoint to convert Y2Mate URLs to actual download URLs
router.get('/convert-url', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        message: 'URL parameter is required'
      });
    }

    console.log(`🔄 Converting URL: ${url.substring(0, 50)}...`);

    const downloadUrl = await getDownloadUrl(url);

    console.log(`✅ Converted to: ${downloadUrl.substring(0, 100)}...`);

    // Redirect to the actual download URL
    res.redirect(downloadUrl);

  } catch (error) {
    console.error('❌ URL conversion error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to convert URL',
      error: error.message
    });
  }
});

module.exports = router;
