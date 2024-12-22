const { alldl } = require('imran-dlmedia');

const url = 'https://youtu.be/l3zvl_yDX4M?si=3Rdx0kY6t_Jbsb-k'; //past video link

alldl(url)
  .then(data => {
    console.log(data);
  })
  .catch(error => {
    console.error('Error:', error.message);
  });