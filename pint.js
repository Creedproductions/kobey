const { pinterestDownloader } = require("happy-dl");

async function fetchPinterestData() {
  try {
    const result = await pinterestDownloader(
      "https://in.pinterest.com/pin/37858453112938677/"
    );
    console.log("Fetched Pinterest media details:", result);
  } catch (error) {
    console.error("Error fetching Pinterest media details:", error.message || error);
  }
}

fetchPinterestData();
