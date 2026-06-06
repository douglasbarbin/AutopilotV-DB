#!/usr/bin/env bash
set -euo pipefail

# Build the project's native modules (better-sqlite3, node-pty) for the
# current system Node, not for Electron.
#
# Why: the project's `postinstall` runs `electron-builder install-app-deps`,
# which rebuilds native modules against Electron's V8 headers. vitest runs
# under system Node, which can't load those binaries (`NODE_MODULE_VERSION`
# mismatch). CI workflows that need to run `npm test` use this script to
# build Node-ABI binaries before testing, then later switch back to
# Electron-ABI binaries for the app build/package step.
#
# node-gyp is invoked directly (not via `npm rebuild`) because `npm rebuild`
# re-runs the `electron` package's install.js lifecycle, which leaves
# node-gyp pointed at ~/.electron-gyp/ and ends up rebuilding for Electron
# anyway. Direct node-gyp calls use the current Node's headers and never
# touch the Electron cache.

for pkg in better-sqlite3 node-pty; do
  if [ -d "node_modules/$pkg" ]; then
    echo "→ $pkg (Node $(node --version))"
    rm -rf "node_modules/$pkg/build"
    npx node-gyp rebuild --directory="node_modules/$pkg"
  fi
done
