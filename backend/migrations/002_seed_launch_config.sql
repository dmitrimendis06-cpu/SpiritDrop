-- Launch configuration and catalogue. NOT YET EXECUTED on any server. Run after 001.
--
-- Prices, zones, windows and flavours are copied from public/spiritdrop-data.js and the
-- Supabase audit; backend/test/migrations.static.test.js fails if they ever disagree.
-- Fleet capacity (10) and hold duration (35 minutes) are confirmed launch decisions.

SET NAMES utf8mb4;
SET time_zone = '+00:00';
SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

START TRANSACTION;

INSERT INTO app_config (
  id, active_fleet_capacity, dispenser_unit_price_cents, bond_per_dispenser_cents,
  drinks_per_dispenser, hold_duration_minutes, max_advance_booking_days, currency,
  delivery_window_first_hour, delivery_window_last_hour,
  collection_window_first_hour, collection_window_last_hour,
  business_notification_email
) VALUES (
  1, 10, 20000, 5000,
  20, 35, 730, 'AUD',
  10, 20,
  9, 19,
  'spiritdropjd@gmail.com'
);

INSERT INTO order_reference_counter (id, last_number) VALUES (1, 0);

INSERT INTO flavours (id, slug, name, sort_order) VALUES
  ('sd-01', 'tropical-sunset', 'Tropical Sunset', 1),
  ('sd-02', 'pineberry-spirit', 'Pineberry Spirit', 2),
  ('sd-03', 'sweetmelon-vodka', 'Sweetmelon Vodka', 3),
  ('sd-04', 'strawberry-cream', 'Strawberry Cream', 4),
  ('sd-05', 'fruit-fizz', 'Fruit Fizz', 5),
  ('sd-06', 'coconut-fix', 'Coconut Fix', 6),
  ('sd-07', 'mint-mojito', 'Mint Mojito', 7),
  ('sd-08', 'fresh-melon', 'Fresh Melon', 8),
  ('sd-09', 'apple-on-fire', 'Apple on Fire', 9),
  ('sd-10', 'wow-grape', 'Wow Grape', 10),
  ('sd-11', 'pina-colada', 'Piña Colada', 11),
  ('sd-12', 'slurp-juice', 'Slurp Juice', 12);

INSERT INTO delivery_zones (id, name, fee_cents) VALUES
  ('z1', 'Zone 1 · Liverpool Local', 0),
  ('z2', 'Zone 2 · South-West & Parramatta', 1900),
  ('z3', 'Zone 3 · Sydney Metro', 2900),
  ('z4', 'Zone 4 · Outer Metro & Fringe', 3900);

INSERT INTO delivery_zone_prefixes (postcode_prefix, zone_id) VALUES
  ('216', 'z1'), ('217', 'z1'), ('218', 'z1'), ('219', 'z1'), ('220', 'z1'),
  ('214', 'z2'), ('215', 'z2'), ('255', 'z2'), ('256', 'z2'), ('274', 'z2'), ('275', 'z2'), ('276', 'z2'), ('277', 'z2'),
  ('200', 'z3'), ('201', 'z3'), ('202', 'z3'), ('203', 'z3'), ('204', 'z3'), ('205', 'z3'), ('206', 'z3'), ('207', 'z3'), ('208', 'z3'), ('209', 'z3'), ('210', 'z3'), ('211', 'z3'), ('212', 'z3'), ('213', 'z3'), ('221', 'z3'), ('222', 'z3'), ('223', 'z3'),
  ('225', 'z4'), ('226', 'z4'), ('227', 'z4'), ('245', 'z4'), ('248', 'z4'), ('250', 'z4'), ('251', 'z4'), ('252', 'z4'), ('253', 'z4'), ('278', 'z4');

INSERT INTO schema_migrations (version) VALUES ('002_seed_launch_config');

COMMIT;
