const facebookInsta = require('./Services/facebookInstaService');

// Test that the module loads and that one of the failing URLs is at least
// parseable to a canonical candidate list, then attempt download (will
// network-call out). We give it 30s and print the result/error.
const url = process.argv[2] || 'https://www.facebook.com/share/v/18oDA38nwB/';
console.log('Testing FB downloader against:', url);

const timeout = setTimeout(() => {
  console.error('TIMEOUT: 35s elapsed');
  process.exit(2);
}, 35000);

facebookInsta(url, {})
  .then(d => {
    clearTimeout(timeout);
    console.log('SUCCESS:', JSON.stringify(d, null, 2).slice(0, 500));
    process.exit(0);
  })
  .catch(e => {
    clearTimeout(timeout);
    console.error('ERROR:', e.message.slice(0, 400));
    process.exit(1);
  });
