// Routes/downloaderRoutes.js
const express = require('express');
const router = express.Router();
const downloaderController = require('../Controllers/downloaderController');

router.post('/download', downloaderController.downloadMedia);

module.exports = router;
