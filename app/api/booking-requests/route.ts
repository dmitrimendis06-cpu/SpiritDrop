import { EMAIL_RE, FormError, ISO_DATE_RE, PHONE_RE, fail, ok, readJson, text } from "@/lib/form";
import { sdData } from "@/lib/sd-data";
import { supabase } from "@/lib/supabase";

const STATES = ["NSW", "ACT", "VIC", "QLD", "SA", "WA", "TAS", "NT"];

function age(dobISO: string): number | null {
  const [y, m, d] = dobISO.split("-").map(Number);
  const dob = new Date(y, m - 1, d);
  if (dob.getFullYear() !== y || dob.getMonth() !== m - 1 || dob.getDate() !== d) return null;
  const now = new Date();
  let a = now.getFullYear() - y;
  if (now.getMonth() < m - 1 || (now.getMonth() === m - 1 && now.getDate() < d)) a--;
  return a;
}

/**
 * Checkout booking request. No payment is taken.
 * Every price, fee, date and window is recomputed here from the shared data
 * layer; only the customer's choices are taken from the browser.
 */
export async function POST(req: Request) {
  try {
    const b = await readJson(req);
    const SD = sdData();

    // Dispensers: one flavour name each, all from the current range.
    const flavours = Array.isArray(b.flavours) ? b.flavours : [];
    if (flavours.length < 1 || flavours.length > 50) throw new FormError("Choose at least one dispenser.");
    for (const f of flavours) {
      if (typeof f !== "string" || !SD.flavourByName(f)) throw new FormError("One of the selected flavours is no longer available.");
    }

    // Event date and windows.
    const eventDate = text(b.eventDate, "event date", { required: true, max: 10 })!;
    if (!ISO_DATE_RE.test(eventDate) || eventDate < SD.minEventDate()) {
      throw new FormError("Choose an event date from tomorrow onwards.");
    }
    const delivery = SD.DELIVERY_SLOTS.find((s) => s.id === b.deliveryWindow);
    const collection = SD.COLLECTION_SLOTS.find((s) => s.id === b.collectionWindow);
    if (!delivery) throw new FormError("Pick a delivery window.");
    if (!collection) throw new FormError("Pick a collection window.");

    // Address and zone (the zone sets the delivery fee).
    const postcode = text(b.postcode, "postcode", { required: true, max: 4 })!;
    const zone = SD.checkZone(postcode);
    if (!zone.ok || !zone.zone) throw new FormError(zone.msg || "Enter a postcode inside our delivery area.");
    const state = typeof b.state === "string" && STATES.includes(b.state) ? b.state : "NSW";

    // Customer, age and recipient.
    const email = text(b.email, "email", { required: true, max: 254 })!;
    if (!EMAIL_RE.test(email)) throw new FormError("Enter a valid email address.");
    const phone = text(b.phone, "phone number", { required: true, max: 30 })!;
    if (!PHONE_RE.test(phone)) throw new FormError("Enter a contactable phone number.");
    const dob = text(b.dob, "date of birth", { required: true, max: 10 })!;
    const years = ISO_DATE_RE.test(dob) ? age(dob) : null;
    if (years === null) throw new FormError("Enter a valid date of birth.");
    if (years < 18) throw new FormError("You must be 18 or over to order alcohol.");
    const recipientType = b.recipient === "other" ? "other" : "self";
    const recipientName = recipientType === "other" ? text(b.recipientName, "recipient's name", { required: true, max: 120 }) : null;
    if (b.ack !== true) throw new FormError("Please confirm you understand your responsible-supply obligations.");
    if (b.terms !== true) throw new FormError("Please agree to the terms to continue.");

    // Money: recomputed, never taken from the browser.
    const dispensers = flavours.length;
    const subtotal = dispensers * SD.RULES.dispenserPrice;
    const bond = dispensers * SD.RULES.bondPerDispenser;
    const deliveryFee = zone.fee ?? 0;
    const total = subtotal + deliveryFee + bond;

    const id = crypto.randomUUID();
    const { error } = await supabase().from("booking_requests").insert({
      id,
      flavours,
      dispensers,
      event_date: eventDate,
      collection_date: SD.collectionDate(eventDate),
      delivery_window: delivery.label,
      collection_window: collection.label,
      street: text(b.street, "street address", { required: true, max: 200 }),
      unit: text(b.unit, "unit", { max: 60 }),
      suburb: text(b.suburb, "suburb", { required: true, max: 120 }),
      state,
      postcode,
      delivery_instructions: text(b.instructions, "delivery instructions", { max: 500 }),
      event_notes: text(b.notes, "event notes", { max: 2000 }),
      zone_id: zone.zone.id,
      customer_name: text(b.name, "name", { required: true, max: 120 }),
      customer_email: email,
      customer_phone: phone,
      date_of_birth: dob,
      recipient_type: recipientType,
      recipient_name: recipientName,
      responsible_supply_ack: true,
      terms_accepted: true,
      subtotal_aud: subtotal,
      delivery_fee_aud: deliveryFee,
      bond_aud: bond,
      total_aud: total,
    });
    if (error) throw error;

    return ok({ reference: "SD-" + id.slice(0, 8).toUpperCase(), total });
  } catch (err) {
    return fail(err);
  }
}
