// Fails if the website's preview data (public/spiritdrop-data.js) disagrees with
// the database catalog the backend prices from (catalog_flavours, delivery_zones,
// pricing_config). Run after changing either side:
//
//   npm run check:catalog
import fs from "node:fs";
import vm from "node:vm";

const env = Object.fromEntries(
  fs.readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const get = async (path) => {
  const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
};

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL("../public/spiritdrop-data.js", import.meta.url), "utf8"), sandbox);
const { SD, FLAVOURS } = sandbox.window;

const [flavours, zones, [pricing]] = await Promise.all([
  get("catalog_flavours?select=id,slug,name&order=sort_order"),
  get("delivery_zones?select=id,name,fee_cents,postcode_prefixes&order=id"),
  get("pricing_config?select=dispenser_price_cents,bond_per_dispenser_cents,drinks_per_dispenser"),
]);

const problems = [];
const same = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${label}\n  site: ${JSON.stringify(a)}\n  db:   ${JSON.stringify(b)}`); };

same("flavours", FLAVOURS.map((f) => [f.id, f.slug, f.name]), flavours.map((f) => [f.id, f.slug, f.name]));
same("zones", SD.ZONES.map((z) => [z.id, z.name, z.fee * 100, z.prefixes]), zones.map((z) => [z.id, z.name, z.fee_cents, z.postcode_prefixes]));
same("pricing", [SD.RULES.dispenserPrice * 100, SD.RULES.bondPerDispenser * 100, SD.RULES.drinksPerDispenser],
  [pricing.dispenser_price_cents, pricing.bond_per_dispenser_cents, pricing.drinks_per_dispenser]);

if (problems.length) {
  console.error("Catalog drift between public/spiritdrop-data.js and Supabase:\n" + problems.join("\n"));
  process.exit(1);
}
console.log(`Catalog in sync: ${flavours.length} flavours, ${zones.length} zones, $${pricing.dispenser_price_cents / 100} + $${pricing.bond_per_dispenser_cents / 100} bond.`);
