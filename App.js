const express = require('express');
const cors = require('cors');
const downloaderRoutes = require('./Routes/downloaderRoutes');
const config = require('./Config/config');

const app = express();

const PORT = config.PORT || process.env.PORT || 8000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// CORS configuration
const corsOptions = {
  origin: [
    'https://savedownloader.vercel.app',
    'https://savedownloaderweb.vercel.app',
    'http://localhost:5173'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

const setupMiddleware = () => {
  // Increase payload size limit for large requests
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  
  app.use(cors(corsOptions));
  
  // Request logging in development
  if (NODE_ENV === 'development') {
    app.use((req, res, next) => {
      console.log(`${req.method} ${req.path}`);
      next();
    });
  }
  
  // Set timeout for all requests (important for video merging)
  app.use((req, res, next) => {
    // Increase timeout to 5 minutes for merge operations
    req.setTimeout(300000); // 5 minutes
    res.setTimeout(300000); // 5 minutes
    next();
  });
};

const setupRoutes = () => {
  // API routes
  app.use('/api', downloaderRoutes);

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      environment: NODE_ENV,
      features: ['downloads', 'audio_merging', 'ffmpeg'],
      database: 'disabled',
      uptime: process.uptime()
    });
  });

  // Root endpoint
  app.get('/', (req, res) => {
    res.status(200).json({
      message: 'Media Downloader API',
      status: 'running',
      version: '2.0.0',
      endpoints: {
        health: '/health',
        download: 'POST /api/download',
        mergeAudio: 'GET /api/merge-audio?videoUrl=&audioUrl=',
        ffmpegStatus: 'GET /api/ffmpeg-status',
        systemInfo: 'GET /api/system-info',
        mockVideos: 'GET /api/mock-videos',
        test: 'GET /api/test'
      },
      features: {
        platforms: ['instagram', 'tiktok', 'facebook', 'twitter', 'youtube', 'pinterest', 'threads', 'linkedin'],
        audioMerging: true,
        multipleQualities: true,
        ffmpegIntegration: true
      }
    });
  });

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({
      error: 'Endpoint not found',
      path: req.path,
      method: req.method,
      availableEndpoints: {
        root: 'GET /',
        health: 'GET /health',
        api: 'GET /api/test'
      }
    });
  });

  // Global error handler
  app.use((err, req, res, next) => {
    console.error('❌ Global error handler:', err);
    
    if (!res.headersSent) {
      res.status(err.status || 500).json({
        error: 'Internal server error',
        message: NODE_ENV === 'development' ? err.message : 'Something went wrong',
        path: req.path,
        timestamp: new Date().toISOString()
      });
    }
  });
};

// Store server instance globally for cleanup
let server;

const setupErrorHandling = () => {
  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    console.error('Stack:', error.stack);
    
    if (NODE_ENV === 'production') {
      // Log and continue in production
      console.error('⚠️ Continuing despite uncaught exception');
    } else {
      // Exit in development to catch bugs
      process.exit(1);
    }
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise);
    console.error('Reason:', reason);
  });

  process.on('SIGTERM', () => {
    console.log('👋 SIGTERM received, shutting down gracefully');
    gracefulShutdown();
  });

  process.on('SIGINT', () => {
    console.log('👋 SIGINT received, shutting down gracefully');
    gracefulShutdown();
  });
};

const gracefulShutdown = () => {
  if (server) {
    console.log('🛑 Closing server...');
    server.close(() => {
      console.log('✅ Server closed successfully');
      process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
      console.error('⚠️ Forcing shutdown after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
};

const startServer = () => {
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌍 Environment: ${NODE_ENV}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📥 Download API: http://localhost:${PORT}/api/download`);
    console.log(`🎬 Merge Audio: http://localhost:${PORT}/api/merge-audio`);
    console.log(`🔧 FFmpeg Status: http://localhost:${PORT}/api/ffmpeg-status`);
    console.log(`⏰ Request timeout: 5 minutes`);
  });

  // Increase server timeout for long-running operations
  server.timeout = 300000; // 5 minutes
  server.keepAliveTimeout = 310000; // Slightly higher than timeout
  server.headersTimeout = 320000; // Slightly higher than keepAliveTimeout

  server.on('error', (error) => {
    console.error('❌ Server error:', error);
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use`);
      process.exit(1);
    }
  });

  // Handle server timeout
  server.on('timeout', (socket) => {
    console.warn('⚠️ Server timeout occurred');
    socket.destroy();
  });

  return server;
};

const initializeApp = () => {
  console.log('🔧 Initializing application...');
  setupMiddleware();
  setupRoutes();
  setupErrorHandling();
  return startServer();
};

// Start server only if this file is run directly
if (require.main === module) {
  server = initializeApp();
}

module.exports = app;
