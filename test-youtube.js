const { fetchYouTubeData } = require('./Services/youtubeService');

async function testYouTube() {
  try {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'; // Rick Roll test URL
    const result = await fetchYouTubeData(url);
    console.log('YouTube API Response:');
    console.log(JSON.stringify(result, null, 2));
    
    if (result.formats && result.formats.length > 0) {
      console.log('\nFirst format details:');
      console.log(JSON.stringify(result.formats[0], null, 2));
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testYouTube();
