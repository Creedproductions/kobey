const express = require('express');
const router = express.Router();
const mergeService = require('../Services/mergeService');
const fs = require('fs');

/**
 * POST /api/merge-audio
 * Merges video and audio streams and returns the merged file
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
        console.log('🎬 Merge request received');

        // Perform the merge
        mergedFilePath = await mergeService.mergeStreams(videoUrl, audioUrl);

        // Check file exists
        if (!fs.existsSync(mergedFilePath)) {
            throw new Error('Merged file not found');
        }

        // Get file stats
        const stats = fs.statSync(mergedFilePath);
        console.log(`✅ Merge complete. Sending file (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

        // Set headers for download
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', stats.size);
        res.setHeader('Content-Disposition', 'attachment; filename="merged_video.mp4"');

        // Stream the file to client
        const fileStream = fs.createReadStream(mergedFilePath);

        fileStream.pipe(res);

        // Cleanup after sending
        fileStream.on('end', () => {
            console.log('📤 File sent successfully');
            // Cleanup after a delay to ensure file is fully sent
            setTimeout(() => {
                mergeService.cleanup(mergedFilePath);
            }, 5000);
        });

        fileStream.on('error', (error) => {
            console.error('❌ File stream error:', error);
            if (mergedFilePath) {
                mergeService.cleanup(mergedFilePath);
            }
        });

    } catch (error) {
        console.error('❌ Merge error:', error);

        // Cleanup on error
        if (mergedFilePath) {
            mergeService.cleanup(mergedFilePath);
        }

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