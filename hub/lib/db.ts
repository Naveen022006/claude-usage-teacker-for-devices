import { neon } from "@neondatabase/serverless";

let sql: ReturnType<typeof neon> | null = null;

/** Lazy init so builds without DATABASE_URL still succeed. */
export function getDb() {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    sql = neon(url);
  }
  return sql;
}
