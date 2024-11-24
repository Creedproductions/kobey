const express = require('express');
const router = express.Router();
const downloaderController = require('../Controllers/downloaderController');

// POST route to download media
router.post('/download', downloaderController.downloadMedia);

module.exports = router;
