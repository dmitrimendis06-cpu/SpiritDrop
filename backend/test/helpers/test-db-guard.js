/**
 * Guards the database tests, which DROP and recreate their database. They read only
 * TEST_DB_* variables, never the production DB_* ones, and refuse to run unless the
 * target is clearly a throwaway local test database.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const HOSTINGER_ACCOUNT_NAME = /(^|[^a-z0-9])u\d{6,}_/; // Hostinger database and user names start like this

function assertSafeTestDatabase(config, env = process.env) {
  if (env.NODE_ENV === "production") {
    throw new Error("Refusing to run database tests with NODE_ENV=production.");
  }
  if (!LOCAL_HOSTS.has(config.host)) {
    throw new Error("Refusing to run: TEST_DB_HOST must be localhost, 127.0.0.1 or ::1.");
  }
  if (!/^[a-z0-9_]+_test$/.test(config.database || "")) {
    throw new Error("Refusing to run: TEST_DB_NAME must end in _test and use only a-z, 0-9 and _.");
  }
  if (HOSTINGER_ACCOUNT_NAME.test(`${config.database} ${config.user}`)) {
    throw new Error("Refusing to run: test settings look like the production account.");
  }
  if (env.DB_NAME && env.DB_NAME === config.database) {
    throw new Error("Refusing to run: TEST_DB_NAME is the same as DB_NAME.");
  }
}

/** Returns validated settings, or null when no test database is configured. */
function readTestDbConfig(env = process.env) {
  if (!env.TEST_DB_NAME) return null;
  const config = {
    host: env.TEST_DB_HOST || "127.0.0.1",
    port: Number(env.TEST_DB_PORT || 3306),
    user: env.TEST_DB_USER,
    password: env.TEST_DB_PASSWORD,
    database: env.TEST_DB_NAME,
  };
  assertSafeTestDatabase(config, env);
  return config;
}

module.exports = { assertSafeTestDatabase, readTestDbConfig };
