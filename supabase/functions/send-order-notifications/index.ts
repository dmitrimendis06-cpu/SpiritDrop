// send-order-notifications
//
// Called by the database (trigger private.orders_queue_paid_notifications) when an
// order becomes `paid`, or by staff to retry:
//   select private.queue_order_notifications('<order uuid>');
//
// Sends, at most once each:
//   * business — "NEW SPIRITDROP ORDER — SD-000123" to spiritdropjd@gmail.com
//   * customer — "Your drop is locked in" confirmation to the customer
//
// Email provider: Resend (https://resend.com). Configure as Edge Function secrets:
//   RESEND_API_KEY   e.g. re_…
//   EMAIL_FROM       e.g. "SpiritDrop <orders@spiritdrop.com.au>" (verified domain)
// Until both exist, nothing is sent: each notification is recorded as
// `provider_not_configured` and the response says `email_provider_not_configured`.
//
// Safety:
//   * Only orders whose status is paid (or later) are ever notified.
//   * public.claim_order_notification() makes each (order, kind) send once, even if
//     a payment webhook marks the order paid repeatedly or this function is retried.
//   * A failed send is logged (order_notifications.status = 'failed') for retry and
//     never changes the order's status. Supabase remains the source of truth.
//   * Emails never include date of birth or any payment credentials.
//
// verify_jwt = false: callers present the `x-notify-token` generated in Vault.

import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const BUSINESS_EMAIL = "spiritdropjd@gmail.com";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const EMAIL_FROM = Deno.env.get("EMAIL_FROM");

const SECRET_KEY = (JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, string>).default
  ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const admin = createClient(Deno.env.get("SUPABASE_URL")!, SECRET_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Kind = "business" | "customer";
type Email = { to: string; subject: string; text: string; html: string; replyTo?: string };

// Columns used in emails. customer_dob is deliberately NOT selected.
const ORDER_COLUMNS = [
  "id", "order_number", "status", "customer_name", "customer_email", "customer_phone",
  "event_date", "collection_date", "delivery_window", "collection_window",
  "delivery_street", "delivery_unit", "delivery_suburb", "delivery_state", "delivery_postcode",
  "dispenser_quantity", "product_subtotal_cents", "delivery_fee_cents", "bond_total_cents",
  "addon_total_cents", "total_cents", "currency",
].join(",");

type Order = {
  id: string; order_number: string; status: string;
  customer_name: string; customer_email: string; customer_phone: string;
  event_date: string; collection_date: string; delivery_window: string; collection_window: string;
  delivery_street: string; delivery_unit: string | null; delivery_suburb: string; delivery_state: string; delivery_postcode: string;
  dispenser_quantity: number; product_subtotal_cents: number; delivery_fee_cents: number; bond_total_cents: number;
  addon_total_cents: number; total_cents: number; currency: string;
};
type Item = { flavour_name_snapshot: string; quantity: number };

const PAID_STATUSES = ["paid", "preparing", "out_for_delivery", "delivered", "collected", "bond_refunded"];

const money = (cents: number) => (cents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
const date = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function render(title: string, rows: [string, string][], intro?: string, footer?: string) {
  const text = [title, intro ?? "", ...rows.map(([k, v]) => `${k}: ${v}`), footer ?? ""].filter(Boolean).join("\n");
  const html =
    `<div style="font-family:Arial,sans-serif;color:#111;max-width:560px">` +
    `<h2 style="margin:0 0 12px">${esc(title)}</h2>` +
    (intro ? `<p>${esc(intro)}</p>` : "") +
    `<table cellpadding="6" style="border-collapse:collapse">` +
    rows.map(([k, v]) => `<tr><td style="color:#666;vertical-align:top">${esc(k)}</td><td style="white-space:pre-line"><b>${esc(v)}</b></td></tr>`).join("") +
    `</table>` +
    (footer ? `<p style="color:#666;margin-top:16px">${esc(footer)}</p>` : "") +
    `</div>`;
  return { text, html };
}

function businessEmail(o: Order, items: Item[]): Email {
  const flavours = items.map((i) => `${i.quantity} × ${i.flavour_name_snapshot}`).join("\n");
  const body = render(`New SpiritDrop order — ${o.order_number}`, [
    ["Order number", o.order_number],
    ["Payment status", o.status.toUpperCase()],
    ["Customer", o.customer_name],
    ["Email", o.customer_email],
    ["Phone", o.customer_phone],
    ["Event date", date(o.event_date)],
    ["Delivery suburb", `${o.delivery_suburb} ${o.delivery_postcode}`],
    ["Delivery window", o.delivery_window],
    ["Collection (next day)", `${date(o.collection_date)}, ${o.collection_window}`],
    ["Flavours", flavours],
    ["Dispensers", String(o.dispenser_quantity)],
    ["Product subtotal", money(o.product_subtotal_cents)],
    ["Delivery fee", money(o.delivery_fee_cents)],
    ["Refundable equipment bond", money(o.bond_total_cents)],
    ["Total paid", money(o.total_cents)],
  ], undefined, "Full delivery address and order details are in Supabase (orders table).");
  return { to: BUSINESS_EMAIL, subject: `NEW SPIRITDROP ORDER — ${o.order_number}`, ...body };
}

function customerEmail(o: Order, items: Item[]): Email {
  const flavours = items.map((i) => `${i.quantity} × ${i.flavour_name_snapshot}`).join("\n");
  const address = [[o.delivery_unit, o.delivery_street].filter(Boolean).join(", "), `${o.delivery_suburb} ${o.delivery_state} ${o.delivery_postcode}`].join("\n");
  const body = render("Your drop is locked in", [
    ["Order number", o.order_number],
    ["Event date", date(o.event_date)],
    ["Flavours", flavours],
    ["Dispensers", String(o.dispenser_quantity)],
    ["Delivery window", o.delivery_window],
    ["Collection", `${date(o.collection_date)}, ${o.collection_window}`],
    ["Delivery address", address],
    ["Product amount", money(o.product_subtotal_cents)],
    ["Delivery fee", money(o.delivery_fee_cents)],
    ["Refundable equipment bond", money(o.bond_total_cents)],
    ["Total paid", money(o.total_cents)],
  ], `Thanks ${o.customer_name.split(" ")[0]} — your payment is confirmed and your SpiritDrop booking is set.`,
  `The person receiving the delivery must be 18+ and may be asked for valid ID. Questions or changes: ${BUSINESS_EMAIL}`);
  return { to: o.customer_email, subject: `Your drop is locked in — ${o.order_number}`, replyTo: BUSINESS_EMAIL, ...body };
}

async function sendViaResend(e: Email, idempotencyKey: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey, // provider-side guard against duplicates too
      },
      body: JSON.stringify({ from: EMAIL_FROM, to: [e.to], subject: e.subject, text: e.text, html: e.html, reply_to: e.replyTo }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.id) return { ok: false, error: `HTTP ${r.status}: ${JSON.stringify(j).slice(0, 500)}` };
    return { ok: true, id: j.id };
  } catch (err) {
    return { ok: false, error: `network: ${String(err).slice(0, 500)}` };
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const { data: tokenOk } = await admin.rpc("verify_order_notify_token", { p_token: req.headers.get("x-notify-token") });
  if (tokenOk !== true) return json({ error: "Unauthorised." }, 401);

  const body = await req.json().catch(() => null) as { order_id?: string; dry_run?: boolean } | null;
  const orderId = body?.order_id;
  if (!orderId || !/^[0-9a-f-]{36}$/i.test(orderId)) return json({ error: "order_id required." }, 400);

  const { data: order, error: orderErr } = await admin.from("orders").select(ORDER_COLUMNS).eq("id", orderId).maybeSingle();
  if (orderErr) { console.error("load order failed", orderErr.message); return json({ error: "Could not load order." }, 500); }
  if (!order) return json({ error: "Order not found." }, 404);
  const o = order as unknown as Order;

  if (!PAID_STATUSES.includes(o.status)) {
    return json({ order_number: o.order_number, status: "not_paid", detail: `Order is ${o.status}; nothing sent.` }, 409);
  }

  const { data: itemRows } = await admin.from("order_items").select("flavour_name_snapshot,quantity").eq("order_id", o.id);
  const items = (itemRows ?? []) as Item[];
  const emails: Record<Kind, Email> = { business: businessEmail(o, items), customer: customerEmail(o, items) };

  // Preview only (token-protected): renders both emails without claiming or sending.
  if (body?.dry_run === true) {
    return json({ order_number: o.order_number, dry_run: true, emails: Object.fromEntries(Object.entries(emails).map(([k, e]) => [k, { to: e.to, subject: e.subject, text: e.text }])) });
  }

  const configured = Boolean(RESEND_API_KEY && EMAIL_FROM);
  const results: Record<string, string> = {};
  for (const kind of ["business", "customer"] as Kind[]) {
    const { data: claimed, error: claimErr } = await admin.rpc("claim_order_notification", { p_order_id: o.id, p_kind: kind });
    if (claimErr) { results[kind] = "error"; console.error("claim failed", kind, claimErr.message); continue; }
    if (claimed !== true) { results[kind] = "already_sent_or_in_progress"; continue; }

    if (!configured) {
      await admin.rpc("record_order_notification", { p_order_id: o.id, p_kind: kind, p_status: "provider_not_configured" });
      results[kind] = "email_provider_not_configured";
      continue;
    }

    const sent = await sendViaResend(emails[kind], `${o.id}-${kind}`);
    if (sent.ok) {
      await admin.rpc("record_order_notification", { p_order_id: o.id, p_kind: kind, p_status: "sent", p_message_id: sent.id });
      results[kind] = "sent";
    } else {
      // Order stays paid; failure is logged for retry.
      await admin.rpc("record_order_notification", { p_order_id: o.id, p_kind: kind, p_status: "failed", p_error: sent.error });
      console.error("email send failed", o.order_number, kind, sent.error);
      results[kind] = "failed";
    }
  }

  return json({
    order_number: o.order_number,
    status: configured ? "processed" : "email_provider_not_configured",
    results,
  });
});
