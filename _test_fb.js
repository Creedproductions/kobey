const facebookInsta = require('./Services/facebookInstaService');
const url = process.argv[2];
console.log('Testing FB downloader against:', url);
const timeout = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 30000);
facebookInsta(url, {})
  .then(d => { clearTimeout(timeout); console.log('SUCCESS:', JSON.stringify(d).slice(0, 400)); process.exit(0); })
  .catch(e => { clearTimeout(timeout); console.error('ERROR:', e.message.slice(0, 400)); process.exit(1); });
