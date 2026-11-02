#!/usr/bin/env bash
# `npm run cf:build` on Windows, through WSL. OpenNext's build symlinks files, which Windows refuses without
# Developer Mode, and Linux is where it is supported. The project (with data/, without node_modules or build
# output) is copied to a Linux folder, built there, and the Worker (.open-next) is copied back, ready for
# `wrangler dev` or `wrangler deploy` on Windows.
#
#   wsl bash scripts/cf-build-wsl.sh        # from the project folder (or: npm run cf:build:wsl)
set -euo pipefail

src="$(pwd)"
work="${CF_BUILD_DIR:-$HOME/.cache/vr-art-museum-build}"
mkdir -p "$work"

# copy the project in, keeping the Linux node_modules between builds
rsync -a --delete \
  --exclude node_modules --exclude .next --exclude .open-next --exclude .wrangler \
  --exclude verify-artifacts --exclude .git \
  "$src/" "$work/"

cd "$work"
# reinstall only when the lockfile changed (Linux's own native binaries: Next's compiler, sharp ...)
if [ ! -f node_modules/.lock-hash ] || [ "$(sha1sum package-lock.json)" != "$(cat node_modules/.lock-hash)" ]; then
  npm ci --no-audit --no-fund
  sha1sum package-lock.json > node_modules/.lock-hash
fi
npx opennextjs-cloudflare build
node scripts/cf-data.mjs

rm -rf "$src/.open-next"
cp -r "$work/.open-next" "$src/.open-next"
echo "Built in $work; .open-next copied back."
