const Twit = require("twit"),
  config = require("./config"),
  fs = require("fs"),
  request = require("request"),
  path = require("path"),
  redis = require("redis");

const REDDIT_API_URL =
    "https://www.reddit.com/r/succulents/.json?limit=25&sort=hot&raw_json=1",
  INTERVAL = 1000 * 60 * 60 * 6, //last num = hours
  MINIMUM_INTERVAL = 1000 * 60 * 15; //last num = minutes

const T = new Twit(config),
  client = redis.createClient();

let max = 0,
  botProfileParams = {
    user_id: 1061368238360141824,
    count: 1
  };

client.on("connect", () => console.log("Connected to Redis!"));
client.on("error", err => console.log(`Error connecting to Redis...\n${err}`));

/**
 * Due to how Glitch hosting works, this checks to make sure that the most recent tweet wasn't created within the minimum time interval.
 * Without this check, two tweets may sometimes be posted within minutes of each other.
 */
function checkRecentTweet() {
  return new Promise((resolve, reject) => {
    console.log("Checking most recent tweet...");
    T.get("statuses/user_timeline", botProfileParams, (err, data, res) => {
      if (err) {
        reject(err);
      } else {
        let tweetDate = new Date(Date.parse(data[0].created_at)),
          currentDate = new Date();

        let difference = currentDate - tweetDate;
        if (difference <= MINIMUM_INTERVAL) {
          console.log("Passed minimum interval check! Starting process.");
          resolve();
        } else {
          console.log("Tweet detected within minimum interval. Aborting...");
          reject();
        }
      }
    });
  });
}

/**
 * Makes a call to the Reddit API and returns an array of posts.
 */
function getRedditPosts() {
  return new Promise((resolve, reject) => {
    console.log("Fetching posts from Reddit...");
    request.get(REDDIT_API_URL, (err, res, body) => {
      if (err) {
        reject(err);
      } else {
        let json = JSON.parse(body);
        max = json.data.dist;
        let posts = json.data.children.map(post => post.data);
        console.log("Success! Checking for valid post...");
        resolve(posts);
      }
    });
  });
}

/**
 * Checks to see if the current ID already exists in the database.
 * @param {number} id
 */
function checkId(id) {
  return new Promise((resolve, reject) => {
    client.exists(id, (err, res) => {
      if (err) {
        reject(err);
      } else {
        resolve(res);
      }
    });
  });
}

/**
 * Checks to see if a post is valid, as in:
 * * The ID is unique and hasn't been used already
 * * A preview exists for it
 * * It does not include the word "help" in its title
 * * It does not feature the "help" tag
 * @param {array} posts
 */
function validatePost(posts) {
  return new Promise((resolve, reject) => {
    let newPost = getRandomPost(posts);
    checkId(newPost.id)
      .then(res => {
        if (
          newPost.url &&
          !res &&
          !newPost.title.toLowerCase().includes("help") &&
          newPost.tag !== "Help"
        ) {
          console.log("Post found!");
          client.set(newPost.id, newPost.id, "EX", 172800); //Expires after 48 hours
          resolve(newPost);
        } else {
          console.log("Post invalid, trying again...");
          resolve(validatePost(posts));
        }
      })
      .catch(err => reject(err));
  });
}

/**
 * Downloads a high quality version of the image from the post.
 * @param {object} post
 */
function downloadImage(post) {
  return new Promise((resolve, reject) => {
    console.log("Downloading image...");
    let fileExt = path.extname(post.url);
    let testForArgs = fileExt.indexOf("?");
    if (testForArgs) fileExt = fileExt.substring(0, testForArgs);
    let fileName = `succulent${fileExt}`;
    let file = fs.createWriteStream(fileName);
    request(post.url)
      .pipe(file)
      .on("close", err => {
        if (err) {
          reject(err);
        } else {
          console.log("Download complete!");
          resolve({ post: post, image: fileName });
        }
      });
  });
}

/**
 * Uploads the image to Twitter and creates the parameters (tweet data) associated with it.
 * @param {object} postData
 */
function uploadImage(postData) {
  return new Promise((resolve, reject) => {
    console.log("Uploading image to Twitter...");
    let filePath = path.join(__dirname, `../${postData.image}`);
    T.postMediaChunked({ file_path: filePath }, (err, data, res) => {
      if (err) {
        reject(err);
      } else {
        console.log("Upload successful!");
        let params = {
            status: `Source: /u/${postData.post.author} [${
              postData.post.permalink
            }]`,
            media_ids: [data.media_id_string]
          },
          meta_params = {
            media_id: data.media_id_string,
            alt_text: { text: postData.post.title }
          };
        resolve({ params: params, meta_params: meta_params });
      }
    });
  });
}

/**
 * Posts the meta data and tweet content to Twitter.
 * @param {object} media
 */
function createTweet(media) {
  return new Promise((resolve, reject) => {
    T.post("media/metadata/create", media.meta_params, (err, data, res) => {
      if (err) {
        reject(err);
      } else {
        T.post("statuses/update", media.params, (err, data, res) => {
          console.log("Successfully posted tweet!");
          resolve();
        });
      }
    });
  });
}

/**
 * If all promises are resolved, outputs useful statistics.
 */
function outputSuccess() {
  return new Promise((resolve, reject) => {
    client.dbsize((err, res) => {
      if (err) {
        reject(err);
      } else {
        console.log(`Number of post IDs in database: ${res}`);
        console.log("Process completed, awaiting next call...\n-------------");
      }
    });
  });
}

/**
 * Utility function that randomly chooses a post.
 * @param {array} posts
 */
function getRandomPost(posts) {
  let num = Math.floor(Math.random() * (max - 1));
  let newPost = {
    id: posts[num].id,
    url: posts[num].preview ? posts[num].preview.images[0].source.url : false,
    permalink: "https://www.reddit.com" + posts[num].permalink,
    title: posts[num].title,
    author: posts[num].author,
    tag: posts[num].link_flair_text
  };
  return newPost;
}

/**
 * Promise chain that goes through the whole process, from calling the Reddit API to actually posting the tweet.
 */
function beginProcess() {
  checkRecentTweet()
    .then(() => getRedditPosts())
    .then(posts => validatePost(posts))
    .then(post => downloadImage(post))
    .then(data => uploadImage(data))
    .then(media => createTweet(media))
    .then(() => outputSuccess())
    .catch(err => console.log(err));
}

beginProcess();
setInterval(beginProcess, INTERVAL);
