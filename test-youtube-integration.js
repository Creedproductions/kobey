const express = require('express');
const { downloadMedia } = require('./Controllers/downloaderController');

const app = express();
app.use(express.json());

// Test endpoint
app.post('/test-youtube', downloadMedia);

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Test server running on port ${PORT}`);
});

// Test the YouTube functionality
setTimeout(async () => {
  const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  
  try {
    const axios = require('axios');
    const response = await axios.post(`http://localhost:${PORT}/test-youtube`, {
      url: testUrl
    });
    
    console.log('YouTube test response:');
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('Test failed:', error.response?.data || error.message);
  }
  
  process.exit(0);
}, 2000);
