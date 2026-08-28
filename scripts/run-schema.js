// scripts/run-schema.js
//
// Runs db/schema.sql against DATABASE_URL without needing psql installed.
// Safe to re-run — schema.sql uses "create table if not exists" throughout.
//
// Usage:
//   set DATABASE_URL=postgresql://...   (cmd.exe)
//   node scripts/run-schema.js

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("Set DATABASE_URL first.");
    process.exit(1);
  }

  const schemaPath = path.join(__dirname, "..", "db", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");

  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    console.log(`Running ${schemaPath} ...`);
    await client.query(sql);
    console.log("Schema applied successfully.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Failed to apply schema:", err);
  process.exit(1);
});
