// App.js
const express = require('express');
const cors = require('cors');
const downloaderRoutes = require('./Routes/downloaderRoutes');
const config = require('./Config/config');

// Initialize Express app
const app = express();
app.set('trust proxy', 1);

// Configuration — always prefer Render's injected port
const PORT = process.env.PORT || config.PORT || 8000;
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
  app.use(express.json({ limit: '5mb' }));
  app.use(cors(corsOptions));
};

// Routes setup
const setupRoutes = () => {
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

let server; // so we can reference in signal handlers

// Error handling setup
const setupErrorHandling = () => {
  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    if (NODE_ENV !== 'production') process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  });

  const graceful = (signal) => {
    console.log(`👋 ${signal} received, shutting down gracefully`);
    if (server) {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    } else {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => graceful('SIGTERM'));
  process.on('SIGINT', () => graceful('SIGINT'));
};

// Server startup
const startServer = () => {
  const host = '0.0.0.0';
  server = app.listen(PORT, host, () => {
    console.log(`🚀 Server running on http://${host}:${PORT}`);
    console.log(`🌍 Environment: ${NODE_ENV}`);
    console.log(`📊 Health check: http://${host}:${PORT}/health`);
    console.log(`📥 Download API: http://${host}:${PORT}/api/download`);
    console.log(`⚠️ Database features disabled - downloads only`);
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

// Initialize application
const initializeApp = () => {
  setupMiddleware();
  setupRoutes();
  setupErrorHandling();
  return startServer();
};

// If run directly, start server
if (require.main === module) {
  initializeApp();
}

// Export for index.js
module.exports = { app, initializeApp };
