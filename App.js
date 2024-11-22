// app.js
const express = require('express');
const app = express();
const downloaderRoutes = require('./Routes/downloaderRoutes');

// Middleware to parse JSON
app.use(express.json());

// Use routes
app.use('/api', downloaderRoutes);

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
