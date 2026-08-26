// db.js
//
// The member portal's ONLY data store. Uses Neon's serverless HTTP driver
// (no persistent TCP connection to manage, no connection-pool exhaustion
// under Vercel's serverless functions — each query is a single HTTPS
// round-trip). Free tier on Neon covers this workload comfortably.
//
// This is a fully separate database from anything the Discord bot /
// GitHub-as-database system uses. Nothing in api/_lib/store.js (the
// existing club-sites Octokit-based store) is imported here, and nothing
// here is imported there.
//
// Env var required:
//   DATABASE_URL — Neon connection string, e.g.
//     postgresql://user:pass@ep-xxxx.neon.tech/neondb?sslmode=require

const { neon } = require("@neondatabase/serverless");

let _sql = null;

function sql() {
  if (!_sql) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set — the member portal has no database configured.");
    }
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql;
}

module.exports = { sql };
