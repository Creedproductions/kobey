const { spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Temp directory for processing
const TEMP_DIR = path.join(os.tmpdir(), 'yt-merge');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ============================================
// REQUEST DEDUPLICATION
// Prevents multiple simultaneous merges of same video
// ============================================
const activeRequests = new Map(); // key -> Promise

function getRequestKey(videoUrl, audioUrl) {
    // Create a hash from first 100 chars of each URL
    const videoHash = videoUrl.substring(0, 100);
    const audioHash = audioUrl.substring(0, 100);
    return `${videoHash}|${audioHash}`;
}

/**
 * Find compatible audio format for a video format
 */
function findCompatibleAudio(videoFormat, audioFormats) {
    if (!audioFormats || audioFormats.length === 0) return null;

    // Sort by quality (prefer higher bitrate, prefer m4a over opus)
    const sorted = [...audioFormats].sort((a, b) => {
        const aRate = extractBitrate(a.label || a.quality || '');
        const bRate = extractBitrate(b.label || b.quality || '');

        // Prefer m4a for better compatibility
        const aIsM4a = (a.ext || a.extension || '').toLowerCase() === 'm4a';
        const bIsM4a = (b.ext || b.extension || '').toLowerCase() === 'm4a';

        if (aIsM4a && !bIsM4a) return -1;
        if (!aIsM4a && bIsM4a) return 1;

        return bRate - aRate;
    });

    return sorted[0];
}

function extractBitrate(label) {
    const match = label.match(/(\d+)\s*k/i);
    return match ? parseInt(match[1]) : 128;
}

/**
 * Download a file to temp directory with progress callback
 */
async function downloadToTemp(url, filename, onProgress) {
    const filepath = path.join(TEMP_DIR, filename);
    const writer = fs.createWriteStream(filepath);

    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        timeout: 300000, // 5 minutes
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });

    const totalBytes = parseInt(response.headers['content-length'] || '0');

    return new Promise((resolve, reject) => {
        let downloaded = 0;

        response.data.on('data', (chunk) => {
            downloaded += chunk.length;
            if (onProgress && totalBytes > 0) {
                onProgress(downloaded / totalBytes);
            }
        });

        response.data.pipe(writer);

        writer.on('finish', () => {
            resolve({ filepath, size: downloaded, totalBytes });
        });

        writer.on('error', reject);
        response.data.on('error', reject);
    });
}

/**
 * Merge video and audio using FFmpeg - WITH DEDUPLICATION
 */
async function mergeVideoAudio(videoUrl, audioUrl, onProgress) {
    // Check for existing request
    const requestKey = getRequestKey(videoUrl, audioUrl);

    if (activeRequests.has(requestKey)) {
        console.log('🔄 Reusing existing merge request');
        return activeRequests.get(requestKey);
    }

    // Create new merge promise
    const mergePromise = doMerge(videoUrl, audioUrl, onProgress);
    activeRequests.set(requestKey, mergePromise);

    try {
        const result = await mergePromise;
        return result;
    } finally {
        // Remove from active requests after completion
        activeRequests.delete(requestKey);
    }
}

/**
 * Actual merge implementation
 */
async function doMerge(videoUrl, audioUrl, onProgress) {
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(7);
    const videoFile = `video_${timestamp}_${randomId}.mp4`;
    const audioFile = `audio_${timestamp}_${randomId}.m4a`;
    const outputFile = `merged_${timestamp}_${randomId}.mp4`;
    const outputPath = path.join(TEMP_DIR, outputFile);

    try {
        // Stage 1: Download video (0-40%)
        onProgress && onProgress({ stage: 'downloading_video', progress: 0, message: 'Downloading video...' });
        console.log('📥 Downloading video...');

        const videoResult = await downloadToTemp(videoUrl, videoFile, (p) => {
            onProgress && onProgress({
                stage: 'downloading_video',
                progress: Math.round(p * 40),
                message: `Downloading video... ${Math.round(p * 100)}%`
            });
        });
        console.log(`✅ Video: ${(videoResult.size / 1024 / 1024).toFixed(2)} MB`);

        // Stage 2: Download audio (40-60%)
        onProgress && onProgress({ stage: 'downloading_audio', progress: 40, message: 'Downloading audio...' });
        console.log('📥 Downloading audio...');

        const audioResult = await downloadToTemp(audioUrl, audioFile, (p) => {
            onProgress && onProgress({
                stage: 'downloading_audio',
                progress: 40 + Math.round(p * 20),
                message: `Downloading audio... ${Math.round(p * 100)}%`
            });
        });
        console.log(`✅ Audio: ${(audioResult.size / 1024 / 1024).toFixed(2)} MB`);

        // Stage 3: Merge with FFmpeg (60-95%)
        onProgress && onProgress({ stage: 'merging', progress: 60, message: 'Merging video and audio...' });
        console.log('🔄 Merging...');

        await new Promise((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', [
                '-y',
                '-i', videoResult.filepath,
                '-i', audioResult.filepath,
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-map', '0:v:0',
                '-map', '1:a:0',
                '-shortest',
                '-movflags', '+faststart',
                outputPath
            ]);

            let stderr = '';
            let duration = 0;

            ffmpeg.stderr.on('data', (data) => {
                stderr += data.toString();

                // Parse duration
                const durationMatch = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2})/);
                if (durationMatch && duration === 0) {
                    duration = parseInt(durationMatch[1]) * 3600 +
                        parseInt(durationMatch[2]) * 60 +
                        parseInt(durationMatch[3]);
                }

                // Parse progress
                const timeMatch = data.toString().match(/time=(\d{2}):(\d{2}):(\d{2})/);
                if (timeMatch && duration > 0) {
                    const currentTime = parseInt(timeMatch[1]) * 3600 +
                        parseInt(timeMatch[2]) * 60 +
                        parseInt(timeMatch[3]);
                    const mergeProgress = Math.min(currentTime / duration, 1);
                    onProgress && onProgress({
                        stage: 'merging',
                        progress: 60 + Math.round(mergeProgress * 35),
                        message: 'Merging video and audio...'
                    });
                }
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    console.log('✅ Merge complete');
                    resolve();
                } else {
                    console.error('FFmpeg failed:', stderr.slice(-500));
                    reject(new Error(`FFmpeg failed with code ${code}`));
                }
            });

            ffmpeg.on('error', (err) => {
                reject(new Error(`FFmpeg error: ${err.message}`));
            });
        });

        // Cleanup source files
        try {
            fs.unlinkSync(videoResult.filepath);
            fs.unlinkSync(audioResult.filepath);
        } catch (e) {
            console.warn('Cleanup warning:', e.message);
        }

        onProgress && onProgress({ stage: 'complete', progress: 100, message: 'Complete!' });

        const outputSize = fs.statSync(outputPath).size;
        console.log(`✅ Output: ${(outputSize / 1024 / 1024).toFixed(2)} MB`);

        return {
            filepath: outputPath,
            size: outputSize,
            cleanup: () => {
                try { fs.unlinkSync(outputPath); } catch (e) {}
            }
        };

    } catch (error) {
        // Cleanup on error
        [videoFile, audioFile, outputFile].forEach(f => {
            try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch (e) {}
        });
        throw error;
    }
}

/**
 * Stream merged video directly to response
 */
async function streamMergedVideo(videoUrl, audioUrl, res, onProgress) {
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(7);
    const videoFile = path.join(TEMP_DIR, `video_${timestamp}_${randomId}.mp4`);
    const audioFile = path.join(TEMP_DIR, `audio_${timestamp}_${randomId}.m4a`);

    try {
        // Download video
        onProgress && onProgress({ stage: 'downloading_video', progress: 0 });
        console.log('📥 Downloading video for streaming...');

        const videoResponse = await axios({
            url: videoUrl,
            method: 'GET',
            responseType: 'stream',
            timeout: 300000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        await new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(videoFile);
            videoResponse.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // Download audio
        onProgress && onProgress({ stage: 'downloading_audio', progress: 33 });
        console.log('📥 Downloading audio for streaming...');

        const audioResponse = await axios({
            url: audioUrl,
            method: 'GET',
            responseType: 'stream',
            timeout: 300000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        await new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(audioFile);
            audioResponse.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // Stream FFmpeg output directly to response
        onProgress && onProgress({ stage: 'merging', progress: 66 });
        console.log('🔄 Streaming merged output...');

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Transfer-Encoding', 'chunked');

        const ffmpeg = spawn('ffmpeg', [
            '-i', videoFile,
            '-i', audioFile,
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-shortest',
            '-movflags', 'frag_keyframe+empty_moov+faststart',
            '-f', 'mp4',
            'pipe:1'
        ]);

        ffmpeg.stdout.pipe(res);

        return new Promise((resolve, reject) => {
            ffmpeg.on('close', (code) => {
                try { fs.unlinkSync(videoFile); } catch (e) {}
                try { fs.unlinkSync(audioFile); } catch (e) {}

                if (code === 0) {
                    console.log('✅ Streaming complete');
                    onProgress && onProgress({ stage: 'complete', progress: 100 });
                    resolve();
                } else {
                    reject(new Error(`FFmpeg exited with code ${code}`));
                }
            });

            ffmpeg.on('error', (err) => {
                try { fs.unlinkSync(videoFile); } catch (e) {}
                try { fs.unlinkSync(audioFile); } catch (e) {}
                reject(err);
            });

            res.on('close', () => {
                ffmpeg.kill('SIGTERM');
            });
        });

    } catch (error) {
        try { fs.unlinkSync(videoFile); } catch (e) {}
        try { fs.unlinkSync(audioFile); } catch (e) {}
        throw error;
    }
}

/**
 * Cleanup old temp files
 */
function cleanupOldFiles(maxAgeMs = 1800000) { // 30 minutes
    try {
        const files = fs.readdirSync(TEMP_DIR);
        const now = Date.now();

        files.forEach(file => {
            const filepath = path.join(TEMP_DIR, file);
            try {
                const stat = fs.statSync(filepath);
                if (now - stat.mtimeMs > maxAgeMs) {
                    fs.unlinkSync(filepath);
                    console.log(`🧹 Cleaned: ${file}`);
                }
            } catch (e) {}
        });
    } catch (e) {
        console.warn('Cleanup error:', e.message);
    }
}

/**
 * Get number of active merge requests
 */
function getActiveRequestCount() {
    return activeRequests.size;
}

// Cleanup old files every 15 minutes
setInterval(() => cleanupOldFiles(), 900000);

module.exports = {
    findCompatibleAudio,
    mergeVideoAudio,
    streamMergedVideo,
    cleanupOldFiles,
    getActiveRequestCount,
    TEMP_DIR
};