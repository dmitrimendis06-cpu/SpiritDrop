-- SpiritDrop launch schema for Hostinger MariaDB. Design notes: backend/docs/mariadb-schema-design.md
--
-- NOT YET EXECUTED on any server. Run once, on an empty database, in filename order.
-- MariaDB commits each CREATE TABLE immediately, so a failure part-way needs a manual
-- clean-up: there is no automatic rollback of DDL.
--
-- Conventions:
--   Money:      INT cents with no FLOAT or DECIMAL. AUD only.
--   Timestamps: DATETIME(6) in UTC. Every connection must run SET time_zone = '+00:00'.
--   Dates:      DATE where time of day is irrelevant, as Sydney calendar dates.
--   IDs:        ascii_bin, so comparisons are exact and case-sensitive.
--   Deletes:    every foreign key is RESTRICT, so order history can't be removed by accident.
--   Logic:      no triggers or stored procedures. Transactions live in the Node API.

SET NAMES utf8mb4;
SET time_zone = '+00:00';
SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

-- ---------------------------------------------------------------------------
-- Which migrations have been applied
-- ---------------------------------------------------------------------------
CREATE TABLE schema_migrations (
  version VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Business configuration: exactly one row (id = 1).
-- Checkout locks this row with SELECT ... FOR UPDATE to serialise availability checks.
-- ---------------------------------------------------------------------------
CREATE TABLE app_config (
  id TINYINT UNSIGNED NOT NULL,
  active_fleet_capacity INT NOT NULL,
  dispenser_unit_price_cents INT NOT NULL,
  bond_per_dispenser_cents INT NOT NULL,
  drinks_per_dispenser INT NOT NULL,
  hold_duration_minutes INT NOT NULL,
  max_advance_booking_days INT NOT NULL,
  currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  delivery_window_first_hour TINYINT UNSIGNED NOT NULL,
  delivery_window_last_hour TINYINT UNSIGNED NOT NULL,
  collection_window_first_hour TINYINT UNSIGNED NOT NULL,
  collection_window_last_hour TINYINT UNSIGNED NOT NULL,
  business_notification_email VARCHAR(254) NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT chk_app_config_singleton CHECK (id = 1),
  CONSTRAINT chk_app_config_capacity CHECK (active_fleet_capacity >= 0),
  CONSTRAINT chk_app_config_price CHECK (dispenser_unit_price_cents > 0),
  CONSTRAINT chk_app_config_bond CHECK (bond_per_dispenser_cents >= 0),
  CONSTRAINT chk_app_config_drinks CHECK (drinks_per_dispenser > 0),
  CONSTRAINT chk_app_config_hold CHECK (hold_duration_minutes > 0),
  CONSTRAINT chk_app_config_advance CHECK (max_advance_booking_days > 0),
  CONSTRAINT chk_app_config_currency CHECK (currency = 'AUD'),
  CONSTRAINT chk_app_config_delivery_hours CHECK (delivery_window_first_hour <= delivery_window_last_hour AND delivery_window_last_hour <= 23),
  CONSTRAINT chk_app_config_collection_hours CHECK (collection_window_first_hour <= collection_window_last_hour AND collection_window_last_hour <= 23),
  CONSTRAINT chk_app_config_email CHECK (business_notification_email LIKE '%_@_%._%')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Order reference counter: exactly one row (id = 1). Sequence equivalent.
-- Inside the order transaction:
--   UPDATE order_reference_counter SET last_number = LAST_INSERT_ID(last_number + 1) WHERE id = 1;
--   SELECT LAST_INSERT_ID();
-- The row lock is held until commit, so a number can't be issued twice.
-- ---------------------------------------------------------------------------
CREATE TABLE order_reference_counter (
  id TINYINT UNSIGNED NOT NULL,
  last_number BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT chk_order_reference_counter_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
CREATE TABLE flavours (
  id VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  slug VARCHAR(60) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  sort_order INT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_flavours_slug (slug),
  UNIQUE KEY uq_flavours_name (name),
  CONSTRAINT chk_flavours_id CHECK (id REGEXP '^sd-[0-9]{2}$'),
  CONSTRAINT chk_flavours_is_active CHECK (is_active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE delivery_zones (
  id VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(120) NOT NULL,
  fee_cents INT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  CONSTRAINT chk_delivery_zones_fee CHECK (fee_cents >= 0),
  CONSTRAINT chk_delivery_zones_is_active CHECK (is_active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A postcode belongs to the zone holding its first three digits. The primary key
-- means a prefix can't sit in two zones, so a postcode always has one delivery fee.
CREATE TABLE delivery_zone_prefixes (
  postcode_prefix CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  zone_id VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (postcode_prefix),
  KEY idx_delivery_zone_prefixes_zone (zone_id),
  CONSTRAINT chk_delivery_zone_prefixes_format CHECK (postcode_prefix REGEXP '^[0-9]{3}$'),
  CONSTRAINT fk_delivery_zone_prefixes_zone FOREIGN KEY (zone_id) REFERENCES delivery_zones (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Orders. Three independent statuses:
--   status         where the booking is in its lifecycle
--   payment_status what has happened to the money, excluding normal bond returns
--   bond_status    what has happened to the refundable equipment bond
-- id is a lowercase UUID generated in Node. No card data is ever stored.
-- There is deliberately no upper limit on dispenser_quantity here: the API limits it
-- to current availability inside the checkout transaction.
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  order_reference VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,

  status ENUM('pending_payment', 'paid', 'preparing', 'out_for_delivery', 'delivered', 'collected', 'cancelled', 'expired') NOT NULL DEFAULT 'pending_payment',
  hold_expires_at DATETIME(6) NULL,

  customer_name VARCHAR(120) NOT NULL,
  customer_email VARCHAR(254) NOT NULL,
  customer_phone VARCHAR(30) NOT NULL,
  customer_dob DATE NOT NULL,
  recipient_type ENUM('self', 'other') NOT NULL,
  recipient_name VARCHAR(120) NULL,
  terms_accepted_at DATETIME(6) NOT NULL,
  responsible_supply_ack_at DATETIME(6) NOT NULL,

  event_date DATE NOT NULL,
  collection_date DATE GENERATED ALWAYS AS (DATE_ADD(event_date, INTERVAL 1 DAY)) STORED,
  delivery_window VARCHAR(40) NOT NULL,
  collection_window VARCHAR(40) NOT NULL,

  delivery_street VARCHAR(200) NOT NULL,
  delivery_unit VARCHAR(60) NULL,
  delivery_suburb VARCHAR(120) NOT NULL,
  delivery_state ENUM('NSW', 'ACT', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT') NOT NULL,
  delivery_postcode CHAR(4) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  delivery_zone_id VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  delivery_instructions VARCHAR(500) NULL,
  event_notes VARCHAR(2000) NULL,

  dispenser_quantity INT NOT NULL,
  product_subtotal_cents INT NOT NULL,
  delivery_fee_cents INT NOT NULL,
  bond_total_cents INT NOT NULL,
  total_cents INT NOT NULL,
  currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'AUD',

  payment_status ENUM('unpaid', 'paid', 'failed', 'refunded', 'partially_refunded') NOT NULL DEFAULT 'unpaid',
  payment_provider VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL,
  payment_session_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  payment_reference VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  payment_refunded_cents INT NOT NULL DEFAULT 0,
  paid_at DATETIME(6) NULL,

  bond_status ENUM('not_held', 'held', 'refund_ready', 'refunded', 'partially_retained') NOT NULL DEFAULT 'not_held',
  bond_refunded_cents INT NOT NULL DEFAULT 0,
  bond_retained_cents INT NOT NULL DEFAULT 0,
  bond_resolved_at DATETIME(6) NULL,

  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uq_orders_reference (order_reference),
  UNIQUE KEY uq_orders_payment_session (payment_provider, payment_session_id),
  UNIQUE KEY uq_orders_payment_reference (payment_provider, payment_reference),
  KEY idx_orders_event_status (event_date, status),
  KEY idx_orders_status_hold (status, hold_expires_at),
  KEY idx_orders_payment_status (payment_status),
  KEY idx_orders_delivery_zone (delivery_zone_id),

  CONSTRAINT fk_orders_delivery_zone FOREIGN KEY (delivery_zone_id) REFERENCES delivery_zones (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,

  CONSTRAINT chk_orders_id_uuid CHECK (id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT chk_orders_reference CHECK (order_reference REGEXP '^SD-[0-9]{6,}$'),
  CONSTRAINT chk_orders_customer_name CHECK (CHAR_LENGTH(customer_name) >= 1),
  CONSTRAINT chk_orders_customer_email CHECK (customer_email LIKE '%_@_%._%'),
  CONSTRAINT chk_orders_customer_phone CHECK (CHAR_LENGTH(customer_phone) >= 8),
  CONSTRAINT chk_orders_recipient CHECK (recipient_type = 'self' OR recipient_name IS NOT NULL),
  CONSTRAINT chk_orders_street CHECK (CHAR_LENGTH(delivery_street) >= 1),
  CONSTRAINT chk_orders_suburb CHECK (CHAR_LENGTH(delivery_suburb) >= 1),
  CONSTRAINT chk_orders_postcode CHECK (delivery_postcode REGEXP '^[0-9]{4}$'),

  CONSTRAINT chk_orders_quantity CHECK (dispenser_quantity >= 1),
  CONSTRAINT chk_orders_subtotal CHECK (product_subtotal_cents >= 0),
  CONSTRAINT chk_orders_delivery_fee CHECK (delivery_fee_cents >= 0),
  CONSTRAINT chk_orders_bond_total CHECK (bond_total_cents >= 0),
  CONSTRAINT chk_orders_total CHECK (total_cents = product_subtotal_cents + delivery_fee_cents + bond_total_cents),
  CONSTRAINT chk_orders_currency CHECK (currency = 'AUD'),

  -- An order awaiting payment always has a hold, and has not been paid.
  CONSTRAINT chk_orders_pending_state CHECK (status <> 'pending_payment' OR (hold_expires_at IS NOT NULL AND payment_status IN ('unpaid', 'failed'))),
  -- paid_at is set exactly when money has been received.
  CONSTRAINT chk_orders_paid_at CHECK ((payment_status IN ('unpaid', 'failed') AND paid_at IS NULL) OR (payment_status IN ('paid', 'refunded', 'partially_refunded') AND paid_at IS NOT NULL)),
  -- A booking can't progress without having been paid for.
  CONSTRAINT chk_orders_live_requires_payment CHECK (status NOT IN ('paid', 'preparing', 'out_for_delivery', 'delivered', 'collected') OR paid_at IS NOT NULL),
  CONSTRAINT chk_orders_payment_refunded CHECK (payment_refunded_cents >= 0 AND payment_refunded_cents + bond_refunded_cents <= total_cents),

  -- A bond can only be held once paid, and its amounts must add up.
  CONSTRAINT chk_orders_bond_requires_payment CHECK (bond_status = 'not_held' OR paid_at IS NOT NULL),
  CONSTRAINT chk_orders_bond_amounts CHECK (bond_refunded_cents >= 0 AND bond_retained_cents >= 0 AND bond_refunded_cents + bond_retained_cents <= bond_total_cents),
  CONSTRAINT chk_orders_bond_open CHECK (bond_status NOT IN ('not_held', 'held', 'refund_ready') OR (bond_refunded_cents = 0 AND bond_retained_cents = 0)),
  CONSTRAINT chk_orders_bond_refunded CHECK (bond_status <> 'refunded' OR (bond_refunded_cents = bond_total_cents AND bond_retained_cents = 0)),
  CONSTRAINT chk_orders_bond_retained CHECK (bond_status <> 'partially_retained' OR (bond_retained_cents > 0 AND bond_refunded_cents + bond_retained_cents = bond_total_cents)),
  CONSTRAINT chk_orders_bond_resolved CHECK (bond_status NOT IN ('refunded', 'partially_retained') OR bond_resolved_at IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Snapshot name and prices, so old orders stay readable if the catalogue changes.
CREATE TABLE order_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  flavour_id VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  flavour_name_snapshot VARCHAR(120) NOT NULL,
  quantity INT NOT NULL,
  unit_price_cents INT NOT NULL,
  line_total_cents INT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_order_items_order_flavour (order_id, flavour_id),
  KEY idx_order_items_flavour (flavour_id),
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_order_items_flavour FOREIGN KEY (flavour_id) REFERENCES flavours (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_order_items_quantity CHECK (quantity >= 1),
  CONSTRAINT chk_order_items_unit_price CHECK (unit_price_cents >= 0),
  CONSTRAINT chk_order_items_line_total CHECK (line_total_cents = quantity * unit_price_cents)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only audit trail, written by the API in the same transaction as each change.
CREATE TABLE order_status_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status_type ENUM('status', 'payment_status', 'bond_status') NOT NULL,
  old_value VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  new_value VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_type ENUM('system', 'customer', 'admin', 'payment_webhook', 'cron') NOT NULL,
  actor_reference VARCHAR(120) NULL,
  reason VARCHAR(500) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_order_status_history_order (order_id, created_at),
  CONSTRAINT fk_order_status_history_order FOREIGN KEY (order_id) REFERENCES orders (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Durable email outbox. Rows are created in the same transaction that marks an
-- order paid, and a short cron script sends and retries them.
-- A retry goes back to 'pending' with a later next_attempt_at; 'failed' means
-- retries are exhausted and a person needs to look. Email bodies are rendered at
-- send time from the order, so no date of birth or message content is stored here.
-- ---------------------------------------------------------------------------
CREATE TABLE notification_outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  notification_type ENUM('business_new_order', 'customer_order_confirmation') NOT NULL,
  recipient_category ENUM('business', 'customer') NOT NULL,
  recipient_email VARCHAR(254) NOT NULL,
  status ENUM('pending', 'sending', 'sent', 'failed') NOT NULL DEFAULT 'pending',
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  claimed_at DATETIME(6) NULL,
  sent_at DATETIME(6) NULL,
  provider_message_id VARCHAR(255) NULL,
  last_error VARCHAR(1000) NULL,
  idempotency_key VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_notification_outbox_idempotency (idempotency_key),
  KEY idx_notification_outbox_due (status, next_attempt_at),
  KEY idx_notification_outbox_order (order_id),
  CONSTRAINT fk_notification_outbox_order FOREIGN KEY (order_id) REFERENCES orders (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_notification_outbox_attempts CHECK (attempt_count >= 0),
  CONSTRAINT chk_notification_outbox_email CHECK (recipient_email LIKE '%_@_%._%'),
  CONSTRAINT chk_notification_outbox_sent CHECK ((status = 'sent' AND sent_at IS NOT NULL) OR (status <> 'sent' AND sent_at IS NULL)),
  CONSTRAINT chk_notification_outbox_claimed CHECK (status <> 'sending' OR claimed_at IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Public forms. The Node API validates input; browsers never reach the database.
-- ---------------------------------------------------------------------------
CREATE TABLE enquiries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  email VARCHAR(254) NOT NULL,
  event_type VARCHAR(60) NULL,
  event_date DATE NULL,
  guests VARCHAR(30) NULL,
  suburb VARCHAR(120) NULL,
  message TEXT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_enquiries_created (created_at),
  CONSTRAINT chk_enquiries_name CHECK (CHAR_LENGTH(name) >= 1),
  CONSTRAINT chk_enquiries_phone CHECK (CHAR_LENGTH(phone) >= 8),
  CONSTRAINT chk_enquiries_email CHECK (email LIKE '%_@_%._%'),
  CONSTRAINT chk_enquiries_message CHECK (message IS NULL OR CHAR_LENGTH(message) <= 4000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The explicit case-insensitive collation makes the unique key treat
-- Name@Example.com and name@example.com as the same address.
CREATE TABLE newsletter_subscriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  unsubscribed_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_newsletter_subscriptions_email (email),
  CONSTRAINT chk_newsletter_subscriptions_email CHECK (email LIKE '%_@_%._%')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_migrations (version) VALUES ('001_initial_schema');
