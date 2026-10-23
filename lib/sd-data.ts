import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

/**
 * The site's shared data layer (public/spiritdrop-data.js), evaluated on the
 * server so API routes price and validate orders from the same single source
 * of truth the browser uses — without trusting any figure the browser sends.
 */
type Zone = { id: string; name: string; fee: number };
type Slot = { id: string; label: string };
type Flavour = { name: string; slug: string };

export type SDData = {
  RULES: { dispenserPrice: number; bondPerDispenser: number };
  DELIVERY_SLOTS: Slot[];
  COLLECTION_SLOTS: Slot[];
  checkZone(postcode: string): { ok: boolean; zone?: Zone; fee?: number; msg: string };
  minEventDate(): string;
  collectionDate(eventISO: string): string;
  flavourByName(name: string): Flavour | null;
};

let cached: SDData | undefined;

export function sdData(): SDData {
  if (!cached) {
    const code = fs.readFileSync(path.join(process.cwd(), "public", "spiritdrop-data.js"), "utf8");
    const sandbox = { window: {} as { SD?: SDData } };
    vm.runInNewContext(code, sandbox, { filename: "spiritdrop-data.js" });
    if (!sandbox.window.SD) throw new Error("spiritdrop-data.js did not define window.SD");
    cached = sandbox.window.SD;
  }
  return cached;
}
