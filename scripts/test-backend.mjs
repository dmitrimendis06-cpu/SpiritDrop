// Backend security + pricing tests. Uses ONLY the public publishable key,
// exactly like a browser (or an attacker) would.
//
//   node scripts/test-backend.mjs
//
// Creates test orders with email test+backend@example.com on far-future dates.
// Delete them afterwards (see DEPLOY.md "Test data clean-up").
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const FN = `${URL_}/functions/v1/create-checkout-session`;
const H = { apikey: KEY, "Content-Type": "application/json" };

let pass = 0, fail = 0;
function check(name, ok, info) {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? `  — ${info}` : ""}`);
}

async function rest(path, init = {}) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function checkout(body) {
  const r = await fetch(FN, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// Dates in Sydney time.
const sydToday = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const D1 = addDays(sydToday, 400); // general tests
const D2 = addDays(sydToday, 420); // capacity + race tests (isolated)

const base = (over = {}) => ({
  customer_name: "TEST Backend", customer_email: "test+backend@example.com", customer_phone: "0400 000 000",
  customer_dob: "1990-05-05",
  delivery_street: "1 Test Street", delivery_suburb: "Sydney", delivery_state: "NSW", delivery_postcode: "2000",
  event_date: D1, delivery_window: "h14", collection_window: "h10",
  recipient_type: "self", terms_accepted: true, responsible_supply_ack: true,
  items: [{ flavour_id: "sd-07", quantity: 1 }],
  ...over,
});

// A–B: anonymous reads of private data are denied.
for (const t of ["enquiries", "booking_requests", "newsletter_signups", "orders", "order_items", "order_addons", "inventory_config"]) {
  const r = await rest(`${t}?select=*`);
  check(`A/B anon SELECT ${t} denied`, r.status === 401 || r.status === 403, `HTTP ${r.status}`);
}
// Anonymous writes to orders are denied, including a forged "paid" order.
{
  const r = await rest("orders", { method: "POST", body: JSON.stringify({ customer_name: "x", status: "paid", total_cents: 1 }) });
  check("anon INSERT orders (status=paid) denied", r.status === 401 || r.status === 403, `HTTP ${r.status}`);
  const u = await rest("orders?id=not.is.null", { method: "PATCH", body: JSON.stringify({ status: "paid" }) });
  check("anon UPDATE orders denied", u.status === 401 || u.status === 403, `HTTP ${u.status}`);
  const d = await rest("orders?id=not.is.null", { method: "DELETE" });
  check("anon DELETE orders denied", d.status === 401 || d.status === 403, `HTTP ${d.status}`);
  const rpc = await rest("rpc/create_pending_order", { method: "POST", body: JSON.stringify({ p: base() }) });
  check("anon cannot call create_pending_order directly", rpc.status === 401 || rpc.status === 403 || rpc.status === 404, `HTTP ${rpc.status}`);
}
// Public catalog is readable (non-sensitive).
{
  const r = await rest("catalog_flavours?select=id,name&order=sort_order");
  check("anon can read the 12-flavour catalog", r.status === 200 && r.body.length === 12, `${r.body?.length} flavours`);
}
// Edge Function requires the project's publishable key.
{
  const r = await fetch(FN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(base()) });
  check("checkout without apikey rejected", r.status === 401, `HTTP ${r.status}`);
}

// C–D: browser-supplied prices are ignored.
{
  const r = await checkout(base({
    items: [{ flavour_id: "sd-07", quantity: 2, unit_price_cents: 100 }],
    unit_price_cents: 100, product_subtotal_cents: 200, bond_total_cents: 0, delivery_fee_cents: 0, total_cents: 1,
    status: "paid", paid_at: "2020-01-01T00:00:00Z",
  }));
  const b = r.body || {};
  check("C dispenser price $1 sent -> backend charges $200", r.status === 200 && b.items?.[0]?.unit_price_cents === 20000 && b.product_subtotal_cents === 40000, `unit ${b.items?.[0]?.unit_price_cents}, subtotal ${b.product_subtotal_cents}`);
  check("D bond $0 sent -> backend charges $50 per dispenser", b.bond_total_cents === 10000, `bond ${b.bond_total_cents}`);
  check("delivery fee from zone (2000 = Zone 3, $29)", b.delivery_fee_cents === 2900, `fee ${b.delivery_fee_cents}`);
  check("total recomputed", b.total_cents === 40000 + 10000 + 2900, `total ${b.total_cents}`);
  check("forged status=paid ignored -> pending_payment", b.order_status === "pending_payment", `status ${b.order_status}`);
  check("development response, not a confirmation", b.status === "payment_provider_not_configured" && /^SD-\d{6}$/.test(b.order_number || ""), `${b.status} ${b.order_number}`);
}

// Validation.
const rejects = [
  ["unknown flavour id", base({ items: [{ flavour_id: "sd-99", quantity: 1 }] }), 422],
  ["flavour NAME instead of id", base({ items: [{ flavour_id: "Mint Mojito", quantity: 1 }] }), 422],
  ["fractional quantity", base({ items: [{ flavour_id: "sd-07", quantity: 1.5 }] }), 400],
  ["zero quantity", base({ items: [{ flavour_id: "sd-07", quantity: 0 }] }), 400],
  ["under 18", base({ customer_dob: addDays(sydToday, -365 * 17) }), 400],
  ["missing DOB", base({ customer_dob: "" }), 400],
  ["same-day event", base({ event_date: sydToday }), 400],
  ["past event", base({ event_date: addDays(sydToday, -1) }), 400],
  ["unsupported postcode (3000)", base({ delivery_postcode: "3000" }), 422],
  ["invalid postcode", base({ delivery_postcode: "20" }), 400],
  ["missing street", base({ delivery_street: " " }), 400],
  ["bad email", base({ customer_email: "nope" }), 400],
  ["missing phone", base({ customer_phone: "" }), 400],
  ["other recipient without name", base({ recipient_type: "other" }), 400],
  ["invalid recipient type", base({ recipient_type: "neighbour" }), 400],
  ["terms not accepted", base({ terms_accepted: false }), 400],
  ["responsible supply not acknowledged", base({ responsible_supply_ack: "yes" }), 400],
  ["invalid delivery window", base({ delivery_window: "h3" }), 400],
];
for (const [name, body, want] of rejects) {
  const r = await checkout(body);
  check(`rejects ${name}`, r.status === want, `HTTP ${r.status} ${r.body?.error ?? ""}`);
}

// Availability (capacity read from inventory_config).
const cap = (await (async () => {
  const r = await checkout(base({ event_date: D2, items: [{ flavour_id: "sd-01", quantity: 50 }] }));
  return r.body?.available_quantity;
})());
check("over-capacity request rejected with availability", typeof cap === "number", `available_quantity ${cap}`);
if (typeof cap === "number" && cap >= 2) {
  // Fill to one remaining, then race two customers for the last dispenser.
  const fill = await checkout(base({ event_date: D2, items: [{ flavour_id: "sd-01", quantity: cap - 1 }] }));
  check(`fill ${cap - 1} of ${cap}`, fill.status === 200, `HTTP ${fill.status}`);
  const over = await checkout(base({ event_date: D2, items: [{ flavour_id: "sd-02", quantity: 2 }] }));
  check("request 2 when 1 left -> 409", over.status === 409 && over.body.available_quantity === 1 && over.body.requested_quantity === 2, JSON.stringify(over.body));
  const nextDay = await checkout(base({ event_date: addDays(D2, 1), items: [{ flavour_id: "sd-02", quantity: 2 }] }));
  check("next day also blocked (dispensers out until collection)", nextDay.status === 409, `HTTP ${nextDay.status}`);
  const race = await Promise.all([1, 2, 3].map(() => checkout(base({ event_date: D2, items: [{ flavour_id: "sd-03", quantity: 1 }] }))));
  const won = race.filter((r) => r.status === 200).length;
  check("3 simultaneous customers, 1 dispenser left -> exactly 1 succeeds", won === 1, race.map((r) => r.status).join(","));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
