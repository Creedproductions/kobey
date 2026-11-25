const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { promisify } = require('util');
const unlinkAsync = promisify(fs.unlink);

class MergeService {
    constructor() {
        this.tempDir = path.join(os.tmpdir(), 'yt-merge');

        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    /**
     * Merge video and audio streams using FFmpeg
     */
    async mergeStreams(videoUrl, audioUrl) {
        const timestamp = Date.now();
        const outputPath = path.join(this.tempDir, `merged_${timestamp}.mp4`);

        console.log('🔄 Starting server-side merge...');
        console.log(`📹 Video URL: ${videoUrl.substring(0, 100)}...`);
        console.log(`🎵 Audio URL: ${audioUrl.substring(0, 100)}...`);

        // Stream-copy both tracks first: re-encoding the audio pinned the
        // nano instance's CPU long enough for Koyeb health checks to fail and
        // the whole service to answer 502. AAC encoding is only the fallback
        // for audio codecs MP4 cannot hold.
        try {
            return await this._runFfmpeg(videoUrl, audioUrl, outputPath, ['-c:a', 'copy']);
        } catch (copyErr) {
            console.warn(`⚠️ Audio copy failed (${copyErr.message}); retrying with AAC encode`);
            return this._runFfmpeg(videoUrl, audioUrl, outputPath, ['-c:a', 'aac', '-b:a', '160k']);
        }
    }

    _runFfmpeg(videoUrl, audioUrl, outputPath, audioArgs) {
        return new Promise((resolve, reject) => {
            const ffmpegArgs = [
                '-hide_banner', '-loglevel', 'error', '-stats',
                '-i', videoUrl,
                '-i', audioUrl,
                '-map', '0:v:0', '-map', '1:a:0',
                '-c:v', 'copy',
                ...audioArgs,
                '-movflags', '+faststart',
                '-y',
                outputPath
            ];

            // Lowest CPU priority so the web server keeps answering requests
            // and health checks while a merge runs.
            const ffmpeg = spawn('nice', ['-n', '19', 'ffmpeg', ...ffmpegArgs]);

            let stderr = '';
            let settled = false;
            const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };

            ffmpeg.stderr.on('data', (data) => {
                stderr = (stderr + data.toString()).slice(-4000);
            });

            ffmpeg.on('close', (code) => {
                if (code === 0 && fs.existsSync(outputPath)) {
                    const stats = fs.statSync(outputPath);
                    console.log(`✅ FFmpeg merge successful (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
                    done(resolve, outputPath);
                } else {
                    console.error('❌ FFmpeg merge failed with code:', code, stderr.slice(-600));
                    done(reject, new Error(`FFmpeg failed with code ${code}`));
                }
            });

            ffmpeg.on('error', (error) => {
                console.error('❌ FFmpeg spawn error:', error);
                done(reject, error);
            });

            const timer = setTimeout(() => {
                ffmpeg.kill('SIGKILL');
                done(reject, new Error('FFmpeg merge timeout'));
            }, 5 * 60 * 1000);
        });
    }

    /**
     * Clean up temporary merged file
     */
    async cleanup(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                await unlinkAsync(filePath);
                console.log(`🧹 Cleaned up: ${filePath}`);
            }
        } catch (error) {
            console.error(`⚠️ Failed to cleanup ${filePath}:`, error.message);
        }
    }

    /**
     * Clean up old temporary files (older than 1 hour)
     */
    async cleanupOldFiles() {
        try {
            const files = fs.readdirSync(this.tempDir);
            const now = Date.now();
            const oneHour = 60 * 60 * 1000;

            for (const file of files) {
                const filePath = path.join(this.tempDir, file);
                const stats = fs.statSync(filePath);

                if (now - stats.mtimeMs > oneHour) {
                    await this.cleanup(filePath);
                }
            }
        } catch (error) {
            console.error('⚠️ Failed to cleanup old files:', error.message);
        }
    }
}

// Create singleton instance
const mergeService = new MergeService();

// Clean up old files on startup
mergeService.cleanupOldFiles();

// Schedule periodic cleanup (every hour)
setInterval(() => {
    mergeService.cleanupOldFiles();
}, 60 * 60 * 1000);

module.exports = mergeService;