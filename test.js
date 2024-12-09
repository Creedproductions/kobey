const { alldl } = require('imran-dlmedia');

const url = 'https://youtu.be/XnFOORuOk8I?si=VZIZ6UXtL1vTA5V9'; //past video link

alldl(url)
  .then(data => {
    console.log(data);
  })
  .catch(error => {
    console.error('Error:', error.message);
  });