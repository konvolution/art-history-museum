// The data snapshot on Cloudflare Workers, where there is no data/ on disk: `npm run cf:build` copies the JSON
// the site reads into the Worker's static assets under /_data/ (scripts/cf-data.mjs), and wrangler.jsonc routes
// /_data/* to the Worker first, which has no page there, so visitors get a 404. The Worker reads the files
// through its ASSETS binding instead.

import "server-only";

/** Running in a Cloudflare Worker (workerd sets this user agent). */
export const onWorkers = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

/** A JSON file from data/, as `npm run cf:build` copied it (e.g. "museum.json"); null when it was not copied. */
export async function readAssetJson<T>(name: string): Promise<T | null> {
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const { env } = await getCloudflareContext({ async: true });
  const assets = (env as { ASSETS?: { fetch(input: string): Promise<Response> } }).ASSETS;
  if (!assets) return null;
  const res = await assets.fetch(`https://assets.local/_data/${name}`);
  return res.ok ? ((await res.json()) as T) : null;
}
