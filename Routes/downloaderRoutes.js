const express = require('express');
const router = express.Router();
const { spawn, execSync } = require('child_process');
const { downloadMedia } = require('../Controllers/downloaderController');
const mockController = require('../Controllers/mockController');
const audioMergerService = require('../Services/audioMergerService');

// POST route to download media
router.post('/download', downloadMedia);

// GET route to fetch mock data
router.get('/mock-videos', mockController.getMockVideos);

// Audio merging endpoint for YouTube videos - IMPROVED VERSION
router.get('/merge-audio', async (req, res) => {
  try {
    const { videoUrl, audioUrl } = req.query;
    
    if (!videoUrl || !audioUrl) {
      return res.status(400).json({
        error: 'Both videoUrl and audioUrl parameters are required',
        success: false
      });
    }

    // Decode URLs in case they're encoded
    const decodedVideoUrl = decodeURIComponent(videoUrl);
    const decodedAudioUrl = decodeURIComponent(audioUrl);

    console.log(`🎬 Starting audio merge request`);
    console.log(`📹 Video URL: ${decodedVideoUrl.substring(0, 100)}...`);
    console.log(`🎵 Audio URL: ${decodedAudioUrl.substring(0, 100)}...`);

    // Set a timeout for the merge operation (5 minutes)
    req.setTimeout(300000);
    res.setTimeout(300000);

    // Call the merge service
    await audioMergerService.merge(decodedVideoUrl, decodedAudioUrl, res);

  } catch (error) {
    console.error('❌ Audio merge failed:', error);
    
    // Only send error response if headers haven't been sent yet
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Audio merging failed',
        success: false,
        details: error.message
      });
    }
  }
});

// FFmpeg status check endpoint - ENHANCED VERSION
router.get('/ffmpeg-status', (req, res) => {
  console.log('🔍 Checking FFmpeg installation...');
  
  try {
    // Try to get FFmpeg location
    let ffmpegPath = 'Not found';
    try {
      ffmpegPath = execSync('which ffmpeg').toString().trim();
    } catch (e) {
      console.warn('Could not locate FFmpeg with "which" command');
    }

    // Check for required codecs
    let codecs = {};
    try {
      const codecOutput = execSync('ffmpeg -codecs 2>/dev/null').toString();
      codecs = {
        aac: codecOutput.includes('aac'),
        h264: codecOutput.includes('h264'),
        mp4: codecOutput.includes('mp4')
      };
    } catch (e) {
      console.warn('Could not check codecs');
    }

    // Spawn FFmpeg process to get version
    const ffmpeg = spawn('ffmpeg', ['-version']);
    let output = '';
    let errorOutput = '';
    
    ffmpeg.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    ffmpeg.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    ffmpeg.on('close', (code) => {
      const versionMatch = output.match(/ffmpeg version ([^\s]+)/);
      const version = versionMatch ? versionMatch[1] : 'Unknown';
      
      res.json({
        success: code === 0,
        installed: code === 0,
        exitCode: code,
        path: ffmpegPath,
        version: version,
        fullVersion: output.split('\n')[0] || 'Unknown',
        codecs: codecs,
        detailedOutput: output.substring(0, 500),
        error: errorOutput,
        timestamp: new Date().toISOString(),
        message: code === 0 ? '✅ FFmpeg is installed and working' : '❌ FFmpeg check failed'
      });
    });
    
    ffmpeg.on('error', (error) => {
      console.error('❌ FFmpeg error:', error);
      res.status(500).json({
        success: false,
        installed: false,
        error: error.message,
        message: '❌ FFmpeg is not installed or not accessible',
        timestamp: new Date().toISOString()
      });
    });
    
  } catch (error) {
    console.error('❌ FFmpeg status check failed:', error);
    res.status(500).json({
      success: false,
      installed: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// System information endpoint - DEBUGGING HELPER
router.get('/system-info', (req, res) => {
  try {
    const os = require('os');
    
    res.json({
      success: true,
      system: {
        platform: os.platform(),
        architecture: os.arch(),
        cpus: os.cpus().length,
        totalMemory: `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB`,
        freeMemory: `${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)} GB`,
        nodeVersion: process.version,
        uptime: `${Math.floor(process.uptime())} seconds`
      },
      environment: {
        nodeEnv: process.env.NODE_ENV || 'development',
        port: process.env.PORT || 8080,
        ffmpegPath: process.env.FFMPEG_PATH || 'default'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test merge with sample URLs - TESTING ENDPOINT
router.get('/test-merge', async (req, res) => {
  const testVideoUrl = req.query.videoUrl;
  const testAudioUrl = req.query.audioUrl;
  
  if (!testVideoUrl || !testAudioUrl) {
    return res.status(400).json({
      error: 'Please provide both videoUrl and audioUrl query parameters',
      example: '/api/test-merge?videoUrl=VIDEO_URL&audioUrl=AUDIO_URL',
      success: false
    });
  }
  
  console.log('🧪 Testing audio merge with provided URLs');
  
  try {
    // Set timeout for test
    req.setTimeout(300000);
    res.setTimeout(300000);
    
    await audioMergerService.merge(testVideoUrl, testAudioUrl, res);
  } catch (error) {
    console.error('❌ Test merge failed:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Test merge failed',
        details: error.message,
        success: false
      });
    }
  }
});

// Main test endpoint
router.get('/test', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Download API is working',
    timestamp: new Date().toISOString(),
    supportedPlatforms: [
      'instagram',
      'tiktok',
      'facebook',
      'twitter',
      'youtube',
      'pinterest',
      'threads',
      'linkedin'
    ],
    features: [
      'media_download',
      'audio_merging',
      'multiple_qualities',
      'ffmpeg_integration'
    ],
    endpoints: {
      download: 'POST /api/download',
      mergeAudio: 'GET /api/merge-audio?videoUrl=&audioUrl=',
      ffmpegStatus: 'GET /api/ffmpeg-status',
      systemInfo: 'GET /api/system-info',
      testMerge: 'GET /api/test-merge?videoUrl=&audioUrl=',
      mockVideos: 'GET /api/mock-videos'
    }
  });
});

// Health check endpoint for monitoring
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memoryUsage: {
      rss: `${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)} MB`,
      heapUsed: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`
    }
  });
});

module.exports = router;
