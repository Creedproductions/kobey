// const { threads } = require('tc-media-downloader');

// async function download() {
//   try {
//     const result = await threads('https://www.threads.com/@iamreginaasaba/post/DMdBiMCRYg-?xmt=AQF0TxqEmDX8T8Blyph_YTBtZNON4BCC9hqWAg5ytNnhPw');
//     console.log(result);
//   } catch (error) {
//     console.error('Error:', error.message);
//   }
// }

// download();


// const { threads } = require("tc-media-downloader");

//  const url = "link" // past url
// threads(url).then(data => { 
//   console.log(data) 
// });

// const {alldown} = require("tc-media-downloader");
// const url = 'url' // past url

//   alldown(url).then(data => {
//   console.log(data)
//     });

// const { threads } = require("@neelegirl/downloader");

// const url = "https://threads.net/t/xyz"; // Replace with a valid Threads post URL

// threads(url)
//   .then(data => {
//     console.log("Threads API response:", data);
//   })
//   .catch(error => {
//     console.error("Error fetching Threads data:", error.message);
//   });

// threads("https://threads.net/t/xyz")

// 

// const allDownloader = require("all-downloader");

// async function run() {
//   const result = await allDownloader.parse("https://www.threads.com/@iamreginaasaba/post/DMdBiMCRYg-?xmt=AQF0TxqEmDX8T8Blyph_YTBtZNON4BCC9hqWAg5ytNnhPw");
//   console.log(result);
// }

// run();


// const aryan = require('aryan-videos-downloader');

// aryan.alldown('https://www.threads.com/@iamreginaasaba/post/DMdBiMCRYg-?xmt=AQF0TxqEmDX8T8Blyph_YTBtZNON4BCC9hqWAg5ytNnhPw')
//   .then(data => {
//     console.log(data);
//   })
//   .catch(error => {
//     console.error('Error downloading:', error);
//   });

//   const rakib = require('rakib-videos-downloader');

// rakib.alldown('https://www.threads.com/@iamreginaasaba/post/DMdBiMCRYg-?xmt=AQF0TxqEmDX8T8Blyph_YTBtZNON4BCC9hqWAg5ytNnhPw')
//   .then(data => {
//     console.log(data);
//   })
//   .catch(error => {
//     console.error('Error downloading:', error);
//   });


const { Download } = require("nima-threads-dl-api")

Download('https://www.threads.net/t/Cujx6ryoYx6/?igshid=NTc4MTIwNjQ2YQ==').then((result) => {
console.log(result)
})
  .catch((error) => {
console.log(error)
})