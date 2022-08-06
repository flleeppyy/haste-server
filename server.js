// @ts-check
const http = require("http");
const fs = require("fs");

const uglify = require("uglify-js");
const winston = require("winston");
const connect = require("connect");
const route = require("connect-route");
const connect_st = require("st");
const connect_rate_limit = require("connect-ratelimit");

const DocumentHandler = require("./lib/document_handler");

// Load the configuration and set some defaults
const configPath = process.argv.length <= 2 ? "config.js" : process.argv[2];
const config = eval(fs.readFileSync(configPath, "utf8"));
config.port = process.env.PORT - 0 || config.port || 7777;
config.host = process.env.HOST || config.host || "localhost";

if (isNaN(config.port)) {
  throw new Error("Port is not a number");
}

// Set up the logger
if (config.logging) {
  try {
    winston.remove(winston.transports.Console);
  } catch (e) {
    /* was not present */
  }

  let detail, type;
  for (let i = 0; i < config.logging.length; i++) {
    detail = config.logging[i];
    // weird error shananigans
    if (detail.type == null) {
      detail.type = "console";
    }
    type = detail.type;
    delete detail.type;
    winston.add(winston.transports[type], detail);
  }
}

// build the store from the config on-demand - so that we don't load it
// for statics
if (!config.storage) {
  config.storage = { type: "file" };
}
if (!config.storage.type) {
  config.storage.type = "file";
}

let Store, preferredStore;

if (process.env.REDISTOGO_URL && config.storage.type === "redis") {
  const redisClient = require("redis-url").connect(process.env.REDISTOGO_URL);
  Store = require("./lib/document_stores/redis");
  preferredStore = new Store(config.storage, redisClient);
} else {
  Store = require("./lib/document_stores/" + config.storage.type);
  preferredStore = new Store(config.storage);
}

// Compress the static javascript assets
if (config.recompressStaticAssets) {
  const list = fs.readdirSync("./static");
  for (let j = 0; j < list.length; j++) {
    const item = list[j];
    if (item.indexOf(".js") === item.length - 3 && item.indexOf(".min.js") === -1) {
      const dest = item.substring(0, item.length - 3) + ".min" + item.substring(item.length - 3);
      const orig_code = fs.readFileSync("./static/" + item, "utf8");

      const uglifyResult = uglify.minify(orig_code);

      if (uglifyResult.error) {
        throw uglifyResult.error;
      }

      fs.writeFileSync("./static/" + dest, uglifyResult.code, "utf8");
      winston.info("compressed " + item + " into " + dest);
    }
  }
}

// Send the static documents into the preferred store, skipping expirations
let path, data;
for (const name in config.documents) {
  path = config.documents[name];
  data = fs.readFileSync(path, "utf8");
  winston.info("loading static document", { name: name, path: path });
  if (data) {
    preferredStore.set(
      name,
      data,
      function (cb) {
        winston.debug("loaded static document", { success: cb });
      },
      true
    );
  } else {
    winston.warn("failed to load static document", { name: name, path: path });
  }
}

// Pick up a key generator
const pwOptions = config.keyGenerator || {};
pwOptions.type = pwOptions.type || "random";
const gen = require("./lib/key_generators/" + pwOptions.type);
const keyGenerator = new gen(pwOptions);

// Configure the document handler
const documentHandler = new DocumentHandler({
  store: preferredStore,
  maxLength: config.maxLength,
  keyLength: config.keyLength,
  keyGenerator: keyGenerator
});

const app = connect();

// Rate limit all requests
if (config.rateLimits) {
  config.rateLimits.end = true;
  app.use(connect_rate_limit(config.rateLimits));
}

// first look at API calls
app.use(
  route(function (router) {
    // get raw documents - support getting with extension

    router.get("/raw/:id", function (request, response) {
      return documentHandler.handleRawGet(request, response, config);
    });

    router.head("/raw/:id", function (request, response) {
      return documentHandler.handleRawGet(request, response, config);
    });

    // add documents

    router.post("/documents", function (request, response) {
      return documentHandler.handlePost(request, response);
    });

    // get documents
    router.get("/documents/:id", function (request, response) {
      return documentHandler.handleGet(request, response, config);
    });

    router.head("/documents/:id", function (request, response) {
      return documentHandler.handleGet(request, response, config);
    });
  })
);

// Otherwise, try to match static files
app.use(
  connect_st({
    path: __dirname + "/static",
    content: { maxAge: config.staticMaxAge },
    passthrough: true,
    index: false
  })
);

// Then we can loop back - and everything else should be a token,
// so route it back to /
app.use(
  route(function (router) {
    router.get("/:id", function (request, response, next) {
      request.sturl = "/";
      next();
    });
  })
);

// And match index
app.use(
  connect_st({
    path: __dirname + "/static",
    content: { maxAge: config.staticMaxAge },
    index: "index.html"
  })
);

http.createServer(app).listen(config.port, config.host);

winston.info("listening on " + config.host + ":" + config.port);
