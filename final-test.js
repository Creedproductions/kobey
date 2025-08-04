const express = require('express');
const { downloadMedia } = require('./Controllers/downloaderController');

const app = express();
app.use(express.json());
app.post('/test', downloadMedia);

const PORT = 3004;
app.listen(PORT, () => {
  console.log(`Final test server running on port ${PORT}`);
});

setTimeout(async () => {
  const testUrl = 'https://x.com/realforexbulls/status/1947588582438539715';
  
  try {
    const axios = require('axios');
    const response = await axios.post(`http://localhost:${PORT}/test`, {
      url: testUrl
    });
    
    console.log('✅ Twitter integration working perfectly!');
    console.log('Response:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('❌ Still having issues:', error.response?.data || error.message);
  }
  
  process.exit(0);
}, 2000);
