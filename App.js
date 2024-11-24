const express = require('express');
const cors = require('cors');
const config = require('./Config/config');  // Import config file
const downloaderRoutes = require('./Routes/downloaderRoutes');

const app = express();

// Middleware to parse JSON
app.use(express.json());

// Use CORS middleware to allow requests from specific origins
app.use(cors({
  origin: config.CORS_ORIGINS  // Use the CORS origin from the config
}));

// Use routes
app.use('/api', downloaderRoutes);

// Start the server using the port from the config
app.listen(config.PORT, () => {
  console.log(`Server running on http://localhost:${config.PORT}`);
});
