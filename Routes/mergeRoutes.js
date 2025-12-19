const express = require('express');
const router = express.Router();
const mergeService = require('../Services/mergeService');
const fs = require('fs');

// ✅ NEW: token store
const mergeTokenStore = require('../Services/mergeTokenStore');

/**
 * GET /api/merge/:token.mp4
 * Streams merged video (video+audio) to client
 */
router.get('/merge/:token.mp4', async (req, res) => {
    const { token } = req.params;

    const pair = mergeTokenStore.get(token);
    if (!pair || !pair.videoUrl || !pair.audioUrl) {
        return res.status(404).json({
            success: false,
            error: 'Invalid or expired merge token'
        });
    }

    let mergedFilePath = null;

    try {
        console.log('🎬 Merge GET request received:', token);

        mergedFilePath = await mergeService.mergeStreams(pair.videoUrl, pair.audioUrl);

        if (!fs.existsSync(mergedFilePath)) {
            throw new Error('Merged file not found');
        }

        const stats = fs.statSync(mergedFilePath);

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', stats.size);
        res.setHeader('Content-Disposition', 'attachment; filename="video_with_audio.mp4"');

        const fileStream = fs.createReadStream(mergedFilePath);
        fileStream.pipe(res);

        fileStream.on('end', () => {
            console.log('📤 File sent successfully');
            setTimeout(() => mergeService.cleanup(mergedFilePath), 5000);
            mergeTokenStore.delete(token);
        });

        fileStream.on('error', (error) => {
            console.error('❌ File stream error:', error);
            if (mergedFilePath) mergeService.cleanup(mergedFilePath);
            mergeTokenStore.delete(token);
        });

    } catch (error) {
        console.error('❌ Merge error:', error.message);

        if (mergedFilePath) mergeService.cleanup(mergedFilePath);
        mergeTokenStore.delete(token);

        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                error: 'Failed to merge video and audio',
                details: error.message
            });
        }
    }
});

/**
 * POST /api/merge-audio (your existing endpoint)
 */
router.post('/merge-audio', async (req, res) => {
    const { videoUrl, audioUrl } = req.body;

    if (!videoUrl || !audioUrl) {
        return res.status(400).json({
            success: false,
            error: 'Missing videoUrl or audioUrl'
        });
    }

    let mergedFilePath = null;

    try {
        console.log('🎬 Merge POST request received');

        mergedFilePath = await mergeService.mergeStreams(videoUrl, audioUrl);

        if (!fs.existsSync(mergedFilePath)) {
            throw new Error('Merged file not found');
        }

        const stats = fs.statSync(mergedFilePath);

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', stats.size);
        res.setHeader('Content-Disposition', 'attachment; filename="merged_video.mp4"');

        const fileStream = fs.createReadStream(mergedFilePath);
        fileStream.pipe(res);

        fileStream.on('end', () => {
            console.log('📤 File sent successfully');
            setTimeout(() => mergeService.cleanup(mergedFilePath), 5000);
        });

        fileStream.on('error', (error) => {
            console.error('❌ File stream error:', error);
            if (mergedFilePath) mergeService.cleanup(mergedFilePath);
        });

    } catch (error) {
        console.error('❌ Merge error:', error);

        if (mergedFilePath) mergeService.cleanup(mergedFilePath);

        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                error: 'Failed to merge video and audio',
                details: error.message
            });
        }
    }
});

module.exports = router;
