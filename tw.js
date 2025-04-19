const { twitterdown } = require("nayan-videos-downloader");

(async () => {
  try {
    const URL = await twitterdown("https://x.com/alema_harold/status/1913598917846979036");
    console.log("✅ YouTube media details:\n", URL);
  } catch (error) {
    console.error("❌ YouTube Error:", error.message || error);
  }
})();
