const { pindl } = require('jer-api');

const url = 'https://pin.it/4CVodSq';

(async () => {
  let data = await pindl(url);
  console.log(data);
})();