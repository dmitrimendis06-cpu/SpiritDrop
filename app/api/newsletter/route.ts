import { EMAIL_RE, FormError, fail, ok, readJson, text } from "@/lib/form";
import { supabase } from "@/lib/supabase";

/** Optional "Drop List" sign-up. Separate from ordering; never automatic. */
export async function POST(req: Request) {
  try {
    const b = await readJson(req);
    const email = text(b.email, "email address", { required: true, max: 254 })!.toLowerCase();
    if (!EMAIL_RE.test(email)) throw new FormError("Enter a valid email address.");

    const { error } = await supabase().from("newsletter_signups").insert({ email });
    // Already subscribed: treat as success so the form doesn't reveal who is on the list.
    if (error && error.code !== "23505") throw error;
    return ok();
  } catch (err) {
    return fail(err);
  }
}
