// create-checkout-session
//
// PHASE 1 (current): no payment provider is configured. This function validates
// the checkout, prices it server-side, checks availability and creates a
// `pending_payment` order with its items, then returns a development response.
// It never confirms a booking and never reports a payment.
//
// PHASE 2 (later, provider not yet chosen): after the order is created, create
// the provider's hosted checkout session using its secret key (Edge Function
// secret), store payment_provider + payment_session_id on the order, and return
// the checkout URL. A separate webhook function verifies the provider's
// signature and sets status = 'paid' + payment_reference, which triggers the
// order emails (send-order-notifications). No provider secrets exist yet.
//
// Deployed with verify_jwt = false: the new publishable keys are not JWTs, so the
// caller's `apikey` header is checked in code instead.

import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const MAX_BODY_BYTES = 20_000;

// Browser origins allowed to call this function (comma-separated Edge Function secret).
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "http://localhost:3000,http://127.0.0.1:3000")
  .split(",").map((o) => o.trim()).filter(Boolean);

const PUBLISHABLE_KEYS = Object.values(JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}")) as string[];
const SECRET_KEY = (JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, string>).default
  ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// Server-side client: bypasses RLS. Never sent to the browser.
const admin = createClient(Deno.env.get("SUPABASE_URL")!, SECRET_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Only these fields are passed to the database. Anything else the browser sends
// (prices, totals, status, timestamps…) is dropped here.
const TEXT_FIELDS = [
  "customer_name", "customer_email", "customer_phone", "customer_dob",
  "delivery_street", "delivery_unit", "delivery_suburb", "delivery_state", "delivery_postcode",
  "delivery_instructions", "event_notes", "event_date", "delivery_window", "collection_window",
  "recipient_type", "recipient_name",
] as const;

function cors(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "apikey, content-type, x-client-info",
    "Vary": "Origin",
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

function sanitise(body: Record<string, unknown>) {
  const p: Record<string, unknown> = {};
  for (const k of TEXT_FIELDS) {
    const v = body[k];
    if (typeof v === "string") p[k] = v.slice(0, 2000);
  }
  p.terms_accepted = body.terms_accepted === true;
  p.responsible_supply_ack = body.responsible_supply_ack === true;
  // Items: flavour id + quantity only. Any price on an item is ignored.
  p.items = Array.isArray(body.items)
    ? body.items.slice(0, 50).map((i) => {
      const it = (i ?? {}) as Record<string, unknown>;
      return { flavour_id: it.flavour_id, quantity: it.quantity };
    })
    : body.items;
  return p;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);

  const apikey = req.headers.get("apikey");
  if (!apikey || !PUBLISHABLE_KEYS.includes(apikey)) return json({ error: "Unauthorised." }, 401, origin);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Request too large." }, 413, origin);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid request." }, 400, origin);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid request." }, 400, origin);

  const { data, error } = await admin.rpc("create_pending_order", { p: sanitise(body as Record<string, unknown>) });

  if (error) {
    // Business-rule errors raised by the database carry SQLSTATE SD400/SD409/SD422.
    if (error.code === "SD409") {
      let availability: unknown = null;
      try { availability = JSON.parse(error.details ?? "null"); } catch { /* ignore */ }
      return json({ error: error.message, ...(availability as object) }, 409, origin);
    }
    if (error.code === "SD400" || error.code === "SD422") return json({ error: error.message }, error.code === "SD400" ? 400 : 422, origin);
    console.error("create_pending_order failed", error.code, error.message);
    return json({ error: "Something went wrong on our side. Please try again, or email spiritdropjd@gmail.com." }, 500, origin);
  }

  const o = data as Record<string, unknown>;
  return json({
    status: "payment_provider_not_configured",
    message: "Order prepared for development only. Online payment is not set up yet: no payment has been taken and this booking is not confirmed.",
    order_number: o.order_number,
    order_status: o.status,
    event_date: o.event_date,
    collection_date: o.collection_date,
    hold_expires_at: o.hold_expires_at,
    currency: o.currency,
    items: o.items,
    dispenser_quantity: o.dispenser_quantity,
    product_subtotal_cents: o.product_subtotal_cents,
    bond_total_cents: o.bond_total_cents,
    delivery_fee_cents: o.delivery_fee_cents,
    addon_total_cents: o.addon_total_cents,
    total_cents: o.total_cents,
  }, 200, origin);
});
