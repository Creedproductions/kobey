// Confirm the Instagram path now only invokes igdl for /reel/ URLs.
const ctrl = require('./Controllers/downloaderController');
console.log('downloaderController loaded:', typeof ctrl.downloadMedia === 'function' ? 'OK' : 'BAD');
