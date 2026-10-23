import { createClient } from "@supabase/supabase-js";

/**
 * Supabase client for server-side use in API routes.
 *
 * Uses the publishable key, so it has exactly the access the database grants
 * the `anon` role: insert-only on the form tables (see supabase/migrations/).
 * There is no user auth yet, so no session is stored.
 */
export function supabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (see .env.example)");
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
