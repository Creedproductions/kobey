// Routes/downloaderRoutes.js
const express = require('express');
const router = express.Router();

const controller = require('../Controllers/downloaderController');

// Capability / health
router.get('/health', (req, res) => res.json({ ok: true }));

// Unified "info" endpoints used by Flutter
router.get('/info', controller.getInfo);
router.get('/youtube', controller.getYoutubeInfo);
router.get('/facebook', controller.getFacebookInfo); // also handles instagram links
router.get('/threads', controller.getThreadsInfo);
router.get('/special-media', controller.getSpecialMedia);
router.get('/pinterest', controller.getPinterestInfo); // IMPLEMENTED

// Download endpoints used by Flutter download buttons
router.get('/download', controller.downloadByItag);
router.get('/audio', controller.downloadAudio);
router.get('/direct', controller.directDownload);
router.get('/threads-download', controller.threadsDownload);
router.get('/facebook-download', controller.facebookDownload);

module.exports = router;
