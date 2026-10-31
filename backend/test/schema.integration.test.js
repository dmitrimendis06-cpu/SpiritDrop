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
const vm = require("node:vm");
const mysql = require("mysql2/promise");
const { readTestDbConfig } = require("./helpers/test-db-guard");
const { createDbPool } = require("../src/config/database");

const config = readTestDbConfig();
const migrationSql = (file) => fs.readFileSync(path.join(__dirname, "..", "migrations", file), "utf8");
const MIGRATIONS = ["001_initial_schema.sql", "002_seed_launch_config.sql"];

describe("schema on a local test database", { skip: config ? false : "no local test database: set TEST_DB_NAME" }, () => {
  let pool;
  let reference = 900000;
  let nextDate = 0;

  // A fresh far-future date per use, so availability tests don't affect each other.
  const freshDate = () => {
    nextDate += 10;
    return new Date(Date.UTC(2040, 0, 1 + nextDate)).toISOString().slice(0, 10);
  };
  const addDays = (date, n) => new Date(Date.parse(date) + n * 86400000).toISOString().slice(0, 10);

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
  const PAID = { status: "paid", payment_status: "paid", paid_at: "2030-01-01 00:00:00.000000" };
  const paidOrder = (overrides = {}) => order({ ...PAID, bond_status: "held", ...overrides });
  const insertOrder = async (row) => { await pool.query("INSERT INTO orders SET ?", [row]); return row; };
  const item = (orderId, overrides = {}) => ({ order_id: orderId, flavour_id: "sd-01", flavour_name_snapshot: "Tropical Sunset", quantity: 1, unit_price_cents: 20000, line_total_cents: 20000, ...overrides });
  const outbox = (orderId, overrides = {}) => ({ order_id: orderId, notification_type: "business_new_order", recipient_category: "business", recipient_email: "owner@example.com", idempotency_key: `order:${orderId}:${crypto.randomUUID()}`, ...overrides });

  // A rejection must be for the expected reason: a constraint name or an error code in the message.
  const rejected = (promise, expected) => assert.rejects(promise, (err) => {
    assert.ok(expected.test(`${err.code} ${err.message}`), `expected ${expected}, got: ${err.code} ${err.message}`);
    return true;
  });
  const DUPLICATE = /ER_DUP_ENTRY/;
  const FK_RESTRICTED = /ER_ROW_IS_REFERENCED/;
  const FK_MISSING_PARENT = /ER_NO_REFERENCED_ROW/;
  const BAD_ENUM = /WARN_DATA_TRUNCATED|ER_TRUNCATED_WRONG_VALUE|ER_DATA_TOO_LONG|Data truncated/;
  const scalar = async (sql, params) => Object.values((await pool.query(sql, params))[0][0])[0];

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

  const nextCounter = async (conn) => {
    await conn.query("UPDATE order_reference_counter SET last_number = LAST_INSERT_ID(last_number + 1) WHERE id = 1");
    const [[{ n }]] = await conn.query("SELECT LAST_INSERT_ID() AS n");
    return Number(n);
  };

  async function beginCheckout(conn) {
    await conn.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await conn.beginTransaction();
    await conn.query("SELECT id FROM app_config WHERE id = 1 FOR UPDATE");
  }

  // The planned checkout transaction, reduced to its locking steps. `beforeCommit`
  // lets a test make it fail part-way, with `quantity` still reserved in the transaction.
  async function checkout(date, quantity, beforeCommit) {
    const conn = await pool.getConnection();
    try {
      await beginCheckout(conn);
      const available = await availableQuantity(conn, date);
      if (quantity > available) {
        await conn.rollback();
        return { ok: false, available };
      }
      const n = await nextCounter(conn);
      const row = order({ event_date: date, dispenser_quantity: quantity, order_reference: `SD-${String(n).padStart(6, "0")}` });
      await conn.query("INSERT INTO orders SET ?", [row]);
      await conn.query("INSERT INTO order_items SET ?", [item(row.id, { quantity, line_total_cents: quantity * 20000 })]);
      if (beforeCommit) await beforeCommit(conn, row);
      await conn.commit();
      return { ok: true, reference: row.order_reference, number: n };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  // The planned mark-paid transaction: order and email rows commit together.
  async function markPaid(orderId, beforeCommit) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `UPDATE orders SET status = 'paid', payment_status = 'paid', bond_status = 'held', paid_at = UTC_TIMESTAMP(6)
         WHERE id = ? AND status = 'pending_payment'`,
        [orderId],
      );
      if (result.affectedRows === 1) {
        for (const [type, category] of [["business_new_order", "business"], ["customer_order_confirmation", "customer"]]) {
          await conn.query("INSERT INTO notification_outbox SET ?", [outbox(orderId, {
            notification_type: type, recipient_category: category, idempotency_key: `order:${orderId}:${type}`,
          })]);
        }
      }
      if (beforeCommit) await beforeCommit(conn);
      await conn.commit();
      return result.affectedRows;
    } catch (err) {
      await conn.rollback();
      throw err;
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
    const [[server]] = await admin.query("SELECT VERSION() AS version, @@global.time_zone AS tz, @@global.sql_mode AS mode");
    console.log(`Test server: ${server.version}, global time_zone=${server.tz}, global sql_mode=[${server.mode}]`);
    for (const file of MIGRATIONS) await admin.query(migrationSql(file));
    await admin.end();
    // The real application pool, so these tests prove its UTC and strict-mode setup.
    pool = createDbPool(config);
  });
  after(async () => { if (pool) await pool.end(); });

  test("seed data loaded, including accents", async () => {
    const count = (t) => scalar(`SELECT COUNT(*) FROM ${t}`);
    assert.equal(await count("flavours"), 12);
    assert.equal(await count("delivery_zones"), 4);
    assert.equal(await count("delivery_zone_prefixes"), 40);
    assert.equal(await count("app_config"), 1);
    assert.equal(await count("schema_migrations"), 2);
    assert.equal(await scalar("SELECT name FROM flavours WHERE id = 'sd-11'"), "Piña Colada");
    assert.equal(await scalar("SELECT name FROM delivery_zones WHERE id = 'z1'"), "Zone 1 · Liverpool Local");
    assert.equal(await scalar("SELECT fee_cents FROM delivery_zones z JOIN delivery_zone_prefixes p ON p.zone_id = z.id WHERE p.postcode_prefix = '217'"), 0);
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
    assert.ok(saved.hold_expires_at instanceof Date);
  });

  test("quantity constraints", async () => {
    await rejected(insertOrder(order({ dispenser_quantity: 0, product_subtotal_cents: 0, bond_total_cents: 0 })), /chk_orders_quantity/);
    await rejected(insertOrder(order({ dispenser_quantity: -1, product_subtotal_cents: 0, bond_total_cents: 0 })), /chk_orders_quantity/);
    const row = await insertOrder(order());
    await rejected(pool.query("INSERT INTO order_items SET ?", [item(row.id, { quantity: 0, line_total_cents: 0 })]), /chk_order_items_quantity/);
    await rejected(pool.query("INSERT INTO order_items SET ?", [item(row.id, { quantity: 2, line_total_cents: 1 })]), /chk_order_items_line_total/);
    await pool.query("INSERT INTO order_items SET ?", [item(row.id, { quantity: 2, line_total_cents: 40000 })]);
    await rejected(pool.query("INSERT INTO order_items SET ?", [item(row.id)]), DUPLICATE);
  });

  test("negative or inconsistent money is rejected", async () => {
    await rejected(insertOrder(order({ product_subtotal_cents: -1 })), /chk_orders_subtotal/);
    await rejected(insertOrder(order({ delivery_fee_cents: -1 })), /chk_orders_delivery_fee/);
    await rejected(insertOrder(order({ bond_total_cents: -1 })), /chk_orders_bond_total/);
    await rejected(insertOrder(order({ total_cents: 1 })), /chk_orders_total/);
    await rejected(insertOrder(order({ currency: "USD" })), /chk_orders_currency/);
    await rejected(pool.query("UPDATE delivery_zones SET fee_cents = -1 WHERE id = 'z1'"), /chk_delivery_zones_fee/);
    await rejected(pool.query("UPDATE app_config SET dispenser_unit_price_cents = -1 WHERE id = 1"), /chk_app_config_price/);
  });

  test("order references are unique and well formed", async () => {
    const row = await insertOrder(order());
    await rejected(insertOrder(order({ order_reference: row.order_reference })), DUPLICATE);
    await rejected(insertOrder(order({ order_reference: "sd-000001" })), /chk_orders_reference/);
    await rejected(insertOrder(order({ id: "NOT-A-UUID" })), /chk_orders_id_uuid|ER_DATA_TOO_LONG/);
  });

  test("the reference counter never issues a number twice under concurrency", async () => {
    const issue = async () => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const n = await nextCounter(conn);
        await conn.commit();
        return n;
      } finally {
        conn.release();
      }
    };
    const numbers = await Promise.all(Array.from({ length: 25 }, issue));
    assert.equal(new Set(numbers).size, 25);
    assert.equal(Math.max(...numbers) - Math.min(...numbers), 24, "no gaps");
  });

  test("status values are controlled", async () => {
    await rejected(insertOrder(order({ status: "shipped" })), BAD_ENUM);
    await rejected(insertOrder(order({ payment_status: "maybe" })), BAD_ENUM);
    await rejected(insertOrder(order({ bond_status: "lost" })), BAD_ENUM);
  });

  test("statuses must agree with each other", async () => {
    await rejected(insertOrder(order({ hold_expires_at: null })), /chk_orders_pending_state/);
    await rejected(insertOrder(order({ payment_status: "paid" })), /chk_orders_pending_state/);
    await rejected(insertOrder(order({ status: "paid" })), /chk_orders_live_requires_payment/);
    await rejected(insertOrder(order({ bond_status: "held" })), /chk_orders_bond_requires_payment/);
    await insertOrder(paidOrder());
    await insertOrder(order({ payment_status: "failed" }));
    await insertOrder(order({ status: "expired" }));
  });

  test("bond amounts must add up", async () => {
    const bond = { dispenser_quantity: 2, bond_resolved_at: "2030-01-03 00:00:00.000000" };
    await insertOrder(paidOrder({ ...bond, bond_status: "refunded", bond_refunded_cents: 10000 }));
    await insertOrder(paidOrder({ ...bond, bond_status: "partially_retained", bond_refunded_cents: 7000, bond_retained_cents: 3000 }));
    await insertOrder(paidOrder({ ...bond, bond_status: "partially_retained", bond_retained_cents: 10000 }));
    await rejected(insertOrder(paidOrder({ ...bond, bond_status: "refunded", bond_refunded_cents: 1 })), /chk_orders_bond_refunded/);
    await rejected(insertOrder(paidOrder({ ...bond, bond_status: "partially_retained", bond_refunded_cents: 10000 })), /chk_orders_bond_retained/);
    await rejected(insertOrder(paidOrder({ ...bond, bond_status: "partially_retained", bond_retained_cents: 99999 })), /chk_orders_bond_amounts/);
    await rejected(insertOrder(paidOrder({ bond_status: "refunded", bond_refunded_cents: 5000 })), /chk_orders_bond_resolved/);
    await rejected(insertOrder(paidOrder({ bond_status: "held", bond_refunded_cents: 100 })), /chk_orders_bond_open/);
  });

  test("payment references are unique per provider, and optional", async () => {
    await insertOrder(paidOrder({ payment_provider: "test_a", payment_reference: "ref-1" }));
    await insertOrder(paidOrder({ payment_provider: "test_b", payment_reference: "ref-1" }));
    await rejected(insertOrder(paidOrder({ payment_provider: "test_a", payment_reference: "ref-1" })), DUPLICATE);
    await insertOrder(order());
    await insertOrder(order());
  });

  test("foreign keys protect order history and the catalogue", async () => {
    const row = await insertOrder(order());
    await pool.query("INSERT INTO order_items SET ?", [item(row.id, { flavour_id: "sd-02", flavour_name_snapshot: "Pineberry Spirit" })]);
    await pool.query("INSERT INTO order_status_history SET ?", [{ order_id: row.id, status_type: "status", new_value: "pending_payment", actor_type: "system" }]);
    await pool.query("INSERT INTO notification_outbox SET ?", [outbox(row.id)]);
    await rejected(pool.query("DELETE FROM orders WHERE id = ?", [row.id]), FK_RESTRICTED);
    await rejected(pool.query("DELETE FROM flavours WHERE id = 'sd-02'"), FK_RESTRICTED);
    await rejected(pool.query("DELETE FROM delivery_zones WHERE id = 'z3'"), FK_RESTRICTED);
    await rejected(pool.query("UPDATE orders SET id = ? WHERE id = ?", [crypto.randomUUID(), row.id]), FK_RESTRICTED);
    await rejected(pool.query("INSERT INTO order_items SET ?", [item(crypto.randomUUID())]), FK_MISSING_PARENT);
    await rejected(pool.query("INSERT INTO notification_outbox SET ?", [outbox(crypto.randomUUID())]), FK_MISSING_PARENT);
    await rejected(pool.query("INSERT INTO order_status_history SET ?", [{ order_id: crypto.randomUUID(), status_type: "status", new_value: "x", actor_type: "system" }]), FK_MISSING_PARENT);
    await rejected(insertOrder(order({ delivery_zone_id: "z9" })), FK_MISSING_PARENT);
    assert.equal(await scalar("SELECT COUNT(*) FROM order_items WHERE order_id = ?", [row.id]), 1);
  });

  test("identifiers are case-sensitive", async () => {
    const row = await insertOrder(order());
    await rejected(pool.query("INSERT INTO order_items SET ?", [item(row.id, { flavour_id: "SD-01" })]), FK_MISSING_PARENT);
    const [rows] = await pool.query("SELECT id FROM flavours WHERE id = 'SD-01'");
    assert.equal(rows.length, 0);
  });

  test("single-row tables stay single, and a prefix can't be in two zones", async () => {
    await rejected(pool.query("INSERT INTO app_config SELECT 2, active_fleet_capacity, dispenser_unit_price_cents, bond_per_dispenser_cents, drinks_per_dispenser, hold_duration_minutes, max_advance_booking_days, currency, delivery_window_first_hour, delivery_window_last_hour, collection_window_first_hour, collection_window_last_hour, business_notification_email, updated_at FROM app_config"), /chk_app_config_singleton/);
    await rejected(pool.query("INSERT INTO order_reference_counter VALUES (2, 0)"), /chk_order_reference_counter_singleton/);
    await rejected(pool.query("INSERT INTO delivery_zone_prefixes VALUES ('217', 'z4')"), DUPLICATE);
  });

  test("newsletter emails are unique regardless of case", async () => {
    await pool.query("INSERT INTO newsletter_subscriptions (email) VALUES ('Name@Example.com')");
    await rejected(pool.query("INSERT INTO newsletter_subscriptions (email) VALUES ('name@example.com')"), DUPLICATE);
    await rejected(pool.query("INSERT INTO newsletter_subscriptions (email) VALUES ('NAME@EXAMPLE.COM')"), DUPLICATE);
    await rejected(pool.query("INSERT INTO newsletter_subscriptions (email) VALUES ('not-an-email')"), /chk_newsletter_subscriptions_email/);
  });

  test("enquiries keep the existing form fields", async () => {
    const row = { name: "Test", phone: "0400 000 000", email: "e@example.com", event_type: "House Party", event_date: "2040-01-01", guests: "20 – 40", suburb: "Liverpool 2170", message: "Hello" };
    const [result] = await pool.query("INSERT INTO enquiries SET ?", [row]);
    const [[saved]] = await pool.query("SELECT guests, event_date, created_at FROM enquiries WHERE id = ?", [result.insertId]);
    assert.equal(saved.guests, "20 – 40");
    assert.equal(saved.event_date, "2040-01-01");
    assert.ok(saved.created_at instanceof Date);
    await rejected(pool.query("INSERT INTO enquiries SET ?", [{ ...row, message: "x".repeat(4001) }]), /chk_enquiries_message/);
    await rejected(pool.query("INSERT INTO enquiries SET ?", [{ ...row, email: "bad" }]), /chk_enquiries_email/);
  });

  test("outbox idempotency key is unique, and sent rows need a sent time", async () => {
    const row = await insertOrder(paidOrder());
    const base = outbox(row.id, { idempotency_key: `order:${row.id}:business_new_order` });
    const [result] = await pool.query("INSERT INTO notification_outbox SET ?", [base]);
    await rejected(pool.query("INSERT INTO notification_outbox SET ?", [base]), DUPLICATE);
    const [[saved]] = await pool.query("SELECT status, attempt_count, next_attempt_at FROM notification_outbox WHERE id = ?", [result.insertId]);
    assert.equal(saved.status, "pending");
    assert.equal(saved.attempt_count, 0);
    assert.ok(saved.next_attempt_at instanceof Date);
    await rejected(pool.query("UPDATE notification_outbox SET status = 'sent' WHERE id = ?", [result.insertId]), /chk_notification_outbox_sent/);
    await rejected(pool.query("UPDATE notification_outbox SET status = 'sending' WHERE id = ?", [result.insertId]), /chk_notification_outbox_claimed/);
    await rejected(pool.query("UPDATE notification_outbox SET status = 'bounced' WHERE id = ?", [result.insertId]), BAD_ENUM);
  });

  test("only one worker can claim an outbox row", async () => {
    const row = await insertOrder(paidOrder());
    const [result] = await pool.query("INSERT INTO notification_outbox SET ?", [outbox(row.id, { notification_type: "customer_order_confirmation", recipient_category: "customer" })]);
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
    for (const name of ["orders.uq_orders_reference", "orders.uq_orders_payment_session", "orders.uq_orders_payment_reference", "orders.idx_orders_event_status", "orders.idx_orders_status_hold", "orders.idx_orders_payment_status", "orders.idx_orders_delivery_zone", "order_items.uq_order_items_order_flavour", "order_items.idx_order_items_flavour", "order_status_history.idx_order_status_history_order", "enquiries.idx_enquiries_created", "newsletter_subscriptions.uq_newsletter_subscriptions_email", "notification_outbox.idx_notification_outbox_due", "notification_outbox.idx_notification_outbox_order", "notification_outbox.uq_notification_outbox_idempotency", "flavours.uq_flavours_slug", "flavours.uq_flavours_name", "delivery_zone_prefixes.idx_delivery_zone_prefixes_zone"]) {
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
    await insertOrder(paidOrder({ event_date: date, dispenser_quantity: 4 }));
    assert.equal(await availableQuantity(pool, date), 6);
    assert.equal(await availableQuantity(pool, addDays(date, 1)), 6, "still out on collection day");
    assert.equal(await availableQuantity(pool, addDays(date, -1)), 6, "a booking the day before needs the same stock the next day");
    assert.equal(await availableQuantity(pool, addDays(date, 2)), 10, "free again");
    assert.equal(await availableQuantity(pool, addDays(date, -2)), 10, "free before");
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
    for (const status of ["paid", "preparing", "out_for_delivery", "delivered"]) {
      await check({ ...PAID, status }, 7, status);
    }
    await check({ ...PAID, status: "collected" }, 10, "collected");
  });

  test("simultaneous customers can't overbook", async () => {
    const date = freshDate();
    assert.equal((await checkout(date, 9)).ok, true);
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => checkout(date, 1)));
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, "exactly one gets the last dispenser");
    assert.match(winners[0].reference, /^SD-\d{6}$/);
    assert.equal(await availableQuantity(pool, date), 0);
    assert.deepEqual(await checkout(freshDate(), 11), { ok: false, available: 10 });
  });

  test("timestamps default to UTC", async () => {
    const row = await insertOrder(order());
    const [[saved]] = await pool.query("SELECT created_at, updated_at, TIMESTAMPDIFF(SECOND, created_at, UTC_TIMESTAMP(6)) AS age FROM orders WHERE id = ?", [row.id]);
    assert.ok(Math.abs(Number(saved.age)) < 30, `created_at is ${saved.age}s from UTC`);
    assert.ok(Math.abs(Date.now() - saved.created_at.getTime()) < 30000, "reads back as the right instant");
  });

  // ---------------------------------------------------------------------------
  // Connection settings
  // ---------------------------------------------------------------------------
  test("every pooled connection uses UTC and strict mode", async () => {
    const conns = await Promise.all(Array.from({ length: 5 }, () => pool.getConnection()));
    try {
      const ids = new Set();
      for (const conn of conns) {
        const [[s]] = await conn.query("SELECT CONNECTION_ID() AS id, @@session.time_zone AS tz, @@session.sql_mode AS mode, TIMESTAMPDIFF(SECOND, CURRENT_TIMESTAMP(6), UTC_TIMESTAMP(6)) AS drift");
        ids.add(s.id);
        assert.equal(s.tz, "+00:00");
        assert.equal(Number(s.drift), 0);
        for (const flag of ["STRICT_TRANS_TABLES", "NO_ZERO_DATE", "NO_ZERO_IN_DATE", "ERROR_FOR_DIVISION_BY_ZERO", "NO_ENGINE_SUBSTITUTION"]) {
          assert.ok(s.mode.includes(flag), `${flag} missing from ${s.mode}`);
        }
      }
      assert.equal(ids.size, 5, "checked five separate connections");
    } finally {
      conns.forEach((c) => c.release());
    }
  });

  test("strict mode rejects bad data instead of changing it", async () => {
    await rejected(insertOrder(order({ customer_name: "x".repeat(121) })), /ER_DATA_TOO_LONG/);
    await rejected(insertOrder(order({ event_date: "2041-02-31" })), /ER_TRUNCATED_WRONG_VALUE|WARN_DATA_TRUNCATED/);
    await rejected(insertOrder(order({ event_date: "0000-00-00" })), /ER_TRUNCATED_WRONG_VALUE|WARN_DATA_TRUNCATED/);
    await rejected(insertOrder(order({ dispenser_quantity: "lots" })), /ER_TRUNCATED_WRONG_VALUE|WARN_DATA_TRUNCATED|ER_BAD_FIELD|chk_/);
    await rejected(insertOrder(order({ customer_email: null })), /ER_BAD_NULL_ERROR/);
  });

  test("DATE values read back unchanged, with no time zone shift", async () => {
    const row = await insertOrder(order({ event_date: "2041-07-01", customer_dob: "1990-01-01" }));
    const [[saved]] = await pool.query("SELECT event_date, collection_date, customer_dob FROM orders WHERE id = ?", [row.id]);
    assert.deepEqual({ ...saved }, { event_date: "2041-07-01", collection_date: "2041-07-02", customer_dob: "1990-01-01" });
  });

  // ---------------------------------------------------------------------------
  // Every constraint: installed, and rejecting for its own reason
  // ---------------------------------------------------------------------------
  test("every CHECK constraint in the migration rejects a violating row", async () => {
    const paid = await insertOrder(paidOrder());
    const cfg = (set) => pool.query(`UPDATE app_config SET ${set} WHERE id = 1`);
    const ord = (o) => insertOrder(order(o));
    const paidOrd = (o) => insertOrder(paidOrder(o));
    const it = (o) => pool.query("INSERT INTO order_items SET ?", [item(paid.id, { flavour_id: "sd-09", ...o })]);
    const box = (o) => pool.query("INSERT INTO notification_outbox SET ?", [outbox(paid.id, o)]);
    const enq = (o) => pool.query("INSERT INTO enquiries SET ?", [{ name: "T", phone: "0400 000 000", email: "e@example.com", ...o }]);
    const refundBig = { payment_refunded_cents: 999999 };
    const violations = {
      chk_app_config_singleton: () => pool.query("UPDATE app_config SET id = 2 WHERE id = 1"),
      chk_app_config_capacity: () => cfg("active_fleet_capacity = -1"),
      chk_app_config_price: () => cfg("dispenser_unit_price_cents = 0"),
      chk_app_config_bond: () => cfg("bond_per_dispenser_cents = -1"),
      chk_app_config_drinks: () => cfg("drinks_per_dispenser = 0"),
      chk_app_config_hold: () => cfg("hold_duration_minutes = 0"),
      chk_app_config_advance: () => cfg("max_advance_booking_days = 0"),
      chk_app_config_currency: () => cfg("currency = 'USD'"),
      chk_app_config_delivery_hours: () => cfg("delivery_window_first_hour = 22"),
      chk_app_config_collection_hours: () => cfg("collection_window_first_hour = 22"),
      chk_app_config_email: () => cfg("business_notification_email = 'nope'"),
      chk_order_reference_counter_singleton: () => pool.query("UPDATE order_reference_counter SET id = 2 WHERE id = 1"),
      chk_flavours_id: () => pool.query("INSERT INTO flavours (id, slug, name, sort_order) VALUES ('bad', 'bad', 'Bad', 99)"),
      chk_flavours_is_active: () => pool.query("UPDATE flavours SET is_active = 2 WHERE id = 'sd-01'"),
      chk_delivery_zones_fee: () => pool.query("UPDATE delivery_zones SET fee_cents = -1 WHERE id = 'z1'"),
      chk_delivery_zones_is_active: () => pool.query("UPDATE delivery_zones SET is_active = 2 WHERE id = 'z1'"),
      chk_delivery_zone_prefixes_format: () => pool.query("INSERT INTO delivery_zone_prefixes VALUES ('ab1', 'z1')"),
      chk_orders_id_uuid: () => ord({ id: "ZZZZZZZZ-0000-0000-0000-000000000000" }),
      chk_orders_reference: () => ord({ order_reference: "ORDER-1" }),
      chk_orders_customer_name: () => ord({ customer_name: "" }),
      chk_orders_customer_email: () => ord({ customer_email: "nope" }),
      chk_orders_customer_phone: () => ord({ customer_phone: "123" }),
      chk_orders_recipient: () => ord({ recipient_type: "other", recipient_name: null }),
      chk_orders_street: () => ord({ delivery_street: "" }),
      chk_orders_suburb: () => ord({ delivery_suburb: "" }),
      chk_orders_postcode: () => ord({ delivery_postcode: "abcd" }),
      chk_orders_quantity: () => ord({ dispenser_quantity: 0, product_subtotal_cents: 0, bond_total_cents: 0 }),
      chk_orders_subtotal: () => ord({ product_subtotal_cents: -1 }),
      chk_orders_delivery_fee: () => ord({ delivery_fee_cents: -1 }),
      chk_orders_bond_total: () => ord({ bond_total_cents: -1 }),
      chk_orders_total: () => ord({ total_cents: 1 }),
      chk_orders_currency: () => ord({ currency: "USD" }),
      chk_orders_pending_state: () => ord({ hold_expires_at: null }),
      chk_orders_paid_at: () => ord({ status: "cancelled", payment_status: "paid" }),
      chk_orders_live_requires_payment: () => ord({ status: "delivered" }),
      chk_orders_payment_refunded: () => paidOrd(refundBig),
      chk_orders_bond_requires_payment: () => ord({ status: "cancelled", bond_status: "held" }),
      chk_orders_bond_amounts: () => paidOrd({ bond_status: "partially_retained", bond_retained_cents: 99999, bond_resolved_at: "2030-01-03" }),
      chk_orders_bond_open: () => paidOrd({ bond_status: "held", bond_retained_cents: 100 }),
      chk_orders_bond_refunded: () => paidOrd({ bond_status: "refunded", bond_resolved_at: "2030-01-03" }),
      chk_orders_bond_retained: () => paidOrd({ bond_status: "partially_retained", bond_resolved_at: "2030-01-03" }),
      chk_orders_bond_resolved: () => paidOrd({ bond_status: "refunded", bond_refunded_cents: 5000 }),
      chk_order_items_quantity: () => it({ quantity: 0, line_total_cents: 0 }),
      chk_order_items_unit_price: () => it({ unit_price_cents: -1, line_total_cents: -1 }),
      chk_order_items_line_total: () => it({ line_total_cents: 1 }),
      chk_notification_outbox_attempts: () => box({ attempt_count: -1 }),
      chk_notification_outbox_email: () => box({ recipient_email: "nope" }),
      chk_notification_outbox_sent: () => box({ status: "sent" }),
      chk_notification_outbox_claimed: () => box({ status: "sending" }),
      chk_enquiries_name: () => enq({ name: "" }),
      chk_enquiries_phone: () => enq({ phone: "123" }),
      chk_enquiries_email: () => enq({ email: "nope" }),
      chk_enquiries_message: () => enq({ message: "x".repeat(4001) }),
      chk_newsletter_subscriptions_email: () => pool.query("INSERT INTO newsletter_subscriptions (email) VALUES ('nope')"),
    };
    const declared = [...migrationSql(MIGRATIONS[0]).matchAll(/CONSTRAINT (chk_\w+) CHECK/g)].map((m) => m[1]).sort();
    assert.deepEqual(Object.keys(violations).sort(), declared, "every declared CHECK must have a violation here");
    for (const [name, violate] of Object.entries(violations)) {
      await rejected(violate(), new RegExp(`\\b${name}\\b`));
    }
    console.log(`Verified ${declared.length} CHECK constraints each reject for their own reason.`);
  });

  test("all constraints are installed; every foreign key is RESTRICT", async () => {
    const [checks] = await pool.query("SELECT CONSTRAINT_NAME AS n FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?", [config.database]);
    const declared = [...migrationSql(MIGRATIONS[0]).matchAll(/CONSTRAINT (chk_\w+) CHECK/g)].map((m) => m[1]);
    assert.deepEqual(checks.map((c) => c.n).sort(), [...declared].sort());
    const [fks] = await pool.query("SELECT CONSTRAINT_NAME AS n, UPDATE_RULE AS u, DELETE_RULE AS d FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?", [config.database]);
    assert.equal(fks.length, 6);
    for (const fk of fks) assert.deepEqual([fk.u, fk.d], ["RESTRICT", "RESTRICT"], fk.n);
    const [dates] = await pool.query("SELECT COLUMN_NAME AS c, DATA_TYPE AS t, DATETIME_PRECISION AS p FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND COLUMN_NAME LIKE '%\\_at'", [config.database]);
    assert.ok(dates.length >= 15);
    for (const d of dates) assert.deepEqual([d.t, Number(d.p)], ["datetime", 6], d.c);
  });

  // ---------------------------------------------------------------------------
  // Seed data
  // ---------------------------------------------------------------------------
  test("all seed data matches the website's data and the launch decisions", async () => {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "..", "public", "spiritdrop-data.js"), "utf8"), sandbox);
    const { SD, FLAVOURS } = sandbox.window;
    const [[c]] = await pool.query("SELECT * FROM app_config WHERE id = 1");
    const hour = (slot) => Number(slot.id.slice(1));
    assert.deepEqual(
      [c.active_fleet_capacity, c.hold_duration_minutes, c.currency, c.max_advance_booking_days, c.business_notification_email],
      [10, 35, "AUD", 730, "spiritdropjd@gmail.com"],
    );
    assert.deepEqual(
      [c.dispenser_unit_price_cents, c.bond_per_dispenser_cents, c.drinks_per_dispenser],
      [SD.RULES.dispenserPrice * 100, SD.RULES.bondPerDispenser * 100, SD.RULES.drinksPerDispenser],
    );
    assert.deepEqual(
      [c.delivery_window_first_hour, c.delivery_window_last_hour, c.collection_window_first_hour, c.collection_window_last_hour],
      [hour(SD.DELIVERY_SLOTS[0]), hour(SD.DELIVERY_SLOTS.at(-1)), hour(SD.COLLECTION_SLOTS[0]), hour(SD.COLLECTION_SLOTS.at(-1))],
    );
    const [flavours] = await pool.query("SELECT id, slug, name, is_active FROM flavours ORDER BY sort_order");
    assert.deepEqual(flavours.map((f) => [f.id, f.slug, f.name, f.is_active]), Array.from(FLAVOURS, (f) => [f.id, f.slug, f.name, 1]));
    const [zones] = await pool.query("SELECT id, name, fee_cents, is_active FROM delivery_zones ORDER BY id");
    assert.deepEqual(zones.map((z) => [z.id, z.name, z.fee_cents, z.is_active]), Array.from(SD.ZONES, (z) => [z.id, z.name, z.fee * 100, 1]));
    const [prefixes] = await pool.query("SELECT postcode_prefix, zone_id FROM delivery_zone_prefixes");
    const site = Array.from(SD.ZONES).flatMap((z) => Array.from(z.prefixes, (p) => `${p}:${z.id}`)).sort();
    assert.deepEqual(prefixes.map((p) => `${p.postcode_prefix}:${p.zone_id}`).sort(), site);
    // Every 3-digit prefix gives the same answer as the website's own checker.
    for (let n = 0; n < 1000; n++) {
      const postcode = `${String(n).padStart(3, "0")}0`;
      const siteAnswer = SD.checkZone(postcode);
      const [rows] = await pool.query("SELECT z.id, z.fee_cents FROM delivery_zone_prefixes p JOIN delivery_zones z ON z.id = p.zone_id WHERE p.postcode_prefix = LEFT(?, 3)", [postcode]);
      if (siteAnswer.ok) assert.deepEqual([rows[0]?.id, rows[0]?.fee_cents], [siteAnswer.zone.id, siteAnswer.fee * 100], postcode);
      else assert.equal(rows.length, 0, postcode);
    }
    const [migrations] = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    assert.deepEqual(migrations.map((m) => m.version), ["001_initial_schema", "002_seed_launch_config"]);
  });

  // ---------------------------------------------------------------------------
  // Rollback
  // ---------------------------------------------------------------------------
  test("rollback: a checkout failing part-way leaves nothing behind", async () => {
    const date = freshDate();
    const counterBefore = await scalar("SELECT last_number FROM order_reference_counter WHERE id = 1");
    const ordersBefore = await scalar("SELECT COUNT(*) FROM orders");
    const itemsBefore = await scalar("SELECT COUNT(*) FROM order_items");
    let rowId;
    await rejected(checkout(date, 4, async (conn, row) => {
      rowId = row.id;
      await conn.query("INSERT INTO order_items SET ?", [item(row.id, { flavour_id: "sd-99" })]);
    }), FK_MISSING_PARENT);
    assert.ok(rowId, "the order was inserted before the failure");
    assert.equal(await scalar("SELECT COUNT(*) FROM orders WHERE id = ?", [rowId]), 0, "order gone");
    assert.equal(await scalar("SELECT COUNT(*) FROM order_items WHERE order_id = ?", [rowId]), 0, "items gone");
    assert.equal(await scalar("SELECT COUNT(*) FROM orders"), ordersBefore);
    assert.equal(await scalar("SELECT COUNT(*) FROM order_items"), itemsBefore);
    assert.equal(await scalar("SELECT last_number FROM order_reference_counter WHERE id = 1"), counterBefore, "number returned");
    assert.equal(await availableQuantity(pool, date), 10, "stock released");
    const next = await checkout(date, 1);
    assert.equal(next.number, Number(counterBefore) + 1, "the next order reuses the number, leaving no gap");
  });

  test("rollback: a rejected over-capacity checkout changes nothing", async () => {
    const counterBefore = await scalar("SELECT last_number FROM order_reference_counter WHERE id = 1");
    const result = await checkout(freshDate(), 11);
    assert.equal(result.ok, false);
    assert.equal(await scalar("SELECT last_number FROM order_reference_counter WHERE id = 1"), counterBefore);
  });

  test("rollback: a lost connection rolls back and releases the stock lock", async () => {
    const date = freshDate();
    const counterBefore = await scalar("SELECT last_number FROM order_reference_counter WHERE id = 1");
    const dying = await pool.getConnection();
    await beginCheckout(dying);
    await nextCounter(dying);
    const row = order({ event_date: date, dispenser_quantity: 10 });
    await dying.query("INSERT INTO orders SET ?", [row]);
    dying.destroy(); // the app crashes mid-transaction
    const result = await checkout(date, 10); // must get the lock and see all the stock
    assert.equal(result.ok, true);
    assert.equal(await scalar("SELECT COUNT(*) FROM orders WHERE id = ?", [row.id]), 0, "the crashed order never existed");
    assert.equal(result.number, Number(counterBefore) + 1, "the crashed order's number was returned");
  });

  test("rollback: payment and its email rows commit together or not at all", async () => {
    const row = await insertOrder(order());
    await rejected(markPaid(row.id, async (conn) => {
      await conn.query("INSERT INTO notification_outbox SET ?", [outbox(row.id, { recipient_email: "nope" })]);
    }), /chk_notification_outbox_email/);
    const [[after]] = await pool.query("SELECT status, payment_status, bond_status, paid_at FROM orders WHERE id = ?", [row.id]);
    assert.deepEqual({ ...after }, { status: "pending_payment", payment_status: "unpaid", bond_status: "not_held", paid_at: null });
    assert.equal(await scalar("SELECT COUNT(*) FROM notification_outbox WHERE order_id = ?", [row.id]), 0, "no emails for an unpaid order");
    assert.equal(await markPaid(row.id), 1);
    assert.equal(await scalar("SELECT COUNT(*) FROM notification_outbox WHERE order_id = ?", [row.id]), 2);
    assert.equal(await scalar("SELECT status FROM orders WHERE id = ?", [row.id]), "paid");
    assert.equal(await markPaid(row.id), 0, "a repeated webhook changes nothing");
    assert.equal(await scalar("SELECT COUNT(*) FROM notification_outbox WHERE order_id = ?", [row.id]), 2, "no duplicate emails");
    const repeats = await Promise.all([markPaid(row.id), markPaid(row.id), markPaid(row.id)]);
    assert.deepEqual(repeats, [0, 0, 0]);
  });

  test("rollback: a pending order creates no email rows", async () => {
    const row = await insertOrder(order());
    assert.equal(await scalar("SELECT COUNT(*) FROM notification_outbox WHERE order_id = ?", [row.id]), 0);
  });

  test("migrations can't be applied twice, and a failed seed changes nothing", async () => {
    const before_ = {
      flavours: await scalar("SELECT COUNT(*) FROM flavours"),
      migrations: await scalar("SELECT COUNT(*) FROM schema_migrations"),
    };
    const conn = await mysql.createConnection({ ...config, multipleStatements: true });
    try {
      await rejected(conn.query(migrationSql(MIGRATIONS[0])), /ER_TABLE_EXISTS_ERROR/);
    } finally {
      await conn.end();
    }
    // The seed's first insert fails on a second run; its transaction dies with the connection.
    const again = await mysql.createConnection({ ...config, multipleStatements: true });
    await rejected(again.query(migrationSql(MIGRATIONS[1])), DUPLICATE);
    await again.end();
    // A failure deep inside the seed's transaction leaves earlier inserts out.
    const seedLike = await mysql.createConnection({ ...config, multipleStatements: true });
    await seedLike.query("START TRANSACTION; INSERT INTO flavours (id, slug, name, sort_order) VALUES ('sd-98', 'rollback-test', 'Rollback Test', 98)");
    await rejected(seedLike.query("INSERT INTO delivery_zones (id, name, fee_cents) VALUES ('z1', 'Duplicate', 0)"), DUPLICATE);
    await seedLike.end();
    assert.equal(await scalar("SELECT COUNT(*) FROM flavours"), before_.flavours);
    assert.equal(await scalar("SELECT COUNT(*) FROM schema_migrations"), before_.migrations);
  });

  // ---------------------------------------------------------------------------
  // Concurrency, harder
  // ---------------------------------------------------------------------------
  test("a second checkout really waits for the first to finish", async () => {
    const date = freshDate();
    const first = await pool.getConnection();
    let secondFinished = false;
    try {
      await beginCheckout(first);
      const row = order({ event_date: date, dispenser_quantity: 10, order_reference: `SD-${++reference}` });
      await first.query("INSERT INTO orders SET ?", [row]);
      const second = checkout(date, 1).then((r) => { secondFinished = true; return r; });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(secondFinished, false, "second customer is blocked by the lock");
      await first.commit();
      assert.deepEqual(await second, { ok: false, available: 0 }, "and then sees the first customer's order");
    } finally {
      first.release();
    }
  });

  test("the last dispenser race holds up over repeated rounds", async () => {
    for (let round = 0; round < 15; round++) {
      const date = freshDate();
      assert.equal((await checkout(date, 9)).ok, true);
      const results = await Promise.all(Array.from({ length: 12 }, () => checkout(date, 1)));
      assert.equal(results.filter((r) => r.ok).length, 1, `round ${round}`);
      assert.equal(await availableQuantity(pool, date), 0);
    }
  });

  test("simultaneous bookings on adjacent days can't overbook the shared day", async () => {
    for (let round = 0; round < 10; round++) {
      const d = freshDate();
      // Bookings for d and d+1 both need stock on d+1, so only one of these can fit.
      const results = await Promise.all([
        checkout(d, 6), checkout(addDays(d, 1), 6), checkout(d, 6), checkout(addDays(d, 1), 6),
      ]);
      const booked = results.filter((r) => r.ok).length;
      assert.equal(booked, 1, `round ${round}: only one 6-dispenser booking fits a fleet of 10`);
      const [[max]] = await pool.query(
        "SELECT COALESCE(SUM(dispenser_quantity), 0) AS q FROM orders WHERE event_date IN (?, ?) AND status = 'pending_payment' AND hold_expires_at > UTC_TIMESTAMP(6)",
        [d, addDays(d, 1)],
      );
      assert.ok(Number(max.q) <= 10, `round ${round}: ${max.q} dispensers committed on the shared day`);
    }
  });

  test("references stay unique across every concurrent checkout", async () => {
    const [rows] = await pool.query("SELECT order_reference, COUNT(*) AS n FROM orders GROUP BY order_reference HAVING n > 1");
    assert.deepEqual(rows, []);
  });
});
