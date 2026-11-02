// Copy the data snapshot into the Cloudflare Worker's static assets (after `opennextjs-cloudflare build`): the
// Worker has no data/ on disk and reads it through its ASSETS binding (src/lib/data-assets.ts). Only the gallery
// snapshot is copied: rooms.json, phases.json and the guide scripts stay local (their features are off there).
//
//   node scripts/cf-data.mjs        # part of `npm run cf:build`
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const site = path.join(root, "data", "site", "museum.json");
const src = fs.existsSync(site) ? site : path.join(root, "data", "wikipedia", "museum.json");
if (!fs.existsSync(src)) {
  console.error("No data/site/museum.json or data/wikipedia/museum.json: run `npm run ingest` first.");
  process.exit(1);
}
const assets = path.join(root, ".open-next", "assets");
if (!fs.existsSync(assets)) {
  console.error("No .open-next/assets: run `opennextjs-cloudflare build` first.");
  process.exit(1);
}
const out = path.join(assets, "_data");
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(src, path.join(out, "museum.json"));
console.log(`${path.relative(root, src)} -> ${path.relative(root, path.join(out, "museum.json"))}`);
