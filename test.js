const { facebook } = require('@mrnima/facebook-downloader')

const fetchInstagramData = async () => {
  try {
   const url = 'https://www.facebook.com/share/v/1AQRQzYXTi/?mibextid=nvWvQA'

    // Fetch data using igdl
    const data = await facebook(url);

    // Log the JSON response
    console.log('Instagram Data:', data);
  } catch (error) {
    console.error('Error fetching Instagram data:', error.message);
  }
};

// Call the function
fetchInstagramData();
