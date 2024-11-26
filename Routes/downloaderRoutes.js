const express = require('express');
const router = express.Router();
const downloaderController = require('../Controllers/downloaderController');
const mockController = require('../Controllers/mockController')

// POST route to download media
router.post('/download', downloaderController.downloadMedia);

// GET route to fetch mock data
router.get('/mock-videos', mockController.getMockVideos);


module.exports = router;
