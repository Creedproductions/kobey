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

// Audio merging endpoint - FIXED
router.get('/merge-audio', async (req, res) => {
  try {
    const { videoUrl, audioUrl } = req.query;
    
    if (!videoUrl || !audioUrl) {
      return res.status(400).json({
        error: 'Both videoUrl and audioUrl parameters are required',
        success: false
      });
    }

    console.log(`🎬 Starting audio merge request`);
    console.log(`📹 Video URL: ${videoUrl.substring(0, 100)}...`);
    console.log(`🎵 Audio URL: ${audioUrl.substring(0, 100)}...`);

    // Decode URLs if they're encoded
    const decodedVideoUrl = decodeURIComponent(videoUrl);
    const decodedAudioUrl = decodeURIComponent(audioUrl);

    await audioMergerService.merge(decodedVideoUrl, decodedAudioUrl, res);

  } catch (error) {
    console.error('❌ Audio merge failed:', error);
    
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Audio merging failed',
        success: false,
        details: error.message
      });
    }
  }
});

// Diagnostics endpoint - NEW
router.get('/diagnostics', async (req, res) => {
  const os = require('os');
  
  const results = {
    timestamp: new Date().toISOString(),
    checks: {}
  };

  // Check FFmpeg
  results.checks.ffmpeg = await new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', ['-version']);
    let output = '';
    
    ffmpeg.stdout.on('data', (data) => { output += data.toString(); });
    ffmpeg.on('close', (code) => {
      resolve({
        installed: code === 0,
        version: output.match(/ffmpeg version ([^\s]+)/)?.[1] || 'Unknown',
        status: code === 0 ? '✅ Working' : '❌ Failed'
      });
    });
    ffmpeg.on('error', () => {
      resolve({ installed: false, status: '❌ Not found' });
    });
  });

  // System info
  results.checks.system = {
    platform: os.platform(),
    cpus: os.cpus().length,
    freeMemory: `${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)} GB`,
    status: '✅ OK'
  };

  // Environment
  results.checks.environment = {
    nodeVersion: process.version,
    serverBaseUrl: process.env.SERVER_BASE_URL || 'not configured',
    status: process.env.SERVER_BASE_URL ? '✅ Configured' : '⚠️ Missing'
  };

  results.healthy = results.checks.ffmpeg.installed;

  res.json(results);
});

// FFmpeg status check endpoint
router.get('/ffmpeg-status', (req, res) => {
  console.log('🔍 Checking FFmpeg installation...');
  
  try {
    let ffmpegPath = 'Not found';
    try {
      ffmpegPath = execSync('which ffmpeg').toString().trim();
    } catch (e) {
      console.warn('Could not locate FFmpeg with "which" command');
    }

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
        detailedOutput: output,
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

// System information endpoint
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
        port: process.env.PORT || 8080
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

// Test merge with sample URLs
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
      diagnostics: 'GET /api/diagnostics',
      ffmpegStatus: 'GET /api/ffmpeg-status',
      systemInfo: 'GET /api/system-info',
      testMerge: 'GET /api/test-merge?videoUrl=&audioUrl=',
      mockVideos: 'GET /api/mock-videos'
    }
  });
});

// Health check endpoint
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
