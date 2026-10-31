// Runs the migrations on a throwaway local MariaDB and tests real database behaviour.
// DROPS AND RECREATES its database. Skipped unless TEST_DB_NAME is set:
//
//   TEST_DB_NAME=spiritdrop_test TEST_DB_USER=... TEST_DB_PASSWORD=... npm test
//
// See helpers/test-db-guard.js: production settings and remote hosts are refused.
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");
const { readTestDbConfig } = require("./helpers/test-db-guard");

const config = readTestDbConfig();
const SESSION_SETUP = "SET time_zone = '+00:00', sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'";

describe("schema on a local test database", { skip: config ? false : "no local test database: set TEST_DB_NAME" }, () => {
  let pool;
  let reference = 900000;
  let nextDate = 0;

  // A fresh far-future date per test, so availability tests don't affect each other.
  const freshDate = () => {
    nextDate += 10;
    return new Date(Date.UTC(2040, 0, 1 + nextDate)).toISOString().slice(0, 10);
  };

  function order(overrides = {}) {
    const quantity = overrides.dispenser_quantity ?? 1;
    const subtotal = overrides.product_subtotal_cents ?? quantity * 20000;
    const bond = overrides.bond_total_cents ?? quantity * 5000;
    const fee = overrides.delivery_fee_cents ?? 2900;
    return {
      id: crypto.randomUUID(),
      order_reference: `SD-${++reference}`,
      hold_expires_at: "2099-01-01 00:00:00.000000",
      customer_name: "Test Customer",
      customer_email: "test@example.com",
      customer_phone: "0400 000 000",
      customer_dob: "1990-05-05",
      recipient_type: "self",
      terms_accepted_at: "2030-01-01 00:00:00.000000",
      responsible_supply_ack_at: "2030-01-01 00:00:00.000000",
      event_date: freshDate(),
      delivery_window: "2:00 PM – 3:00 PM",
      collection_window: "10:00 AM – 11:00 AM",
      delivery_street: "1 Test Street",
      delivery_suburb: "Sydney",
      delivery_state: "NSW",
      delivery_postcode: "2000",
      delivery_zone_id: "z3",
      dispenser_quantity: quantity,
      product_subtotal_cents: subtotal,
      delivery_fee_cents: fee,
      bond_total_cents: bond,
      total_cents: overrides.total_cents ?? subtotal + fee + bond,
      ...overrides,
    };
  }
  const paidOrder = (overrides = {}) => order({
    status: "paid", payment_status: "paid", paid_at: "2030-01-01 00:00:00.000000", bond_status: "held", ...overrides,
  });
  const insertOrder = async (row) => { await pool.query("INSERT INTO orders SET ?", [row]); return row; };
  const rejected = (promise, message) => assert.rejects(promise, /./, message);

  // The planned availability query (documented in docs/mariadb-schema-design.md).
  async function availableQuantity(conn, date) {
    const [[cfg]] = await conn.query("SELECT active_fleet_capacity AS capacity FROM app_config WHERE id = 1");
    const [[row]] = await conn.query(
      `SELECT
         COALESCE(SUM(CASE WHEN event_date IN (DATE_SUB(?, INTERVAL 1 DAY), ?) THEN dispenser_quantity END), 0) AS committed_day,
         COALESCE(SUM(CASE WHEN event_date IN (?, DATE_ADD(?, INTERVAL 1 DAY)) THEN dispenser_quantity END), 0) AS committed_next_day
       FROM orders
       WHERE event_date BETWEEN DATE_SUB(?, INTERVAL 1 DAY) AND DATE_ADD(?, INTERVAL 1 DAY)
         AND (status IN ('paid', 'preparing', 'out_for_delivery', 'delivered')
              OR (status = 'pending_payment' AND hold_expires_at > UTC_TIMESTAMP(6)))`,
      [date, date, date, date, date, date],
    );
    return Math.max(cfg.capacity - Math.max(Number(row.committed_day), Number(row.committed_next_day)), 0);
  }

  // The planned checkout transaction, reduced to its locking steps.
  async function checkout(date, quantity) {
    const conn = await pool.getConnection();
    try {
      await conn.query(SESSION_SETUP);
      await conn.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await conn.beginTransaction();
      await conn.query("SELECT id FROM app_config WHERE id = 1 FOR UPDATE");
      const available = await availableQuantity(conn, date);
      if (quantity > available) {
        await conn.rollback();
        return { ok: false, available };
      }
      await conn.query("UPDATE order_reference_counter SET last_number = LAST_INSERT_ID(last_number + 1) WHERE id = 1");
      const [[{ n }]] = await conn.query("SELECT LAST_INSERT_ID() AS n");
      const row = order({ event_date: date, dispenser_quantity: quantity, order_reference: `SD-${String(n).padStart(6, "0")}` });
      await conn.query("INSERT INTO orders SET ?", [row]);
      await conn.commit();
      return { ok: true, reference: row.order_reference };
    } finally {
      conn.release();
    }
  }

  before(async () => {
    const admin = await mysql.createConnection({
      host: config.host, port: config.port, user: config.user, password: config.password, multipleStatements: true,
    });
    await admin.query(`DROP DATABASE IF EXISTS \`${config.database}\``);
    await admin.query(`CREATE DATABASE \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(`USE \`${config.database}\``);
    const [[{ version }]] = await admin.query("SELECT VERSION() AS version");
    console.log(`Test server version: ${version}`);
    for (const file of ["001_initial_schema.sql", "002_seed_launch_config.sql"]) {
      await admin.query(fs.readFileSync(path.join(__dirname, "..", "migrations", file), "utf8"));
    }
    await admin.end();
    pool = mysql.createPool({ ...config, connectionLimit: 5, timezone: "Z", dateStrings: ["DATE"] });
    await pool.query("SET time_zone = '+00:00'");
  });
  after(async () => { if (pool) await pool.end(); });

  test("seed data loaded, including accents", async () => {
    const count = async (t) => (await pool.query(`SELECT COUNT(*) AS n FROM ${t}`))[0][0].n;
    assert.equal(await count("flavours"), 12);
    assert.equal(await count("delivery_zones"), 4);
    assert.equal(await count("delivery_zone_prefixes"), 40);
    assert.equal(await count("app_config"), 1);
    assert.equal(await count("schema_migrations"), 2);
    const [[f]] = await pool.query("SELECT name FROM flavours WHERE id = 'sd-11'");
    assert.equal(f.name, "Piña Colada");
    const [[z]] = await pool.query("SELECT fee_cents FROM delivery_zones z JOIN delivery_zone_prefixes p ON p.zone_id = z.id WHERE p.postcode_prefix = '217'");
    assert.equal(z.fee_cents, 0);
  });

  test("money columns are integers", async () => {
    const [rows] = await pool.query(
      "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND COLUMN_NAME LIKE '%\\_cents'",
      [config.database],
    );
    assert.ok(rows.length >= 11);
    for (const r of rows) assert.equal(r.DATA_TYPE, "int", `${r.TABLE_NAME}.${r.COLUMN_NAME}`);
  });

  test("a valid order is accepted, and collection date is generated", async () => {
    const row = await insertOrder(order({ event_date: "2041-02-28" }));
    const [[saved]] = await pool.query("SELECT status, payment_status, bond_status, collection_date, currency, hold_expires_at FROM orders WHERE id = ?", [row.id]);
    assert.equal(saved.status, "pending_payment");
    assert.equal(saved.payment_status, "unpaid");
    assert.equal(saved.bond_status, "not_held");
    assert.equal(saved.collection_date, "2041-03-01");
    assert.equal(saved.currency, "AUD");
    assert.ok(saved.hold_expires_at);
  });

  test("quantity constraints", async () => {
    await rejected(insertOrder(order({ dispenser_quantity: 0, product_subtotal_cents: 0, bond_total_cents: 0 })));
    await rejected(insertOrder(order({ dispenser_quantity: -1, product_subtotal_cents: 0, bond_total_cents: 0 })));
    const row = await insertOrder(order());
    const base = { order_id: row.id, flavour_id: "sd-01", flavour_name_snapshot: "Tropical Sunset" };
    await rejected(pool.query("INSERT INTO order_items SET ?", [{ ...base, quantity: 0, unit_price_cents: 20000, line_total_cents: 0 }]));
    await rejected(pool.query("INSERT INTO order_items SET ?", [{ ...base, quantity: 2, unit_price_cents: 20000, line_total_cents: 1 }]));
    await pool.query("INSERT INTO order_items SET ?", [{ ...base, quantity: 2, unit_price_cents: 20000, line_total_cents: 40000 }]);
    await rejected(pool.query("INSERT INTO order_items SET ?", [{ ...base, quantity: 1, unit_price_cents: 20000, line_total_cents: 20000 }]), "one row per flavour");
  });

  test("negative or inconsistent money is rejected", async () => {
    await rejected(insertOrder(order({ product_subtotal_cents: -1 })));
    await rejected(insertOrder(order({ delivery_fee_cents: -1 })));
    await rejected(insertOrder(order({ bond_total_cents: -1 })));
    await rejected(insertOrder(order({ total_cents: 1 })), "total must add up");
    await rejected(insertOrder(order({ currency: "USD" })));
    await rejected(pool.query("UPDATE delivery_zones SET fee_cents = -1 WHERE id = 'z1'"));
    await rejected(pool.query("UPDATE app_config SET dispenser_unit_price_cents = -1 WHERE id = 1"));
  });

  test("order references are unique and well formed", async () => {
    const row = await insertOrder(order());
    await rejected(insertOrder(order({ order_reference: row.order_reference })), "duplicate reference");
    await rejected(insertOrder(order({ order_reference: "sd-000001" })), "wrong format");
    await rejected(insertOrder(order({ id: "NOT-A-UUID" })));
  });

  test("the reference counter never issues a number twice under concurrency", async () => {
    const issue = async () => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query("UPDATE order_reference_counter SET last_number = LAST_INSERT_ID(last_number + 1) WHERE id = 1");
        const [[{ n }]] = await conn.query("SELECT LAST_INSERT_ID() AS n");
        await conn.commit();
        return Number(n);
      } finally {
        conn.release();
      }
    };
    const numbers = await Promise.all(Array.from({ length: 25 }, issue));
    assert.equal(new Set(numbers).size, 25);
    assert.equal(Math.max(...numbers) - Math.min(...numbers), 24, "no gaps");
  });

  test("status values are controlled", async () => {
    await rejected(insertOrder(order({ status: "shipped" })));
    await rejected(insertOrder(order({ payment_status: "maybe" })));
    await rejected(insertOrder(order({ bond_status: "lost" })));
  });

  test("statuses must agree with each other", async () => {
    await rejected(insertOrder(order({ hold_expires_at: null })), "pending needs a hold");
    await rejected(insertOrder(order({ payment_status: "paid" })), "paid needs paid_at");
    await rejected(insertOrder(order({ status: "paid" })), "live status needs payment");
    await rejected(insertOrder(order({ bond_status: "held" })), "bond needs payment");
    await insertOrder(paidOrder());
    await insertOrder(order({ payment_status: "failed" }));
    await insertOrder(order({ status: "expired" }));
  });

  test("bond amounts must add up", async () => {
    const bond = { dispenser_quantity: 2, bond_resolved_at: "2030-01-03 00:00:00.000000" };
    await insertOrder(paidOrder({ ...bond, bond_status: "refunded", bond_refunded_cents: 10000 }));
    await insertOrder(paidOrder({ ...bond, bond_status: "partially_retained", bond_refunded_cents: 7000, bond_retained_cents: 3000 }));
    await rejected(insertOrder(paidOrder({ ...bond, bond_status: "refunded", bond_refunded_cents: 1 })), "refunded means all of it");
    await rejected(insertOrder(paidOrder({ ...bond, bond_status: "partially_retained", bond_refunded_cents: 10000 })), "must retain something");
    await rejected(insertOrder(paidOrder({ ...bond, bond_status: "partially_retained", bond_retained_cents: 99999 })), "can't exceed the bond");
    await rejected(insertOrder(paidOrder({ bond_status: "refunded", bond_refunded_cents: 5000 })), "resolved bond needs a date");
    await rejected(insertOrder(paidOrder({ bond_status: "held", bond_refunded_cents: 100 })), "open bond has no amounts");
  });

  test("payment references are unique per provider, and optional", async () => {
    await insertOrder(paidOrder({ payment_provider: "test_a", payment_reference: "ref-1" }));
    await insertOrder(paidOrder({ payment_provider: "test_b", payment_reference: "ref-1" }));
    await rejected(insertOrder(paidOrder({ payment_provider: "test_a", payment_reference: "ref-1" })));
    await insertOrder(order());
    await insertOrder(order());
  });

  test("foreign keys protect order history and the catalogue", async () => {
    const row = await insertOrder(order());
    await pool.query("INSERT INTO order_items SET ?", [{ order_id: row.id, flavour_id: "sd-02", flavour_name_snapshot: "Pineberry Spirit", quantity: 1, unit_price_cents: 20000, line_total_cents: 20000 }]);
    await pool.query("INSERT INTO order_status_history SET ?", [{ order_id: row.id, status_type: "status", new_value: "pending_payment", actor_type: "system" }]);
    await rejected(pool.query("DELETE FROM orders WHERE id = ?", [row.id]), "order with items");
    await rejected(pool.query("DELETE FROM flavours WHERE id = 'sd-02'"), "flavour used by an order");
    await rejected(pool.query("DELETE FROM delivery_zones WHERE id = 'z3'"), "zone used by an order");
    await rejected(pool.query("INSERT INTO order_items SET ?", [{ order_id: crypto.randomUUID(), flavour_id: "sd-02", flavour_name_snapshot: "x", quantity: 1, unit_price_cents: 1, line_total_cents: 1 }]), "unknown order");
    await rejected(insertOrder(order({ delivery_zone_id: "z9" })), "unknown zone");
    const [[items]] = await pool.query("SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?", [row.id]);
    assert.equal(items.n, 1);
  });

  test("identifiers are case-sensitive", async () => {
    const row = await insertOrder(order());
    await rejected(pool.query("INSERT INTO order_items SET ?", [{ order_id: row.id, flavour_id: "SD-01", flavour_name_snapshot: "x", quantity: 1, unit_price_cents: 1, line_total_cents: 1 }]));
    const [rows] = await pool.query("SELECT id FROM flavours WHERE id = 'SD-01'");
    assert.equal(rows.length, 0);
  });

  test("single-row tables stay single, and a prefix can't be in two zones", async () => {
    await rejected(pool.query("INSERT INTO app_config SELECT 2, active_fleet_capacity, dispenser_unit_price_cents, bond_per_dispenser_cents, drinks_per_dispenser, hold_duration_minutes, max_advance_booking_days, currency, delivery_window_first_hour, delivery_window_last_hour, collection_window_first_hour, collection_window_last_hour, business_notification_email, updated_at FROM app_config"));
    await rejected(pool.query("INSERT INTO order_reference_counter VALUES (2, 0)"));
    await rejected(pool.query("INSERT INTO delivery_zone_prefixes VALUES ('217', 'z4')"));
  });

  test("newsletter emails are unique regardless of case", async () => {
    await pool.query("INSERT INTO newsletter_subscriptions (email) VALUES ('Name@Example.com')");
    await assert.rejects(pool.query("INSERT INTO newsletter_subscriptions (email) VALUES ('name@example.com')"), { code: "ER_DUP_ENTRY" });
    await assert.rejects(pool.query("INSERT INTO newsletter_subscriptions (email) VALUES ('NAME@EXAMPLE.COM')"), { code: "ER_DUP_ENTRY" });
    await rejected(pool.query("INSERT INTO newsletter_subscriptions (email) VALUES ('not-an-email')"));
  });

  test("enquiries keep the existing form fields", async () => {
    const row = { name: "Test", phone: "0400 000 000", email: "e@example.com", event_type: "House Party", event_date: "2040-01-01", guests: "20 – 40", suburb: "Liverpool 2170", message: "Hello" };
    const [result] = await pool.query("INSERT INTO enquiries SET ?", [row]);
    const [[saved]] = await pool.query("SELECT guests, event_date, created_at FROM enquiries WHERE id = ?", [result.insertId]);
    assert.equal(saved.guests, "20 – 40");
    assert.equal(saved.event_date, "2040-01-01");
    assert.ok(saved.created_at);
    await rejected(pool.query("INSERT INTO enquiries SET ?", [{ ...row, message: "x".repeat(4001) }]));
    await rejected(pool.query("INSERT INTO enquiries SET ?", [{ ...row, email: "bad" }]));
  });

  test("outbox idempotency key is unique, and sent rows need a sent time", async () => {
    const row = await insertOrder(paidOrder());
    const base = { order_id: row.id, notification_type: "business_new_order", recipient_category: "business", recipient_email: "owner@example.com", idempotency_key: `order:${row.id}:business_new_order` };
    const [result] = await pool.query("INSERT INTO notification_outbox SET ?", [base]);
    await assert.rejects(pool.query("INSERT INTO notification_outbox SET ?", [base]), { code: "ER_DUP_ENTRY" });
    const [[saved]] = await pool.query("SELECT status, attempt_count, next_attempt_at FROM notification_outbox WHERE id = ?", [result.insertId]);
    assert.equal(saved.status, "pending");
    assert.equal(saved.attempt_count, 0);
    assert.ok(saved.next_attempt_at);
    await rejected(pool.query("UPDATE notification_outbox SET status = 'sent' WHERE id = ?", [result.insertId]));
    await rejected(pool.query("UPDATE notification_outbox SET status = 'sending' WHERE id = ?", [result.insertId]));
    await rejected(pool.query("UPDATE notification_outbox SET status = 'bounced' WHERE id = ?", [result.insertId]));
  });

  test("only one worker can claim an outbox row", async () => {
    const row = await insertOrder(paidOrder());
    const [result] = await pool.query("INSERT INTO notification_outbox SET ?", [{ order_id: row.id, notification_type: "customer_order_confirmation", recipient_category: "customer", recipient_email: "c@example.com", idempotency_key: `order:${row.id}:customer_order_confirmation` }]);
    const claim = async () => (await pool.query(
      `UPDATE notification_outbox SET status = 'sending', claimed_at = UTC_TIMESTAMP(6), attempt_count = attempt_count + 1
       WHERE id = ? AND status = 'pending' AND next_attempt_at <= UTC_TIMESTAMP(6)`, [result.insertId],
    ))[0].affectedRows;
    const claims = await Promise.all([claim(), claim(), claim()]);
    assert.equal(claims.reduce((a, b) => a + b, 0), 1);
  });

  test("intended indexes exist", async () => {
    const [rows] = await pool.query("SELECT DISTINCT TABLE_NAME AS t, INDEX_NAME AS i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?", [config.database]);
    const have = new Set(rows.map((r) => `${r.t}.${r.i}`));
    for (const name of ["orders.uq_orders_reference", "orders.idx_orders_event_status", "orders.idx_orders_status_hold", "orders.idx_orders_payment_status", "orders.uq_orders_payment_reference", "enquiries.idx_enquiries_created", "newsletter_subscriptions.uq_newsletter_subscriptions_email", "notification_outbox.idx_notification_outbox_due", "notification_outbox.uq_notification_outbox_idempotency"]) {
      assert.ok(have.has(name), name);
    }
  });

  test("all tables are InnoDB", async () => {
    const [rows] = await pool.query("SELECT TABLE_NAME AS t, ENGINE AS e FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", [config.database]);
    assert.equal(rows.length, 12);
    for (const r of rows) assert.equal(r.e, "InnoDB", r.t);
  });

  test("availability counts the event day and the following day", async () => {
    const date = freshDate();
    const dayAfter = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
    const twoAfter = new Date(Date.parse(date) + 2 * 86400000).toISOString().slice(0, 10);
    const dayBefore = new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10);
    await insertOrder(paidOrder({ event_date: date, dispenser_quantity: 4 }));
    assert.equal(await availableQuantity(pool, date), 6);
    assert.equal(await availableQuantity(pool, dayAfter), 6, "still out on collection day");
    assert.equal(await availableQuantity(pool, dayBefore), 6, "out on the following day of a booking before it");
    assert.equal(await availableQuantity(pool, twoAfter), 10, "free again");
  });

  test("valid holds count; expired, cancelled and collected orders don't", async () => {
    const check = async (overrides, expected, label) => {
      const date = freshDate();
      await insertOrder(order({ event_date: date, dispenser_quantity: 3, ...overrides }));
      assert.equal(await availableQuantity(pool, date), expected, label);
    };
    await check({}, 7, "valid hold");
    await check({ hold_expires_at: "2020-01-01 00:00:00.000000" }, 10, "expired hold");
    await check({ status: "expired" }, 10, "expired status");
    await check({ status: "cancelled" }, 10, "cancelled");
    await check({ status: "collected", payment_status: "paid", paid_at: "2030-01-01 00:00:00.000000" }, 10, "collected");
    await check({ status: "delivered", payment_status: "paid", paid_at: "2030-01-01 00:00:00.000000" }, 7, "delivered");
  });

  test("simultaneous customers can't overbook", async () => {
    const date = freshDate();
    assert.equal((await checkout(date, 9)).ok, true);
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => checkout(date, 1)));
    assert.equal(results.filter((r) => r.ok).length, 1, "exactly one gets the last dispenser");
    const refs = results.filter((r) => r.ok).map((r) => r.reference);
    assert.match(refs[0], /^SD-\d{6}$/);
    assert.equal(await availableQuantity(pool, date), 0);
    const tooMany = await checkout(freshDate(), 11);
    assert.deepEqual(tooMany, { ok: false, available: 10 });
  });

  test("timestamps default to UTC", async () => {
    const [[row]] = await pool.query("SELECT TIMESTAMPDIFF(SECOND, CURRENT_TIMESTAMP(6), UTC_TIMESTAMP(6)) AS diff");
    assert.equal(Number(row.diff), 0);
  });
});
