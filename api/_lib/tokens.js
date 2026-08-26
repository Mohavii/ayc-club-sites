// tokens.js — high-entropy random tokens + hashing for anything stored
// server-side (sessions, OAuth state, signup tokens). We only ever store
// the SHA-256 hash of a token in the database; the raw token exists only
// in the user's cookie. A database read alone can never be replayed as a
// valid session/token.

const crypto = require("crypto");

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken, "utf8").digest("hex");
}

module.exports = { randomToken, hashToken };
