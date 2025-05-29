const { pinterest } = require('btch-downloader')

const url = 'https://pin.it/4CVodSq'
pinterest(url).then(data => console.log(data)).catch(err => console.error(err)); // JSON

// Using a search query
pinterest('Zhao Lusi')
  .then(data => console.log(data))
  .catch(err => console.error(err)); //JSON