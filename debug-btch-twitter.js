const { twitter } = require('btch-downloader');

async function debugBtchTwitter() {
  const url = 'https://x.com/realforexbulls/status/1947588582438539715';
  
  console.log('Testing btch-downloader twitter...');
  try {
    const result = await twitter(url);
    console.log('btch-downloader result:');
    console.log(JSON.stringify(result, null, 2));
    console.log('Type:', typeof result);
    console.log('Has data property:', !!result.data);
    if (result.data) {
      console.log('data.HD:', !!result.data.HD);
      console.log('data.SD:', !!result.data.SD);
    }
    console.log('Has url property:', !!result.url);
    if (result.url) {
      console.log('url is array:', Array.isArray(result.url));
      console.log('url length:', result.url?.length);
    }
  } catch (error) {
    console.error('btch-downloader error:', error.message);
  }
}

debugBtchTwitter();
