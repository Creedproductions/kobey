const express = require('express');
const { downloadMedia } = require('./Controllers/downloaderController');

const app = express();
app.use(express.json());

app.post('/test', downloadMedia);

const PORT = 3003;
app.listen(PORT, () => {
  console.log(`Debug server running on port ${PORT}`);
});

// Test the Twitter functionality
setTimeout(async () => {
  const testUrl = 'https://x.com/realforexbulls/status/1947588582438539715';
  
  try {
    const axios = require('axios');
    const response = await axios.post(`http://localhost:${PORT}/test`, {
      url: testUrl
    });
    
    console.log('SUCCESS - Twitter test response:');
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('ERROR - Test failed:', error.response?.data || error.message);
  }
  
  process.exit(0);
}, 2000);
