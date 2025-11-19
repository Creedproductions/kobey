const express = require('express');
const cors = require('cors');
const downloaderRoutes = require('./Routes/downloaderRoutes');
const config = require('./Config/config');

const app = express();

const PORT = config.PORT || process.env.PORT || 8000;
const NODE_ENV = process.env.NODE_ENV || 'development';

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
  // Increase payload limit for video streaming
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.use(cors(corsOptions));
  
  // Add timeout middleware to prevent hanging requests
  app.use((req, res, next) => {
    // Set longer timeout for merge requests (10 minutes)
    const timeout = req.path.includes('/merge-audio') ? 600000 : 120000;
    
    req.setTimeout(timeout, () => {
      console.log(`⏰ Request timeout for ${req.method} ${req.path}`);
    });
    
    res.setTimeout(timeout, () => {
      console.log(`⏰ Response timeout for ${req.method} ${req.path}`);
      if (!res.headersSent) {
        res.status(408).json({ 
          error: 'Request timeout', 
          message: 'The operation took too long to complete' 
        });
      }
    });
    
    next();
  });

  // Add request logging middleware
  app.use((req, res, next) => {
    const start = Date.now();
    console.log(`📥 ${req.method} ${req.path} - ${req.ip}`);
    
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`📤 ${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
    });
    
    next();
  });
};

const setupRoutes = () => {
  app.use('/api', downloaderRoutes);

  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      environment: NODE_ENV,
      features: ['downloads', 'audio_merge'],
      database: 'disabled',
      uptime: process.uptime()
    });
  });

  app.get('/', (req, res) => {
    res.status(200).json({
      message: 'Media Downloader API',
      status: 'running',
      version: '1.0.0',
      environment: NODE_ENV,
      endpoints: {
        health: '/health',
        download: 'POST /api/download',
        mergeAudio: 'GET /api/merge-audio',
        diagnostics: '/api/diagnostics',
        ffmpegStatus: '/api/ffmpeg-status'
      }
    });
  });

  // 404 handler
  app.use('*', (req, res) => {
    res.status(404).json({
      error: 'Endpoint not found',
      path: req.originalUrl,
      availableEndpoints: {
        download: 'POST /api/download',
        health: 'GET /health'
      }
    });
  });
};

const setupErrorHandling = () => {
  // Global error handler middleware
  app.use((error, req, res, next) => {
    console.error('🚨 Global Error Handler:', error);
    
    // Handle ECONNRESET and stream errors gracefully
    if (error.code === 'ECONNRESET' || error.message.includes('ECONNRESET')) {
      console.log('🔌 Client connection reset during request');
      if (!res.headersSent) {
        return res.status(499).json({ 
          error: 'Client disconnected',
          message: 'The download was interrupted'
        });
      }
      return;
    }
    
    if (error.message.includes('timeout')) {
      return res.status(408).json({
        error: 'Request timeout',
        message: 'The operation took too long to complete'
      });
    }
    
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        message: NODE_ENV === 'development' ? error.message : 'Something went wrong'
      });
    }
  });

  // Process event handlers - PREVENT SERVER CRASHES
  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message);
    console.error('Stack:', error.stack);
    
    // Don't exit in production, just log and continue
    if (NODE_ENV === 'development') {
      process.exit(1);
    }
    // In production, just log the error but keep the process alive
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit the process for unhandled rejections
  });

  process.on('SIGTERM', () => {
    console.log('👋 SIGTERM received, shutting down gracefully');
    if (server) {
      server.close(() => {
        console.log('✅ Server closed gracefully');
        process.exit(0);
      });
      
      // Force close after 10 seconds
      setTimeout(() => {
        console.log('⚠️ Forcing server shutdown');
        process.exit(1);
      }, 10000);
    } else {
      process.exit(0);
    }
  });

  process.on('SIGINT', () => {
    console.log('👋 SIGINT received, shutting down gracefully');
    if (server) {
      server.close(() => {
        console.log('✅ Server closed gracefully');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });
};

const startServer = () => {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌍 Environment: ${NODE_ENV}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📥 Download API: http://localhost:${PORT}/api/download`);
    console.log(`🔧 FFmpeg status: http://localhost:${PORT}/api/ffmpeg-status`);
    
    // Log important configuration
    console.log(`⚙️  CORS enabled for: ${corsOptions.origin.join(', ')}`);
  });

  // Server event handlers
  server.on('error', (error) => {
    console.error('❌ Server error:', error);
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use`);
      process.exit(1);
    }
  });

  server.on('clientError', (err, socket) => {
    console.log('🔌 Client connection error:', err.message);
    // Prevent HTTP parser errors from crashing the server
    if (err.code === 'HPE_INVALID_METHOD') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } else {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  // Graceful shutdown handling
  const gracefulShutdown = () => {
    console.log('🛑 Starting graceful shutdown...');
    server.close((err) => {
      if (err) {
        console.error('❌ Error during shutdown:', err);
        process.exit(1);
      }
      console.log('✅ Server shut down gracefully');
      process.exit(0);
    });
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  return server;
};

const initializeApp = () => {
  console.log('🔧 Initializing Media Downloader API...');
  
  // Log environment info
  console.log(`📋 Environment: ${NODE_ENV}`);
  console.log(`🔑 Port: ${PORT}`);
  console.log(`🐢 Node.js: ${process.version}`);
  
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
