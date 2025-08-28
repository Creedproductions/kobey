const { ndown } = require("nayan-videos-downloader");

(async () => {
  try {
    const URL = await ndown("https://www.facebook.com/100000959749712/posts/pfbid0288xi44nvodK9d7r3wf4LHeM3dtEsVghQXmz5t59axwz7KdLStYyg4qfvTVrAL27Ll/?app=fbl");
    console.log("✅ Facebook media details:\n", URL);
  } catch (error) {
    console.error("❌ Facebook Error:", error.message || error);
  }
})();
