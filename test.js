const { threads } = require("shaon-media-downloader");

 const url = "https://www.threads.net/@exclusive_bizz/post/DC6HK6oNcp_?xmt=AQGzzpj5veYoM6LiSxRw1--PwUN1dcmhlARy0xDaWumhoQ" // past url
threads(url).then(data => { 
  console.log(data) 
});