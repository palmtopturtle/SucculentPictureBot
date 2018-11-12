const Twit = require("twit"),
  config = require("./config"),
  fs = require("fs"),
  request = require("request"),
  path = require("path");

const REDDIT_API_URL =
    "https://www.reddit.com/r/succulents/.json?limit=25&sort=hot&raw_json=1",
  INTERVAL = 1000 * 60 * 60 * 0.5; //last num = hours

const T = new Twit(config);

const postHistory = [],
  max = 0;

function randomNumber(min, max) {
  return Math.floor(Math.random() * (max - min)) + min;
}

function updatePostHistory(post) {
  if (postHistory.length > 10) postHistory.pop();
  postHistory.unshift(post);
}

function getRandomPost(posts) {
  let num = randomNumber(0, max - 1);
  let newPost = {
    id: posts[num].id,
    url: posts[num].preview ? posts[num].preview.images[0].source.url : false,
    permalink: "https://www.reddit.com" + posts[num].permalink,
    title: posts[num].title,
    author: posts[num].author
  };

  if (newPost.url && !postHistory.some(post => post.id === newPost.id)) {
    console.log("Post found!");
    updatePostHistory(newPost);
  } else {
    console.log("Post invalid, trying again...");
    getRandomPost(posts);
  }
}

function saveImage() {
  let imageSrc = postHistory[0].url;
  let imageFileExt = path.extname(imageSrc);
  let testForArgs = imageFileExt.indexOf("?");
  if (testForArgs) imageFileExt = imageFileExt.substring(0, testForArgs);

  let imageFileName = `succulent${imageFileExt}`;
  let imageFile = fs.createWriteStream(imageFileName);

  console.log("Downloading image...");
  request(imageSrc)
    .pipe(imageFile)
    .on("close", err => {
      if (err) {
        console.log(`Error downloading image!\n${err}`);
      } else {
        console.log("Download successful!");
        uploadImage(postHistory[0], imageFileName);
      }
    });
}

function getImage() {
  request.get(REDDIT_API_URL, (err, res, body) => {
    console.log("Fetching new posts from Reddit...");
    if (err) {
      console.log(`Error getting posts!\n${err}`);
    } else {
      let json = JSON.parse(body);
      max = json.data.dist;
      let posts = json.data.children.map(post => post.data);
      getRandomPost(posts);
      postHistory.length > 0
        ? saveImage()
        : console.log("The postHistory array is somehow empty! Aborting...");
    }
  });
}

function uploadImage(post, imageFileName) {
  let filePath = path.join(__dirname, `../${imageFileName}`);
  console.log(`Uploading image from path "${filePath}"...`);
  T.postMediaChunked({ file_path: filePath }, (err, data, res) => {
    if (err) {
      console.log(`Error uploading image to Twitter!\n${err}`);
    } else {
      console.log("Upload successful!");
      let params = {
        status: `Source: /u/${post.author} [${post.permalink}]`,
        media_ids: [data.media_id_string]
      };
      let meta_params = {
        media_id: data.media_id_string,
        alt_text: { text: post.title }
      };
      createTweet(params, meta_params);
    }
  });
}

function outputIds() {
  postHistory.forEach((post, index) => {
    console.log(`\t[${index}]: ${post.id}`);
  });
}

function createTweet(params, meta_params) {
  T.post("media/metadata/create", meta_params, (err, data, res) => {
    if (err) {
      console.log(`Error creating tweet!\n${err}`);
    } else {
      T.post("statuses/update", params, (err, data, res) => {
        console.log("Successfully created tweet! Process completed.");
        console.log("Current IDs in postHistory array: ");
        outputIds();
        console.log("Awaiting next call...\n-----");
      });
    }
  });
}

getImage();
setInterval(getImage, INTERVAL);
