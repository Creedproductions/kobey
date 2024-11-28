const ytmp3 = require('ytmp3-scrap')

ytmp3('https://youtu.be/XnFOORuOk8I?si=8AWMieC9FfEPZzO-')
  .then((res) => {
    console.log(res)
  })
  .catch((err) => {
    console.log(err)
  })