const {alldown} = require("nayan-videos-downloader");

const fetchInstagramData = async () => {
  try {
   const url = 'https://www.instagram.com/reel/C61DYyFtN9Z/?utm_source=ig_web_copy_link&igsh=MzRlODBiNWFlZA=='

    // Fetch data using igdl
    const data = await alldown(url);

    // Log the JSON response
    console.log('Instagram Data:', data);
  } catch (error) {
    console.error('Error fetching Instagram data:', error.message);
  }
};

// Call the function
fetchInstagramData();
