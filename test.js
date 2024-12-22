const {alldown} = require("shaon-media-downloader");
const url = 'https://youtube.com/shorts/Qb8xyddooxk?si=I5pIucaMafAblNd_' // past url

  alldown(url).then(data => {
  console.log(data)
    });