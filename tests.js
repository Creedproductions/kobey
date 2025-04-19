const { pinterest } = require('ironman-api');

(async () => {
  try {
    const data = await pinterest('https://pin.it/gmumPgDKJ');
    console.log("✅ Pinterest media details:\n", data);
  } catch (error) {
    console.error("❌ Pinterest Error:", error.message || error);
  }
})();
