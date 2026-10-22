import fs from "node:fs";
import path from "node:path";

/**
 * Renders a page body ported from the original static site (content/<name>.html).
 *
 * The markup is driven by the original vanilla JS in public/ (cart, data layer,
 * map, UX). Those scripts are part of the body HTML, so the browser runs them
 * while parsing the server-rendered page — exactly as on the static site.
 * React never re-renders this subtree, and the scripts mutate it before
 * hydration, hence suppressHydrationWarning.
 *
 * Navigation uses plain <a href> links (full page loads), so every page boots
 * its scripts fresh. Don't swap them for next/link without porting the scripts.
 */
export function LegacyPage({ name }: { name: string }) {
  const html = fs.readFileSync(path.join(process.cwd(), "content", `${name}.html`), "utf8");
  return (
    <div
      style={{ display: "contents" }}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
