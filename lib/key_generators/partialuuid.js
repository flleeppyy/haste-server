const Crypto = require("node:crypto");

module.exports = class PartialUUIDGenerator {
  createKey() {
    return Crypto.randomUUID().replace(/([a-f0-9]{8}-(?:[a-f0-9]{4}-){3})/i, "");
  }
};
