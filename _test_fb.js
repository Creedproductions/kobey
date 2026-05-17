const facebookInsta = require('./Services/facebookInstaService');
const url = process.argv[2];
const t0 = Date.now();
console.log('Testing FB downloader against:', url);
const timeout = setTimeout(() => { console.error('TIMEOUT after', Date.now()-t0, 'ms'); process.exit(2); }, 60000);
facebookInsta(url, {})
  .then(d => { clearTimeout(timeout); console.log('SUCCESS in', Date.now()-t0, 'ms:', JSON.stringify(d).slice(0, 200)); process.exit(0); })
  .catch(e => { clearTimeout(timeout); console.error('ERROR after', Date.now()-t0, 'ms:', e.message.slice(0, 300)); process.exit(1); });
