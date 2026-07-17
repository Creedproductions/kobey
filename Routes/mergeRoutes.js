const express = require('express');
const router = express.Router();
const mergeService = require('../Services/mergeService');
const fs = require('fs');

/**
 * /api/merge-audio — merge a video stream and an audio stream with ffmpeg
 * and stream back one muxed mp4.
 *
 * Accepts BOTH:
 *   POST { videoUrl, audioUrl }            (legacy body shape)
 *   GET  ?videoUrl=…&audioUrl=…            (what the formatters emit)
 *
 * The GET form is what dataFormatters.reddit / the YouTube MERGE rewrite
 * produce, so download clients can fetch it like any direct media URL.
 * HEAD is answered cheaply (no merge) so clients that probe content-type
 * before downloading don't trigger a full ffmpeg run.
 */

async function handleMerge(req, res, videoUrl, audioUrl) {
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
}

router.post('/merge-audio', (req, res) => {
    const { videoUrl, audioUrl } = req.body || {};
    return handleMerge(req, res, videoUrl, audioUrl);
});

// Cheap HEAD: report the type without running ffmpeg. Some download
// clients HEAD a URL to decide file extension / audio-vs-video before
// the real GET; a full merge here would double the work and the wait.
// MUST be registered BEFORE router.get — Express lets HEAD requests fall
// through to a matching GET handler, which would run the whole merge.
router.head('/merge-audio', (req, res) => {
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'none');
    res.status(200).end();
});

router.get('/merge-audio', (req, res) => {
    const { videoUrl, audioUrl } = req.query || {};
    return handleMerge(req, res, videoUrl, audioUrl);
});

module.exports = router;
