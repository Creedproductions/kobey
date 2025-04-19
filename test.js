const { ytdown } = require("shaon-media-downloader");

(async () => {
  try {
    const url = 'https://youtu.be/aRSuyrZFu_Q?si=bsfzgeeGmRpsHqnF';
    const data = await ytdown(url);
    console.log("✅ YouTube media details:\n", data);
  } catch (error) {
    console.error("❌ YouTube Error:", error.message || error);
  }
})();
