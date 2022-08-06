const Crypto = require("node:crypto");

module.exports = class UUIDGenerator {
  createKey() {
    // Apparently using regex is faster than, doing .replace("-","") lmao
    return Crypto.randomUUID().replace(/-/g, "");
  }
};
