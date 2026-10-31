// Checks the migration files without connecting to any database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { assertSafeTestDatabase, readTestDbConfig } = require("./helpers/test-db-guard");

const dir = path.join(__dirname, "..", "migrations");
const schemaRaw = fs.readFileSync(path.join(dir, "001_initial_schema.sql"), "utf8");
const seedRaw = fs.readFileSync(path.join(dir, "002_seed_launch_config.sql"), "utf8");
// Fails showing only the matched text, not the whole file.
const none = (re, text, message) => assert.equal(text.match(re)?.[0] ?? null, null, message);
const stripComments = (sql) => sql.replace(/^\s*--.*$/gm, "");
const schema = stripComments(schemaRaw);
const seed = stripComments(seedRaw);

function tableBlock(name) {
  const match = schema.match(new RegExp(`CREATE TABLE ${name} \\(([\\s\\S]*?)\\n\\) ENGINE=InnoDB`));
  assert.ok(match, `table ${name} not found`);
  return match[1];
}
const tableNames = [...schema.matchAll(/CREATE TABLE (\w+) \(/g)].map((m) => m[1]);
const columnsOf = (name) =>
  tableBlock(name).split("\n").map((l) => l.trim().match(/^([a-z_]+) ([A-Z]+[A-Z0-9(), ]*)/)).filter(Boolean)
    .filter((m) => !["PRIMARY", "UNIQUE", "KEY", "CONSTRAINT"].includes(m[1])).map((m) => ({ name: m[1], type: m[2] }));

function seedRows(table) {
  const match = seed.match(new RegExp(`INSERT INTO ${table} \\([^)]*\\) VALUES([\\s\\S]*?);`));
  assert.ok(match, `seed for ${table} not found`);
  return [...match[1].matchAll(/\(([^()]*)\)/g)].map((m) =>
    m[1].split(",").map((v) => v.trim().replace(/^'|'$/g, "")));
}

// The site's data layer: the values the seed must match.
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "..", "public", "spiritdrop-data.js"), "utf8"), sandbox);
const { SD, FLAVOURS } = sandbox.window;

test("no PostgreSQL or Supabase syntax", () => {
  const forbidden = /\bRETURNING\b|\bjsonb\b|\bnextval\b|\bSERIAL\b|gen_random_uuid|::|timestamptz|\btext\[\]|ROW LEVEL SECURITY|CREATE POLICY|\bpg_net\b|\bvault\b|plpgsql|ON CONFLICT|\$\$|\bILIKE\b|supabase|\bCREATE TYPE\b|\bWHERE\b.*\bINDEX\b/i;
  for (const sql of [schema, seed]) none(forbidden, sql);
});

test("migrations contain only what they should", () => {
  const destructive = /\b(DROP|TRUNCATE|DELETE|ALTER|GRANT|REVOKE)\b|\bCREATE DATABASE\b|^\s*USE\s/im;
  none(destructive, schema.replace(/ON DELETE RESTRICT ON UPDATE RESTRICT/g, ""));
  none(destructive, seed);
  none(/\bCREATE (TABLE|INDEX|TRIGGER|PROCEDURE|FUNCTION|EVENT)\b|\bUPDATE\b/i, seed, "seed has data inserts only");
  none(/\b(TRIGGER|PROCEDURE|DELIMITER|CREATE EVENT)\b/i, schema, "no triggers or stored procedures");
  assert.deepEqual([...schema.matchAll(/INSERT INTO (\w+)/g)].map((m) => m[1]), ["schema_migrations"]);
});

test("expected tables exist and use InnoDB with utf8mb4", () => {
  assert.deepEqual(tableNames, [
    "schema_migrations", "app_config", "order_reference_counter", "flavours", "delivery_zones",
    "delivery_zone_prefixes", "orders", "order_items", "order_status_history", "notification_outbox",
    "enquiries", "newsletter_subscriptions",
  ]);
  assert.equal((schema.match(/\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;/g) || []).length, tableNames.length);
});

test("all money is INT cents, with no floating or decimal types anywhere", () => {
  none(/\b(FLOAT|DOUBLE|DECIMAL|NUMERIC|REAL)\b/i, schema);
  const money = tableNames.flatMap((t) => columnsOf(t).filter((c) => c.name.endsWith("_cents")));
  assert.ok(money.length >= 11, `found ${money.length} money columns`);
  for (const c of money) assert.match(c.type, /^INT\b/, c.name);
});

test("timestamps are DATETIME(6); event dates are DATE", () => {
  const stamps = tableNames.flatMap((t) => columnsOf(t).filter((c) => c.name.endsWith("_at")));
  assert.ok(stamps.length >= 15, `found ${stamps.length} timestamps`);
  for (const c of stamps) assert.match(c.type, /^DATETIME\(6\)/, c.name);
  const orders = columnsOf("orders");
  for (const n of ["event_date", "collection_date", "customer_dob"]) {
    assert.match(orders.find((c) => c.name === n).type, /^DATE\b/, n);
  }
});

test("status values are controlled and exact", () => {
  const values = (table, column) => {
    const m = tableBlock(table).match(new RegExp(`\\b${column} ENUM\\(([^)]*)\\)`));
    assert.ok(m, `${table}.${column} is not an ENUM`);
    return m[1].split(",").map((v) => v.trim().replace(/'/g, ""));
  };
  assert.deepEqual(values("orders", "status"), ["pending_payment", "paid", "preparing", "out_for_delivery", "delivered", "collected", "cancelled", "expired"]);
  assert.deepEqual(values("orders", "payment_status"), ["unpaid", "paid", "failed", "refunded", "partially_refunded"]);
  assert.deepEqual(values("orders", "bond_status"), ["not_held", "held", "refund_ready", "refunded", "partially_retained"]);
  assert.deepEqual(values("notification_outbox", "status"), ["pending", "sending", "sent", "failed"]);
});

test("no add-ons, card data or payment-provider brands", () => {
  none(/addon|add_on/i, schemaRaw + seedRaw.replace(/add-ons/gi, ""));
  none(/card_?number|\bcvv\b|\bcvc\b|\bpan\b|card_expiry/i, schema);
  none(/stripe|revolut|airwallex|eway|\bsquare\b|paypal|resend/i, schemaRaw + seedRaw);
});

test("every foreign key is RESTRICT, so history can't be cascade-deleted", () => {
  none(/\bCASCADE\b|SET NULL/i, schema);
  const fks = [...schema.matchAll(/CONSTRAINT (fk_\w+) FOREIGN KEY[^\n]*\n\s*ON DELETE RESTRICT ON UPDATE RESTRICT/g)].map((m) => m[1]);
  assert.deepEqual(fks.sort(), [
    "fk_delivery_zone_prefixes_zone", "fk_notification_outbox_order", "fk_order_items_flavour",
    "fk_order_items_order", "fk_order_status_history_order", "fk_orders_delivery_zone",
  ]);
  assert.equal((schema.match(/FOREIGN KEY/g) || []).length, fks.length);
});

test("intended indexes are declared", () => {
  const expected = {
    orders: ["uq_orders_reference", "uq_orders_payment_session", "uq_orders_payment_reference", "idx_orders_event_status", "idx_orders_status_hold", "idx_orders_payment_status", "idx_orders_delivery_zone"],
    order_items: ["uq_order_items_order_flavour", "idx_order_items_flavour"],
    order_status_history: ["idx_order_status_history_order"],
    notification_outbox: ["uq_notification_outbox_idempotency", "idx_notification_outbox_due", "idx_notification_outbox_order"],
    enquiries: ["idx_enquiries_created"],
    newsletter_subscriptions: ["uq_newsletter_subscriptions_email"],
    flavours: ["uq_flavours_slug", "uq_flavours_name"],
    delivery_zone_prefixes: ["idx_delivery_zone_prefixes_zone"],
  };
  for (const [table, indexes] of Object.entries(expected)) {
    for (const index of indexes) assert.match(tableBlock(table), new RegExp(`\\bKEY ${index}\\b`), `${table}.${index}`);
  }
});

test("key money, quantity and state rules are declared", () => {
  const orders = tableBlock("orders");
  for (const name of ["chk_orders_quantity", "chk_orders_subtotal", "chk_orders_delivery_fee", "chk_orders_bond_total", "chk_orders_total", "chk_orders_currency", "chk_orders_pending_state", "chk_orders_paid_at", "chk_orders_live_requires_payment", "chk_orders_bond_amounts", "chk_orders_reference"]) {
    assert.match(orders, new RegExp(`CONSTRAINT ${name} CHECK`), name);
  }
  assert.match(tableBlock("order_items"), /CONSTRAINT chk_order_items_line_total CHECK \(line_total_cents = quantity \* unit_price_cents\)/);
  assert.match(tableBlock("newsletter_subscriptions"), /email VARCHAR\(254\) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL/);
});

test("no fixed quantity cap: availability is the limit", () => {
  none(/dispenser_quantity\s*(<=|<|BETWEEN)/i, schema);
  none(/\bquantity\s*(<=|<|BETWEEN)/i, tableBlock("order_items"));
});

test("seeded configuration matches the decisions and the site's data", () => {
  const m = seed.match(/INSERT INTO app_config \(([^)]*)\) VALUES \(([^)]*)\)/);
  const keys = m[1].split(",").map((s) => s.trim());
  const vals = m[2].split(",").map((s) => s.trim().replace(/'/g, ""));
  const config = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  assert.equal(config.active_fleet_capacity, "10");
  assert.equal(config.hold_duration_minutes, "35");
  assert.equal(config.currency, "AUD");
  assert.equal(config.max_advance_booking_days, "730");
  assert.equal(config.business_notification_email, "spiritdropjd@gmail.com");
  assert.equal(Number(config.dispenser_unit_price_cents), SD.RULES.dispenserPrice * 100);
  assert.equal(Number(config.bond_per_dispenser_cents), SD.RULES.bondPerDispenser * 100);
  assert.equal(Number(config.drinks_per_dispenser), SD.RULES.drinksPerDispenser);
  const hour = (slot) => Number(slot.id.slice(1));
  assert.equal(Number(config.delivery_window_first_hour), hour(SD.DELIVERY_SLOTS[0]));
  assert.equal(Number(config.delivery_window_last_hour), hour(SD.DELIVERY_SLOTS.at(-1)));
  assert.equal(Number(config.collection_window_first_hour), hour(SD.COLLECTION_SLOTS[0]));
  assert.equal(Number(config.collection_window_last_hour), hour(SD.COLLECTION_SLOTS.at(-1)));
  assert.deepEqual(seedRows("order_reference_counter"), [["1", "0"]]);
});

test("seeded flavours match the site exactly", () => {
  assert.deepEqual(
    seedRows("flavours").map((r) => r.slice(0, 3)),
    Array.from(FLAVOURS, (f) => [f.id, f.slug, f.name]),
  );
  assert.equal(seedRows("flavours").length, 12);
  assert.match(seedRaw, /Piña Colada/, "file must keep UTF-8 accents");
  assert.match(seedRaw, /SET NAMES utf8mb4/);
});

test("seeded delivery zones and prefixes match the site exactly", () => {
  assert.deepEqual(
    seedRows("delivery_zones"),
    Array.from(SD.ZONES, (z) => [z.id, z.name, String(z.fee * 100)]),
  );
  assert.deepEqual(seedRows("delivery_zones").map((r) => r[2]), ["0", "1900", "2900", "3900"]);
  const rows = seedRows("delivery_zone_prefixes");
  const sitePrefixes = Array.from(SD.ZONES).flatMap((z) => Array.from(z.prefixes, (p) => [p, z.id]));
  assert.deepEqual([...rows].sort(), [...sitePrefixes].sort());
  assert.equal(new Set(rows.map((r) => r[0])).size, rows.length, "a prefix must not be in two zones");
});

test("files hold no production identifiers or secrets", () => {
  const files = [schemaRaw, seedRaw];
  const doc = path.join(__dirname, "..", "docs", "mariadb-schema-design.md");
  if (fs.existsSync(doc)) files.push(fs.readFileSync(doc, "utf8"));
  for (const text of files) {
    none(/\bu\d{6,}_|sb_secret_|sk_(live|test)_|whsec_[a-z0-9]|\bre_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}|(mysql|mariadb):\/\/[^\s]*@|\bDB_PASSWORD=\S/i, text);
  }
});

test("test database guard refuses anything but a local *_test database", () => {
  const ok = { host: "127.0.0.1", database: "spiritdrop_test", user: "tester" };
  assert.doesNotThrow(() => assertSafeTestDatabase(ok, {}));
  const refused = [
    [{ ...ok, host: "srv1.hstgr.io" }, {}],
    [{ ...ok, host: "api.spiritdrop.com.au" }, {}],
    [{ ...ok, database: "spiritdrop" }, {}],
    [{ ...ok, database: "u123456789_spiritdrop" }, {}],
    [{ ...ok, database: "u123456789_spiritdrop_test" }, {}],
    [{ ...ok, user: "u123456789_spiritdrop_app" }, {}],
    [ok, { NODE_ENV: "production" }],
    [ok, { DB_NAME: "spiritdrop_test" }],
  ];
  for (const [config, env] of refused) {
    assert.throws(() => assertSafeTestDatabase(config, env), /Refusing/, JSON.stringify(config));
  }
  assert.equal(readTestDbConfig({ DB_NAME: "x", DB_USER: "y", DB_PASSWORD: "z", DB_HOST: "127.0.0.1" }), null, "production DB_* variables are never used");
});
