const mysql = require("mysql2/promise");

const REQUIRED_VARS = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"];

// Applied to every connection, whatever the server's own defaults are.
// time_zone: DATETIME columns store UTC, and CURRENT_TIMESTAMP follows this setting.
// sql_mode: strict, so bad data is rejected rather than silently truncated or changed.
const SESSION_SETUP_SQL =
  "SET time_zone = '+00:00', " +
  "sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'";

let pool;

/** Names (never values) of required database variables that are not set. */
function missingDbVars() {
  return REQUIRED_VARS.filter((name) => !process.env[name]);
}

/**
 * Runs the session setup on a new connection. A connection that can't be set up
 * is destroyed, so nothing can use it with the wrong time zone or a lax SQL mode.
 */
function applySessionSetup(connection) {
  connection.query(SESSION_SETUP_SQL, (err) => {
    if (err) {
      console.error("Database session setup failed:", err.code || "UNKNOWN");
      connection.destroy();
    }
  });
}

/**
 * Creates a pool with SpiritDrop's connection rules. mysql2 emits "connection"
 * before handing a new connection to any caller, and a connection runs commands
 * in order, so the session setup always runs before the first query.
 */
function createDbPool(config) {
  const newPool = mysql.createPool({
    ...config,
    connectionLimit: 5,
    waitForConnections: true,
    queueLimit: 20,
    connectTimeout: 5000,
    enableKeepAlive: true,
    // Read DATETIME as UTC. Keep DATE as 'YYYY-MM-DD' so event dates can't shift a day.
    timezone: "Z",
    dateStrings: ["DATE"],
  });
  newPool.pool.on("connection", applySessionSetup);
  return newPool;
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
    pool = createDbPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
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

module.exports = { getPool, closePool, missingDbVars, createDbPool, applySessionSetup, SESSION_SETUP_SQL };
