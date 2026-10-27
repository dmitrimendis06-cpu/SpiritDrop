import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Cache-busting for the site's own CSS/JS in public/.
 *
 * Their URLs never change between deploys and the host sends no cache headers,
 * so browsers can keep showing an old stylesheet with new markup. Appending a
 * short hash of the file's contents (?v=…) gives every changed file a new URL,
 * while unchanged files keep theirs.
 */
const cache = new Map<string, string>();
const isProd = process.env.NODE_ENV === "production";

/** "/spiritdrop.css" -> "/spiritdrop.css?v=3f2a9c1b7e" */
export function versioned(publicPath: string): string {
  let v = isProd ? cache.get(publicPath) : undefined;
  if (!v) {
    const file = fs.readFileSync(path.join(process.cwd(), "public", publicPath));
    v = createHash("sha256").update(file).digest("hex").slice(0, 10);
    cache.set(publicPath, v);
  }
  return `${publicPath}?v=${v}`;
}

/** Versions every src/href pointing at /spiritdrop*.css|js in a block of HTML. */
export function versionAssetUrls(html: string): string {
  return html.replace(
    /\b(src|href)="(\/spiritdrop[\w-]*\.(?:css|js))"/g,
    (_m, attr: string, p: string) => `${attr}="${versioned(p)}"`,
  );
}
