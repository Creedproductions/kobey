const express = require('express');
const cors = require('cors');
const downloaderRoutes = require('./Routes/downloaderRoutes');
const config = require('./Config/config');

// Initialize Express app
const app = express();

// Configuration
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
};

// Middleware setup
const setupMiddleware = () => {
  app.use(express.json());
  app.use(cors(corsOptions));
};

// Routes setup
const setupRoutes = () => {
  // Main API routes
  app.use('/api', downloaderRoutes);

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      environment: NODE_ENV,
      features: ['downloads'],
      database: 'disabled'
    });
  });

  // Root endpoint
  app.get('/', (req, res) => {
    res.status(200).json({
      message: 'Media Downloader API',
      status: 'running',
      endpoints: {
        health: '/health',
        download: '/api/download',
        mockVideos: '/api/mock-videos'
      }
    });
  });
};

// Error handling setup
const setupErrorHandling = () => {
  // Global error handlers
  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    // Don't exit in production
    if (NODE_ENV !== 'production') {
      process.exit(1);
    }
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit in production
  });

  // Graceful shutdown
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

// Server startup
const startServer = () => {
  const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌍 Environment: ${NODE_ENV}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📥 Download API: http://localhost:${PORT}/api/download`);
    console.log(`⚠️ Database features disabled - downloads only`);
  });

  // Handle server errors
  server.on('error', (error) => {
    console.error('❌ Server error:', error);
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use`);
      process.exit(1);
    }
  });

  return server;
};

// Initialize application
const initializeApp = () => {
  setupMiddleware();
  setupRoutes();
  setupErrorHandling();
  return startServer();
};

// Start the application
let server;
if (require.main === module) {
  server = initializeApp();
}

module.exports = app;