const express = require('express');
const cors = require('cors');
const { Client } = require('pg');
const config = require('./Config/config');  // Import config file
const downloaderRoutes = require('./Routes/downloaderRoutes'); // Import the routes for downloading media
const notificationRoutes = require('./Routes/notificationRoutes'); // Import the new notification routes
const adminRoutes = require('./Routes/adminRoutes'); // Import the new admin routes
const userRoutes = require('./Routes/userRoutes'); // Import the new user 



const app = express();

// Middleware to parse JSON
app.use(express.json());

// Use CORS middleware to allow requests from specific origins
const corsOptions = {
  origin: ['https://savedownloader.vercel.app'], // Add more origins if needed
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));

// Use routes for downloading media
app.use('/api', downloaderRoutes);

// Use routes for handling push notifications
app.use('/api/notifications', notificationRoutes);  // Add the new notifications route


// Use routes for admin operations
app.use('/api/admin', adminRoutes);  // Add the new admin routes

// Use routes for user operations

app.use('/api/user', userRoutes);  // Add the new user routes

// Set up the connection to NeonDB
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

client.connect()
  .then(() => {
    console.log("Connected to the database successfully!");  // Log success message when connected
  })
  .catch(err => {
    console.error("Error connecting to the database:", err);  // Log an error message if connection fails
  });

// Start the server using the port from the config
app.listen(config.PORT, () => {
  console.log(`Server running on http://localhost:${config.PORT}`);
});
