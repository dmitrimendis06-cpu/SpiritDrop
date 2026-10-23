-- The API route generates the booking id so it can show the customer a reference
-- without needing SELECT access (inserts return no rows to anon).
grant insert (id) on table public.booking_requests to anon;
