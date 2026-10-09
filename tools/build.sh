#!/usr/bin/env bash
# Web Store yükleme paketini üretir: dist/chatgpt-sohbet-indir-<sürüm>.zip
# Yalnızca çalışma zamanı dosyalarını içerir (test, belge, Store görselleri hariç).
set -euo pipefail
cd "$(dirname "$0")/.."
node tools/locales.js >/dev/null
node tools/test.js
version=$(node -p "require('./manifest.json').version")
out="dist/chatgpt-sohbet-indir-$version.zip"
mkdir -p dist
rm -f "$out"
# Yalnızca manifestte kullanılan ikonlar pakete girer (büyük ana görseller hariç).
icons=$(node -p "[...new Set([...Object.values(require('./manifest.json').icons), ...Object.values(require('./manifest.json').action.default_icon)])].join(' ')")
zip -X -r "$out" manifest.json sidepanel.html sidepanel.css sidepanel.js print.html print.css print.js src vendor _locales $icons -x '*.DS_Store' >/dev/null
echo "Paket: $out ($(du -h "$out" | cut -f1))"
unzip -l "$out" | tail -n +4
