const btch = require("btch-downloader");

(async () => {
  try {
    const data = await btch.social.pinterest("https://pin.it/4CVodSq");
    console.log("✅ Pinterest media details:\n", data);
  } catch (error) {
    console.error("❌ Pinterest Error:", error.message || error);
  }
})();
