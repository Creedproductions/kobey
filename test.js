const { ndown } = require('shaon-media-downloader');

const fetchInstagramData = async () => {
  try {
    const url = 'https://www.instagram.com/p/ByxKbUSnubS/?utm_source=ig_web_copy_link';

    // Fetch data using igdl
    const data = await ndown(url);

    // Log the JSON response
    console.log('Instagram Data:', data);
  } catch (error) {
    console.error('Error fetching Instagram data:', error.message);
  }
};

// Call the function
fetchInstagramData();
