const { ytdown } = require("nayan-videos-downloader");

(async () => {
  try {
    const URL = await ytdown("https://youtu.be/aRSuyrZFu_Q?si=bsfzgeeGmRpsHqnF");
    console.log("✅ YouTube media details:\n", URL);
  } catch (error) {
    console.error("❌ YouTube Error:", error.message || error);
  }
})();
