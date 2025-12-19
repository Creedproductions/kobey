const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const axios = require('axios');

/**
 * Merge audio and video streams using FFmpeg
 * GET /api/merge-audio?videoUrl=...&audioUrl=...
 */
router.get('/merge-audio', async (req, res) => {
    const { videoUrl, audioUrl } = req.query;

    if (!videoUrl || !audioUrl) {
        return res.status(400).json({
            error: 'Missing videoUrl or audioUrl parameters'
        });
    }

    console.log('🎬 Starting merge request');
    console.log(`📹 Video URL: ${videoUrl.substring(0, 100)}...`);
    console.log(`🎵 Audio URL: ${audioUrl.substring(0, 100)}...`);

    let ffmpegProcess = null;
    let videoStream = null;
    let audioStream = null;
    let hasError = false;

    try {
        // Set response headers
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');
        res.setHeader('Transfer-Encoding', 'chunked');

        // Fetch streams
        console.log('📥 Fetching video stream...');
        const videoResponse = await axios({
            method: 'get',
            url: videoUrl,
            responseType: 'stream',
            timeout: 120000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            }
        });
        videoStream = videoResponse.data;

        console.log('📥 Fetching audio stream...');
        const audioResponse = await axios({
            method: 'get',
            url: audioUrl,
            responseType: 'stream',
            timeout: 120000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            }
        });
        audioStream = audioResponse.data;

        console.log('🔧 Starting FFmpeg...');

        // Spawn FFmpeg
        ffmpegProcess = spawn('ffmpeg', [
            '-i', 'pipe:3',           // Video from pipe 3
            '-i', 'pipe:4',           // Audio from pipe 4
            '-c:v', 'copy',           // Copy video (no re-encode)
            '-c:a', 'aac',            // Encode audio to AAC
            '-b:a', '192k',           // Audio bitrate
            '-movflags', 'frag_keyframe+empty_moov+faststart',
            '-f', 'mp4',              // Output format
            '-loglevel', 'error',     // Only show errors
            'pipe:1'                  // Output to stdout
        ], {
            stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']
        });

        // Pipe streams to FFmpeg
        videoStream.pipe(ffmpegProcess.stdio[3]);
        audioStream.pipe(ffmpegProcess.stdio[4]);

        // Pipe FFmpeg output to response
        ffmpegProcess.stdio[1].pipe(res);

        // Error handling
        const cleanup = () => {
            if (!hasError) {
                hasError = true;
                try {
                    if (videoStream) videoStream.destroy();
                    if (audioStream) audioStream.destroy();
                    if (ffmpegProcess && !ffmpegProcess.killed) {
                        ffmpegProcess.kill('SIGKILL');
                    }
                } catch (e) {
                    console.error('Cleanup error:', e.message);
                }
            }
        };

        ffmpegProcess.stderr.on('data', (data) => {
            console.error('FFmpeg error:', data.toString());
        });

        ffmpegProcess.on('error', (error) => {
            console.error('❌ FFmpeg process error:', error.message);
            cleanup();
            if (!res.headersSent) {
                res.status(500).json({ error: 'FFmpeg failed', details: error.message });
            }
        });

        ffmpegProcess.on('exit', (code) => {
            if (code === 0) {
                console.log('✅ Merge completed successfully');
            } else {
                console.error(`❌ FFmpeg exited with code ${code}`);
            }
            cleanup();
        });

        videoStream.on('error', (error) => {
            console.error('❌ Video stream error:', error.message);
            cleanup();
            if (!res.headersSent) {
                res.status(500).json({ error: 'Video stream failed' });
            }
        });

        audioStream.on('error', (error) => {
            console.error('❌ Audio stream error:', error.message);
            cleanup();
            if (!res.headersSent) {
                res.status(500).json({ error: 'Audio stream failed' });
            }
        });

        res.on('close', () => {
            console.log('📡 Client disconnected');
            cleanup();
        });

    } catch (error) {
        console.error('❌ Merge failed:', error.message);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Merge failed',
                details: error.message
            });
        }
    }
});

module.exports = router;