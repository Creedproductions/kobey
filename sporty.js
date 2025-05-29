const { spotify } = require("nayan-apis-server");

const name = "ghum" //song name

spotify(name).then(data => {
  console.log(data)
 
});