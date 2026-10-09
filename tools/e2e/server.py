"""Local HTTPS server for e2e tests (chatgpt.com is HSTS-preloaded, so it must be https).
Usage: [E2E_LANG=en|tr] python3 tools/e2e/server.py <port> <output-dir> <cert.pem> <key.pem>
/c/<uuid> serves a plain chat page; /api and /backend-api serve a mock ChatGPT API."""
import base64, http.server, json, os, re, ssl, subprocess, sys, time, urllib.parse

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PORT, OUT, CERT, KEY = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
os.makedirs(OUT, exist_ok=True)

# Mock ChatGPT API for the real-extension test (data from tools/fixture.js).
FIX = json.loads(subprocess.check_output(["node", "-e", """
const f = require(process.argv[1]);
const files = Object.fromEntries(Object.entries(f.files).map(([k, v]) => [k, { name: v.name, type: v.type, b64: Buffer.from(v.body).toString("base64") }]));
console.log(JSON.stringify({ conversation: f.conversation, files, chatTitles: f.chatTitles }));""", os.path.join(ROOT, "tools", "fixture.js")]))
TITLES = FIX["chatTitles"]["tr" if os.environ.get("E2E_LANG", "en") == "tr" else "en"]  # same language as extension.js
CHATS = [{"id": f"0000000{n}-1111-2222-3333-44444444444{n}", "title": t, "update_time": f"2025-10-0{n}T10:00:00Z"}
         for n, t in enumerate(TITLES, 1)]

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def api(self, path, query):
        if self.headers.get("authorization") != "Bearer TOKEN" and path != "/api/auth/session": return self.send_json({}, 401)
        if path == "/api/auth/session": return self.send_json({"accessToken": "TOKEN"})
        if path == "/backend-api/conversations":
            items = [] if query.get("is_archived") == ["true"] else CHATS
            return self.send_json({"items": items, "total": len(items)})
        if "/interpreter/download" in path: return self.send_json({"download_url": "/cdn/sandbox", "file_name": "result.csv"})
        m = re.match(r"^/backend-api/share/([\w-]+)$", path)
        if m and m.group(1).startswith("3333"): return self.send_json({}, 404)  # DOM fallback test
        if m:  # share: flat message list
            conv = FIX["conversation"]; chain = []; node = conv["current_node"]
            while node: chain.insert(0, {"id": node, "message": conv["mapping"][node]["message"]}); node = conv["mapping"][node]["parent"]
            return self.send_json({"title": "Shared chat", "linear_conversation": chain})
        m = re.match(r"^/backend-api/files/(.+)/download$", path)
        if m: return self.send_json({"download_url": f"/cdn/{m.group(1)}", "file_name": FIX["files"][m.group(1)]["name"]} if m.group(1) in FIX["files"] else {}, 200 if m.group(1) in FIX["files"] else 404)
        m = re.match(r"^/backend-api/conversation/([\w-]+)$", path)
        if m:
            time.sleep(0.15)
            conv = dict(FIX["conversation"]); title = next((c["title"] for c in CHATS if c["id"] == m.group(1)), None)
            if title: conv["title"] = title
            return self.send_json(conv)
        m = re.match(r"^/cdn/(.+)$", path)
        if m and m.group(1) in FIX["files"]:
            f = FIX["files"][m.group(1)]; body = base64.b64decode(f["b64"])
            self.send_response(200); self.send_header("content-type", f["type"]); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        self.send_json({}, 404)
    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path.startswith(("/api/", "/backend-api/", "/cdn/")): return self.api(url.path, urllib.parse.parse_qs(url.query))
        if url.path.startswith(("/c/", "/share/")):  # plain chat page for the real-extension test
            html = (f"<!doctype html><meta charset=utf-8><title>ChatGPT - {TITLES[0]}</title><body style='font:16px system-ui'>"
                    "<header style='display:flex;gap:8px;align-items:center;padding:8px'><h3 style='flex:1'>ChatGPT (mock page)</h3>"
                    "<button data-testid='share-chat-button'>Share</button></header>"
                    + ("<div data-message-author-role='user' data-message-id='u'><div class='whitespace-pre-wrap'>Short question?</div></div>"
                       "<div data-message-author-role='assistant' data-message-id='a'><div class='markdown'><h2>Answer</h2><p>Text <strong>bold</strong> and "
                       "<span class='katex'><span class='katex-mathml'><math><semantics><mi>x</mi><annotation encoding='application/x-tex'>x^2</annotation></semantics></math></span></span>.</p>"
                       "<pre><div>python<button>Copy code</button></div><code class='language-python'>print(1)\n</code></pre><ul><li>one</li><li>two</li></ul></div></div>"
                       if url.path.startswith("/share/3333") else "")).encode()
            self.send_response(200); self.send_header("content-type", "text/html; charset=utf-8"); self.send_header("content-length", str(len(html))); self.end_headers(); self.wfile.write(html); return
        super().do_GET()
    def translate_path(self, path):
        p = urllib.parse.urlparse(path).path
        return super().translate_path(p)
    def do_POST(self):
        name = os.path.basename(urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("name", ["out.bin"])[0])
        data = self.rfile.read(int(self.headers.get("content-length", 0)))
        open(os.path.join(OUT, name), "wb").write(data)
        self.send_response(204); self.end_headers()
    def log_message(self, *a): pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(CERT, KEY)
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
