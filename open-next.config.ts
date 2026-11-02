import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// Cloudflare Workers (`npm run cf:build`, docs/DEVELOPMENT.md "Deploy"). The data is a snapshot built on this
// machine, so the prerendered pages are served as they were built, with no revalidation and no R2 or KV to set up.
// Rebuild and deploy to refresh them.
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
  enableCacheInterception: true,
});
