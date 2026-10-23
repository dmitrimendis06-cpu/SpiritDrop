import { EMAIL_RE, FormError, ISO_DATE_RE, PHONE_RE, fail, ok, readJson, text } from "@/lib/form";
import { supabase } from "@/lib/supabase";

/** Event enquiry form (Contact page + home page). */
export async function POST(req: Request) {
  try {
    const b = await readJson(req);
    const row = {
      name: text(b.name, "name", { required: true, max: 120 }),
      phone: text(b.phone, "phone number", { required: true, max: 30 }),
      email: text(b.email, "email", { required: true, max: 254 }),
      event_type: text(b.type, "event type", { max: 60 }),
      event_date: text(b.date, "event date", { max: 10 }),
      guests: text(b.guests, "guest count", { max: 30 }),
      suburb: text(b.suburb, "suburb or postcode", { max: 120 }),
      message: text(b.message, "message", { max: 4000 }),
    };
    if (!PHONE_RE.test(row.phone!)) throw new FormError("Enter a contactable phone number.");
    if (!EMAIL_RE.test(row.email!)) throw new FormError("Enter a valid email address.");
    if (row.event_date && !ISO_DATE_RE.test(row.event_date)) throw new FormError("Enter a valid event date.");

    const { error } = await supabase().from("enquiries").insert(row);
    if (error) throw error;
    return ok();
  } catch (err) {
    return fail(err);
  }
}
