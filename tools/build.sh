#!/usr/bin/env bash
# Builds the Chrome Web Store upload package: dist/chat-downloader-<version>.zip
# Contains only runtime files (no tests, docs or Store images).
set -euo pipefail
cd "$(dirname "$0")/.."
node tools/locales.js >/dev/null
node tools/test.js
version=$(node -p "require('./manifest.json').version")
out="dist/chat-downloader-$version.zip"
mkdir -p dist
rm -f "$out"
# Only icons referenced by the manifest are packaged (not the large master images).
icons=$(node -p "[...new Set([...Object.values(require('./manifest.json').icons), ...Object.values(require('./manifest.json').action.default_icon)])].join(' ')")
zip -X -r "$out" manifest.json sidepanel.html sidepanel.css sidepanel.js print.html print.css print.js src vendor _locales $icons -x '*.DS_Store' >/dev/null
echo "Package: $out ($(du -h "$out" | cut -f1))"
unzip -l "$out" | tail -n +4
