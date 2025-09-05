const express = require('express');
const cors = require('cors');
const { Client } = require('pg');
const config = require('./Config/config');
const downloaderRoutes = require('./Routes/downloaderRoutes');
const notificationRoutes = require('./Routes/notificationRoutes');
const adminRoutes = require('./Routes/adminRoutes');
const userRoutes = require('./Routes/userRoutes');

const app = express();

// Middleware to parse JSON
app.use(express.json());

// Use CORS middleware to allow requests from specific origins
const corsOptions = {
  origin: ['https://savedownloader.vercel.app','https://savedownloaderweb.vercel.app','http://localhost:5173'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));

// Use routes for downloading media
app.use('/api', downloaderRoutes);

// Use routes for handling push notifications
app.use('/api/notifications', notificationRoutes);

// Use routes for admin operations
app.use('/api/admin', adminRoutes);

// Use routes for user operations
app.use('/api/user', userRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Environment variable validation
if (!process.env.DATABASE_URL) {
  console.error("❌ CRITICAL ERROR: DATABASE_URL environment variable is not set!");
  console.error("Please set your NeonDB connection string in the environment variables.");
  // Don't exit in production - let the app start but log the error
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
} else {
  console.log("✅ Database URL configured");
}

// Set up the connection to NeonDB with better error handling
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  // Add connection timeout
  connectionTimeoutMillis: 10000,
});

// Enhanced database connection with retry logic
async function connectToDatabase() {
  let retries = 3;
  while (retries > 0) {
    try {
      await client.connect();
      console.log("✅ Connected to the database successfully!");

      // Test the connection
      const result = await client.query('SELECT NOW()');
      console.log("✅ Database connection tested successfully at:", result.rows[0].now);
      return;
    } catch (err) {
      console.error(`❌ Database connection attempt failed (${4 - retries}/3):`, err.message);
      retries--;

      if (retries === 0) {
        console.error("❌ Failed to connect to database after 3 attempts");
        console.error("⚠️  Server will continue without database connection");
        console.error("⚠️  Some features may not work properly");
        return;
      }

      // Wait 2 seconds before retry
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  // Don't exit in production
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit in production
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('👋 SIGTERM received, shutting down gracefully');
  try {
    await client.end();
    console.log('✅ Database connection closed');
  } catch (err) {
    console.error('❌ Error closing database connection:', err);
  }
  process.exit(0);
});

// Start database connection
connectToDatabase();

// Start the server using the port from the config
const PORT = config.PORT || process.env.PORT || 8000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 Health check available at: http://localhost:${PORT}/health`);
});

// Handle server errors
server.on('error', (error) => {
  console.error('❌ Server error:', error);
});

module.exports = app;