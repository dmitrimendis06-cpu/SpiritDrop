import { NextResponse } from "next/server";

/** Shared helpers for the public form API routes. */

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const PHONE_RE = /^[0-9+()\s-]{8,30}$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class FormError extends Error {}

/** Trimmed string field. Required fields throw FormError with a customer-facing message. */
export function text(value: unknown, label: string, opts: { required?: boolean; max: number }): string | null {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) {
    if (opts.required) throw new FormError(`Enter your ${label}.`);
    return null;
  }
  if (v.length > opts.max) throw new FormError(`Your ${label} is too long.`);
  return v;
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FormError("Invalid request.");
  return body as Record<string, unknown>;
}

export function ok(data: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: true, ...data });
}

/** Turns validation errors into 400s and anything else into a logged 500. */
export function fail(err: unknown) {
  if (err instanceof FormError) return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
  console.error("[form api]", err);
  return NextResponse.json(
    { ok: false, error: "Something went wrong on our side. Please try again, or email spiritdropjd@gmail.com." },
    { status: 500 },
  );
}
