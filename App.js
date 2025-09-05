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

// Set up the connection to NeonDB
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

client.connect()
  .then(() => {
    console.log("Connected to the database successfully!");
  })
  .catch(err => {
    console.error("Error connecting to the database:", err);
  });

// Start the server using the port from the config
app.listen(config.PORT, () => {
  console.log(`Server running on http://localhost:${config.PORT}`);
});
