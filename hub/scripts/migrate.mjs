import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED / DATABASE_URL not set");
const sql = neon(url);
const ddl = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
for (const stmt of ddl.split(";").map((s) => s.trim()).filter(Boolean)) {
  await sql.query(stmt);
}
console.log("migration ok");
