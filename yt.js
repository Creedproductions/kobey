const { ytdl } = require('jer-api');

const url = 'https://youtu.be/aRSuyrZFu_Q?si=bsfzgeeGmRpsHqnF';

(async () => {
  let data = await ytdl(url);
  console.log(data);
})();