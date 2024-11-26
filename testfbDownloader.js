const twitter = require("x-scrapper").Twitter
   
twitter.getVideoInfo("https://x.com/galaxyfmug/status/1859888110143988138?s=46") // returns a Promise
.then((res) => {
   console.log(res) // Video info.
   console.log(res.media.formats[0].url) // Get the video .mp4 url (you can download it.)
})