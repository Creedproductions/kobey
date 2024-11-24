const express = require('express');
const cors = require('cors');  // Importing the CORS package
const app = express();
const downloaderRoutes = require('./Routes/downloaderRoutes');

// Middleware to parse JSON
app.use(express.json());

// Use CORS middleware to allow requests from specific origins
app.use(cors({
  origin: 'http://127.0.0.1:5500'  // Allow only requests from this origin (adjust as needed)
}));

// Use routes
app.use('/api', downloaderRoutes);

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
