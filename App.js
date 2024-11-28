const express = require('express');
const cors = require('cors');
const config = require('./Config/config');  // Import config file
const downloaderRoutes = require('./Routes/downloaderRoutes'); // Import the routes for downloading media

const app = express();

// Middleware to parse JSON
app.use(express.json());



// Use CORS middleware to allow requests from specific origins
const corsOptions = {
  origin: config.CORS_ORIGINS.split(','),  // Allow multiple origins from the config
  methods: ['GET', 'POST', 'OPTIONS'],  // Specify allowed methods
  allowedHeaders: ['Content-Type', 'Authorization'], // Add any headers you want to allow
  credentials: true // If you need to support cookies or credentials
};

app.use(cors(corsOptions));

// Use routes for downloading media
app.use('/api', downloaderRoutes);

// Start the server using the port from the config
app.listen(config.PORT, () => {
  console.log(`Server running on http://localhost:${config.PORT}`);
});
