#!/usr/bin/env node
"use strict";

const { scryptSync, randomBytes } = require("crypto");
const path = require("path");
const pgPath = require.resolve("pg", { paths: [path.join(__dirname, "..", "lib", "db")] });
const { Client } = require(pgPath);

const CEO_USERNAME = "ibaiceo";
const NEW_PASSWORD = process.argv[2] || "ibaiceo";

async function main() {
  const salt   = randomBytes(16).toString("hex");
  const hash   = scryptSync(NEW_PASSWORD, salt, 64).toString("hex");
  const stored = `${salt}:${hash}`;

  console.log(`Resetting CEO password for "${CEO_USERNAME}"...`);

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const r = await client.query(
    "UPDATE users SET password_hash = $1 WHERE username = $2 RETURNING id, username, role",
    [stored, CEO_USERNAME],
  );
  await client.end();

  if (r.rowCount === 0) {
    console.error("No rows updated — CEO user not found in DB");
    process.exit(1);
  }

  console.log(`✔ CEO password reset  id=${r.rows[0].id}  role=${r.rows[0].role}`);
  console.log(`  New hash prefix: ${stored.substring(0, 24)}...`);
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
