// The Cloudflare Worker's entry (wrangler.jsonc "main"): OpenNext's Worker (`npm run cf:build`), except that the
// data snapshot under /_data/ is the server's own (src/lib/data-assets.ts reads it through the ASSETS binding);
// OpenNext would otherwise serve it to anyone as a static file.
import handler from "./.open-next/worker.js";

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith("/_data/")) return new Response("Not found", { status: 404 });
    return handler.fetch(request, env, ctx);
  },
};
