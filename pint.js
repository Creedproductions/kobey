const { pintarest } = require("nayan-videos-downloader");

(async () => {
  try {
    const URL = await pintarest("https://pin.it/gmumPgDKJl");
    console.log("✅ pinterest details:\n", URL);
  } catch (error) {
    console.error("❌ Facebook Error:", error.message || error);
  }
})();
