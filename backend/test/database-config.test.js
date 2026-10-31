// Connection rules that can be checked without a database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applySessionSetup, createDbPool, SESSION_SETUP_SQL } = require("../src/config/database");

test("session setup asks for UTC and strict SQL mode", () => {
  assert.match(SESSION_SETUP_SQL, /time_zone = '\+00:00'/);
  assert.match(SESSION_SETUP_SQL, /sql_mode = '[^']*STRICT_TRANS_TABLES/);
  assert.match(SESSION_SETUP_SQL, /NO_ZERO_DATE/);
});

test("a connection that fails session setup is destroyed", (t) => {
  t.mock.method(console, "error", () => {});
  let destroyed = false;
  applySessionSetup({
    query: (sql, cb) => cb(Object.assign(new Error("failed for user 'someone'"), { code: "ER_TEST" })),
    destroy: () => { destroyed = true; },
  });
  assert.equal(destroyed, true);
  const logged = console.error.mock.calls.flatMap((c) => c.arguments).join(" ");
  assert.equal(logged.includes("someone"), false, "logs must not repeat the raw error message");
});

test("a connection that passes session setup is kept", () => {
  let destroyed = false;
  applySessionSetup({ query: (sql, cb) => cb(null), destroy: () => { destroyed = true; } });
  assert.equal(destroyed, false);
});

test("every new pool connection gets the session setup, with UTC dates", async () => {
  const pool = createDbPool({ host: "127.0.0.1", port: 1, database: "x", user: "x", password: "x" });
  try {
    assert.ok(pool.pool.listeners("connection").includes(applySessionSetup));
    assert.equal(pool.pool.config.connectionConfig.timezone, "Z");
    assert.deepEqual(pool.pool.config.connectionConfig.dateStrings, ["DATE"]);
    assert.equal(pool.pool.config.connectionLimit, 5);
  } finally {
    await pool.end();
  }
});
