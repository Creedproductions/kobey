const express = require('express');
const cors = require('cors');
const downloaderRoutes = require('./Routes/downloaderRoutes');
const config = require('./Config/config');
const fs = require('fs');
const path = require('path');

const app = express();

const PORT = config.PORT || process.env.PORT || 8000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Check cookies on startup
function checkCookiesFile() {
  const possiblePaths = [
    '/cookies.txt',
    '/app/cookies.txt',
    path.join(__dirname, 'cookies.txt'),
    path.join(process.cwd(), 'cookies.txt'),
    'cookies.txt'
  ];

  let foundPath = null;
  let fileInfo = null;

  for (const cookiePath of possiblePaths) {
    try {
      if (fs.existsSync(cookiePath)) {
        const stats = fs.statSync(cookiePath);
        const sizeKB = (stats.size / 1024).toFixed(2);

        // Read first few lines to check format
        const content = fs.readFileSync(cookiePath, 'utf8').trim();
        const lines = content.split('\n');

        fileInfo = {
          path: cookiePath,
          sizeKB: sizeKB,
          lineCount: lines.length,
          format: 'unknown'
        };

        if (content.startsWith('# Netscape HTTP Cookie File')) {
          fileInfo.format = 'netscape';
          const cookieEntries = lines.filter(line => !line.startsWith('#') && line.trim());
          fileInfo.entries = cookieEntries.length;
        } else if (content.includes('\t')) {
          fileInfo.format = 'tab-separated';
        }

        foundPath = cookiePath;
        break;
      }
    } catch (err) {
      console.log(`⚠️ Error checking path ${cookiePath}:`, err.message);
    }
  }

  return { foundPath, fileInfo };
}

const corsOptions = {
  origin: [
    'https://savedownloader.vercel.app',
    'https://savedownloaderweb.vercel.app',
    'http://localhost:5173'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

const setupMiddleware = () => {
  app.use(express.json());
  app.use(cors(corsOptions));
};

const setupRoutes = () => {
  app.use('/api', downloaderRoutes);

  // Add cookies status endpoint
  app.get('/api/cookies-status', (req, res) => {
    const { foundPath, fileInfo } = checkCookiesFile();
    if (foundPath) {
      res.status(200).json({
        status: 'found',
        path: foundPath,
        info: fileInfo,
        message: 'Cookies file is available and ready to use'
      });
    } else {
      res.status(404).json({
        status: 'not_found',
        message: 'No cookies file found. Age-restricted videos may not work.',
        searchPaths: [
          '/cookies.txt',
          '/app/cookies.txt',
          './cookies.txt'
        ]
      });
    }
  });

  // Test cookies with YouTube
  app.get('/api/test-cookies', async (req, res) => {
    try {
      const { youtubeService } = require('./Services/youtubeService');
      const result = await youtubeService.testCookies();

      res.status(200).json({
        success: result.success,
        message: result.message,
        details: result
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: `Error testing cookies: ${error.message}`
      });
    }
  });

  app.get('/health', (req, res) => {
    const { foundPath, fileInfo } = checkCookiesFile();
    const cookieStatus = foundPath ? {
      available: true,
      path: foundPath,
      sizeKB: fileInfo.sizeKB,
      format: fileInfo.format
    } : {
      available: false,
      message: 'No cookies file found'
    };

    res.status(200).json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      environment: NODE_ENV,
      uptime: process.uptime(),
      memory: {
        rss: `${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB`,
        heapTotal: `${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2)} MB`,
        heapUsed: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`
      },
      features: ['downloads', 'cookies-support'],
      database: 'disabled',
      cookies: cookieStatus
    });
  });

  app.get('/', (req, res) => {
    const { foundPath } = checkCookiesFile();

    res.status(200).json({
      message: 'Media Downloader API',
      status: 'running',
      endpoints: {
        health: '/health',
        cookiesStatus: '/api/cookies-status',
        testCookies: '/api/test-cookies',
        download: '/api/download',
        mockVideos: '/api/mock-videos'
      },
      cookies: foundPath ? 'Available' : 'Not found',
      note: foundPath ? 'Cookies enabled for age-restricted videos' : 'Add cookies.txt to root for age-restricted videos'
    });
  });
};

const setupErrorHandling = () => {
  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    if (NODE_ENV !== 'production') {
      process.exit(1);
    }
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  });

  process.on('SIGTERM', () => {
    console.log('👋 SIGTERM received, shutting down gracefully');
    if (server) {
      server.close(() => {
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });

  process.on('SIGINT', () => {
    console.log('👋 SIGINT received, shutting down gracefully');
    if (server) {
      server.close(() => {
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });
};

const startServer = () => {
  const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌍 Environment: ${NODE_ENV}`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
    console.log(`📥 Download API: http://localhost:${PORT}/api/download`);

    // Check cookies on startup
    const { foundPath, fileInfo } = checkCookiesFile();
    if (foundPath) {
      console.log(`🍪 Cookies file found: ${foundPath}`);
      console.log(`📊 Size: ${fileInfo.sizeKB} KB, Format: ${fileInfo.format}`);
      if (fileInfo.entries) {
        console.log(`📝 Cookie entries: ${fileInfo.entries}`);
      }
    } else {
      console.log('⚠️ No cookies file found. Age-restricted videos may not work.');
      console.log('📁 Place cookies.txt in root directory for YouTube authentication.');
    }
  });

  server.on('error', (error) => {
    console.error('❌ Server error:', error);
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use`);
      process.exit(1);
    }
  });

  return server;
};

const initializeApp = () => {
  setupMiddleware();
  setupRoutes();
  setupErrorHandling();
  return startServer();
};

let server;
if (require.main === module) {
  server = initializeApp();
}

module.exports = app;