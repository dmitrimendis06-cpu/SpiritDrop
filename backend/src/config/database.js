const mysql = require("mysql2/promise");

const REQUIRED_VARS = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"];

let pool;

/** Names (never values) of required database variables that are not set. */
function missingDbVars() {
  return REQUIRED_VARS.filter((name) => !process.env[name]);
}

/**
 * The one shared connection pool, created on first use so the API can still
 * start and answer /health when the database is not configured.
 * Throws if any required variable is missing.
 */
function getPool() {
  if (!pool) {
    const missing = missingDbVars();
    if (missing.length > 0) {
      throw new Error(`Database is not configured. Missing: ${missing.join(", ")}`);
    }
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      connectionLimit: 5,
      waitForConnections: true,
      queueLimit: 20,
      connectTimeout: 5000,
      enableKeepAlive: true,
    });
  }
  return pool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = { getPool, closePool, missingDbVars };
