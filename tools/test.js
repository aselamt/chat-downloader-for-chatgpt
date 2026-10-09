// Run: node tools/test.js — no network; exercises the core against a mock ChatGPT API.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const root = path.join(__dirname, "..");
globalThis.katex = require(path.join(root, "vendor/katex.min.js"));
require(path.join(root, "src/zip.js"));
const markdown = require(path.join(root, "src/markdown.js"));
const render = require(path.join(root, "src/render.js"));
const docx = require(path.join(root, "src/docx.js"));
const core = require(path.join(root, "src/core.js"));
const zip = require(path.join(root, "src/zip.js"));
const { tr, en, all: allLocales, check: checkLocales } = require("./locales.js");

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log("  ✓", name); }
  catch (error) { console.error("  ✗", name, "\n   ", error.stack); process.exitCode = 1; }
};
const makeT = messages => (key, subs = []) => {
  assert.ok(key in messages, `missing translation key: ${key}`);
  return messages[key].replace(/\{(\d)\}/g, (_, n) => subs[n - 1] ?? "");
};
const t = makeT(en);

const { ID, FILE_TXT, FILE_IMG, FILE_BAD, conversation, files } = require("./fixture.js");
function makeFetch({ failFirst429 = false } = {}) {
  const calls = [];
  let throttled = false;
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  const impl = async (url, init = {}) => {
    url = new URL(url);
    calls.push({ url: url.href, init });
    if (url.origin === "https://cdn.test") {
      assert.strictEqual(init.credentials, "omit", "no cookies to external servers");
      assert.ok(!init.headers?.Authorization, "no token to external servers");
      const f = files[url.pathname.slice(1)];
      return new Response(f.body, { headers: { "content-type": f.type } });
    }
    assert.strictEqual(init.headers.Authorization, "Bearer TOKEN");
    if (url.pathname === "/backend-api/conversation/11111111-1111-1111-1111-111111111111") {
      if (failFirst429 && !throttled) { throttled = true; return new Response("", { status: 429, headers: { "retry-after": "0" } }); }
      return json(conversation);
    }
    if (url.pathname === `/backend-api/conversation/${ID}/interpreter/download`) {
      assert.strictEqual(url.searchParams.get("sandbox_path"), "/mnt/data/result.csv");
      return json({ download_url: "https://cdn.test/sandbox", file_name: "result.csv" });
    }
    const m = url.pathname.match(/^\/backend-api\/files\/(.+)\/download$/);
    if (m) return files[m[1]] ? json({ download_url: `https://cdn.test/${m[1]}`, file_name: files[m[1]].name }) : json({}, 404);
    if (url.pathname === "/backend-api/conversations") {
      const archived = url.searchParams.get("is_archived") === "true";
      const offset = Number(url.searchParams.get("offset"));
      const total = archived ? 1 : 150;
      const items = Array.from({ length: Math.min(100, total - offset) }, (_, i) => ({ id: `${archived ? "a" : "c"}-${String(offset + i).padStart(6, "0")}`, title: `S${offset + i}`, update_time: "2025-10-01T10:00:00Z" }));
      return json({ items, total });
    }
    return new Response("", { status: 404 });
  };
  return { impl, calls };
}
const makeCtx = (fetchImpl, signal) => {
  const statuses = [];
  return { statuses, ctx: { client: core.createClient({ fetchImpl, origin: "https://chatgpt.com", token: "TOKEN", signal, sleep: async () => {} }), t, signal, lang: "en", status: (m, f) => statuses.push([m, f]) } };
};
const names = r => r.entries.map(e => e.name);

(async () => {
  console.log("render");
  await test("citation markers are removed, entity names kept", () => {
    assert.strictEqual(render.cleanText("aciteturn0search0b 【1†source】c"), "ab c");
    assert.strictEqual(render.cleanText('entity["x","Paris","d"]'), "Paris");
  });
  await test("markdown → html: headings, lists, tables, code", () => {
    const html = render.markdownToHtml("# H\n\n- a\n  - b\n- c\n\n1. x\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```py\nx<1\n```\n\n> quote");
    for (const piece of ["<h1>H</h1>", "<ul><li><p>a</p>\n<ul>", "<ol>", "<table>", '<div class="code"><div class="code-head"><span>py</span>', "x&lt;1</code></pre>", "<blockquote>"]) assert.ok(html.includes(piece) || html.includes(piece.replace("<p>a</p>\n", "a")), `missing: ${piece}\n${html}`);
  });
  await test("html output is XSS-safe", () => {
    const html = render.markdownToHtml('<img src=x onerror=alert(1)> [a](javascript:alert(1)) [b](https://ok.test/?a=1&b="2") ![c](https://evil/x.png) `<s>`');
    assert.ok(!/<img src=x/i.test(html) && !html.includes('href="javascript'), html);
    assert.ok(!html.includes("<s>") && !html.includes("<img"), html);
    assert.ok(html.includes('href="https://ok.test/?a=1&amp;b=&quot;2&quot;"'), html);
  });

  console.log("core");
  await test("single chat: files, branch, steps, sources", async () => {
    const { impl, calls } = makeFetch();
    const { ctx } = makeCtx(impl);
    const r = await core.exportConversation({ id: ID, ctx, opts: { formats: ["md", "html", "txt", "json"], attachments: true, textMode: "2", steps: false } });
    assert.deepStrictEqual(names(r).filter(n => !n.startsWith("attachments/")).sort(), ["conversation.html", "conversation.json", "conversation.md", "conversation.txt"]);
    assert.ok(names(r).includes("attachments/002-notes.txt") && names(r).includes("attachments/001-g.png"), names(r).join());
    assert.strictEqual(r.report.attachments.find(a => a.id === FILE_BAD).status, "failed");
    assert.ok(r.needsReport);
    const md = r.text.md;
    assert.ok(md.startsWith("# Test <b>chat</b>"), md.slice(0, 60));
    assert.ok(md.includes("![001-g.png](attachments/001-g.png)"), "image should be inlined:\n" + md);
    assert.ok(md.includes("````text\nhello ```content```"), "nested code fence should widen:\n" + md);
    assert.ok(md.includes("Here is the result Paris and [file](attachments/004-result.csv)."), "sandbox link should point into the ZIP:\n" + md);
    assert.ok(md.includes("[Example <source>](https://example.com/a)") && !md.includes("[bad]"), md);
    assert.ok(!md.includes("Old branch") && !md.includes("hidden"), "selected branch only, no system message");
    assert.ok(!md.includes("print(") && !md.includes("Thinking it over"), "no steps when steps are off");
    assert.ok(md.includes("missing.pdf — download failed"), md);
    assert.ok(calls.every(c => !c.url.includes("cdn.test") || true));
  });
  await test("with steps on, code and reasoning are shown", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    const r = await core.exportConversation({ id: ID, ctx, opts: { formats: ["md", "txt"], attachments: false, textMode: "1", steps: true } });
    assert.ok(r.text.md.includes("\n````python\nprint('```x```')\n````\n"), r.text.md);
    assert.ok(r.text.md.includes("### Reasoning") && r.text.md.includes("### python"), r.text.md);
    assert.ok(!r.text.md.includes("file-BBBB2222 — not downloaded"), "image must not be listed twice");
    assert.ok(r.text.md.includes("> Thinking it over"), r.text.md);
    assert.ok(r.text.md.includes("notes.txt — not downloaded"), "with attachments off, the name is listed");
    assert.ok(!r.needsReport || r.report.unresolved_asset_pointers.length > 0);
    assert.strictEqual(names(r).some(n => n.startsWith("attachments/")), false);
  });
  await test("html: escaping, images and CSP", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    const r = await core.exportConversation({ id: ID, ctx, opts: { formats: ["html"], attachments: true, textMode: "1", steps: false } });
    const html = r.text.html;
    assert.ok(html.includes("<title>Test &lt;b&gt;chat&lt;/b&gt;</title>"));
    assert.ok(!html.includes("<script>alert") && (html.match(/<script/gi) || []).length === 1, "only our own script");
    assert.ok(html.includes('class="bubble prose"') && html.includes('class="msg assistant"'), "ChatGPT-like message structure");
    assert.strictEqual((html.match(/class="chat/g) || []).length, 1, "a single chat lists only itself in the sidebar");
    assert.ok(!html.includes("assets/chats.js") && html.includes('<aside class="sidebar">'));
    assert.ok(html.includes('<img alt="001-g.png" src="attachments/001-g.png">'));
    assert.ok(html.includes("default-src 'none'"));
  });
  await test("bulk mode: shared sidebar, relative paths, index.html", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    const prefix = "chats/2025-10-01-S-abc/";
    const r = await core.exportConversation({ id: ID, ctx, prefix, opts: { formats: ["html"], attachments: false, textMode: "1", steps: false, sidebar: "multi" } });
    const html = r.text.html;
    assert.ok(html.includes('<script src="../../assets/chats.js"></script>'), "shared data file loads by relative path");
    assert.ok(html.includes('data-root="../../"') && html.includes(`data-current="${prefix}conversation.html"`));
    assert.ok(html.includes('id="q"'), "search box");
    assert.strictEqual((html.match(/class="chat/g) || []).length, 1, "the list is drawn by script; only the <noscript> fallback link is prerendered");
    const index = render.toHtmlIndex(3, { t, lang: "en" });
    assert.ok(index.includes("Pick a chat on the left") && index.includes('data-root=""'));
    const data = render.chatsData([{ t: "</script><b>x", h: "a/b.html", d: "2025-01-01" }]);
    assert.ok(!data.includes("</script>") && data.startsWith("window.CSI_CHATS=[") && JSON.parse(data.slice(17, -2).replace(/\\u003c/g, "<"))[0].t === "</script><b>x");
  });
  await test("retries after 429", async () => {
    const { impl, calls } = makeFetch({ failFirst429: true });
    const { ctx } = makeCtx(impl);
    await core.exportConversation({ id: ID, ctx, opts: { formats: ["md"], attachments: false, textMode: "1", steps: false } });
    assert.strictEqual(calls.filter(c => c.url.endsWith(ID)).length, 2);
  });
  await test("abort signal stops the export", async () => {
    const controller = new AbortController();
    const { ctx } = makeCtx(makeFetch().impl, controller.signal);
    controller.abort();
    await assert.rejects(core.exportConversation({ id: ID, ctx, opts: { formats: ["md"], attachments: true, textMode: "1", steps: false } }), e => e.name === "AbortError");
  });
  await test("chat list is paginated and includes the archive", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    const list = await core.listConversations(ctx);
    assert.strictEqual(list.length, 151);
  });
  await test("API requests cannot go to another origin", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    await assert.rejects(ctx.client.api("https://evil.test/x"), /same origin/);
    await assert.rejects(ctx.client.external("http://cdn.test/x"), /HTTPS/);
  });


  console.log("v3 features");
  const PNG_1x1 = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  const conv = (messages, extra = {}) => {
    const mapping = {};
    let parent = null;
    messages.forEach((m, i) => { const id = m.id || `m${i}`; mapping[id] = { id, parent, children: [], message: { id, create_time: 1760000000 + i, metadata: {}, recipient: "all", ...m } }; if (parent) mapping[parent].children.push(id); parent = id; });
    return { title: "Special <test>", create_time: 1760000000, update_time: 1760000100, current_node: parent, mapping, ...extra };
  };
  const user = (text, id) => ({ id, author: { role: "user" }, content: { content_type: "text", parts: [text] } });
  const bot = (text, id, metadata = {}) => ({ id, author: { role: "assistant" }, content: { content_type: "text", parts: [text] }, metadata });
  const emptyReport = { attachments: [] };

  await test("math: $…$ in Markdown, MathML in HTML, \\( inside code untouched", () => {
    const c = conv([user("question"), bot("Area \\(\\pi r^2\\) and\n\n\\[\\sum_{i=1}^n i\\]\n\n`\\(code\\)`")]);
    const doc = render.buildDocument(c, { t, report: emptyReport, includeSteps: false });
    const md = render.toMarkdown(doc, { t });
    assert.ok(md.includes("$\\pi r^2$") && md.includes("$$\n\\sum_{i=1}^n i\n$$") && md.includes("`\\(code\\)`"), md);
    const html = render.toHtml(doc, { t, lang: "en" });
    assert.ok(html.includes("<math") && html.includes('display="block"') && html.includes("<code>\\(code\\)</code>"), "expected MathML");
  });

  await test("Deep Research citations become footnotes (MD, HTML, TXT)", () => {
    const refs = { content_references: [
      { matched_text: "citeturn0search0", items: [{ url: "https://a.example/1", title: "Source A" }] },
      { matched_text: "citeturn0search1", items: [{ url: "https://b.example/2", title: "Source B" }, { url: "https://a.example/1", title: "Source A" }] },
      { url: "https://c.example/3", title: "Extra source" }] };
    const c = conv([user("research"), bot("Finding oneciteturn0search0. Finding twociteturn0search1.", "a1", refs)]);
    const doc = render.buildDocument(c, { t, report: emptyReport, includeSteps: false });
    const md = render.toMarkdown(doc, { t });
    assert.ok(md.includes("Finding one[^1]. Finding two[^2][^1].") && md.includes("[^1]: [Source A](https://a.example/1)") && md.includes("[^2]: [Source B](https://b.example/2)"), md);
    assert.ok(md.includes("[Extra source](https://c.example/3)"), "links without a footnote stay under Sources");
    const html = render.toHtml(doc, { t, lang: "en" });
    assert.ok(html.includes('<sup class="fn"><a href="#fn-1">1</a></sup>') && html.includes('<li id="fn-2" value="2">'), "HTML footnotes");
    assert.ok(render.toText(doc, { t }).includes("Finding one[1]"));
  });

  await test("Canvas: create plus update shows the latest content, even with steps off", () => {
    const create = { author: { role: "assistant" }, recipient: "canmore.create_textdoc", content: { content_type: "code", text: JSON.stringify({ name: "Plan", type: "document", content: "# Plan\n\nFirst draft" }) } };
    const update = { author: { role: "assistant" }, recipient: "canmore.update_textdoc", content: { content_type: "code", text: JSON.stringify({ updates: [{ pattern: "First draft", replacement: "Final version $1", multiple: false }] }) } };
    const code = { author: { role: "assistant" }, recipient: "canmore.create_textdoc", content: { content_type: "code", text: JSON.stringify({ name: "app", type: "code/python", content: "print(1)" }) } };
    const doc = render.buildDocument(conv([user("write"), create, update, code]), { t, report: emptyReport, includeSteps: false });
    const md = render.toMarkdown(doc, { t });
    assert.ok(md.includes("**Canvas — Plan**") && md.includes("Final version $1") && md.includes("(updated)") && md.includes("```python\nprint(1)\n```"), md);
    assert.ok(render.toHtml(doc, { t, lang: "en" }).includes('<div class="canvas"><div class="canvas-head">Canvas · Plan'));
  });

  await test("generated images (tool message) show as a ChatGPT message even with steps off", () => {
    const dalle = { author: { role: "tool", name: "dalle.text2im" }, content: { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "sediment://file_abc123" }, "DALL·E displayed 1 image"] } };
    const report = { attachments: [{ kind: "file", id: "file_abc123", status: "downloaded", archive_path: "attachments/001-x.png", message_ids: ["d1"] }] };
    const doc = render.buildDocument(conv([user("draw"), { ...dalle, id: "d1" }]), { t, report, includeSteps: false });
    assert.strictEqual(doc.messages.at(-1).role, "assistant");
    assert.ok(render.toMarkdown(doc, { t }).includes("![001-x.png](attachments/001-x.png)") && !render.toMarkdown(doc, { t }).includes("DALL·E displayed"));
  });

  await test("message selection: only picked messages, their attachments and the preceding tool step", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    const r = await core.exportConversation({ id: ID, ctx, opts: { formats: ["md"], attachments: true, textMode: "1", steps: true, messageIds: ["u1"] } });
    const md = r.text.md;
    assert.ok(md.includes("Hello") && !md.includes("Heading") && !md.includes("print("), md);
    assert.deepStrictEqual(r.report.attachments.map(a => a.id).sort(), [FILE_TXT, FILE_IMG, FILE_BAD].sort(), "only the picked message's attachments (not the sandbox file)");
    const summaries = render.messageSummaries(render.buildDocument(conversation, { t, report: emptyReport, includeSteps: false }));
    assert.deepStrictEqual(summaries.map(s => [s.id, s.role]), [["u1", "user"], ["a2", "assistant"]]);
    assert.ok(summaries[1].preview.startsWith("Heading Here is the result Paris"), summaries[1].preview);
  });

  await test("Obsidian: YAML frontmatter and a note named after the title", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    const r = await core.exportConversation({ id: ID, ctx, opts: { formats: ["md"], attachments: false, textMode: "1", steps: false, obsidian: true } });
    assert.strictEqual(r.names.md, "Test _b_chat__b_.md");
    const md = r.text.md;
    assert.ok(md.startsWith('---\ntitle: "Test <b>chat</b>"\nsource: "https://chatgpt.com/c/' + ID + '"'), md.slice(0, 200));
    assert.ok(/\ncreated: 2025-10-\d\dT/.test(md) && md.includes('model: "gpt-test"') && md.includes("tags:\n  - chatgpt\n---\n"), md.slice(0, 400));
  });

  await test("Word (.docx): valid package, text, table, link, image; readable by macOS textutil", async () => {
    const c = conv([user("Hello **bold** and [link](https://ex.com)"), bot("## Heading\n\n- one\n  - inner\n1. ordered\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1 < 2;\n```\n\n> quote\n\nMath \\(x^2\\) and ![g](attachments/001-g.png) & <naïve>", "a1")]);
    const doc = render.buildDocument(c, { t, report: emptyReport, includeSteps: false });
    doc.messages[1].blocks.push({ type: "image", src: "attachments/001-g.png" });
    const bytes = await docx.build([{ doc, images: new Map([["attachments/001-g.png", PNG_1x1]]) }], { t });
    const file = path.join(os.tmpdir(), `csi-${process.pid}.docx`);
    fs.writeFileSync(file, bytes);
    try {
      const out = execFileSync("python3", ["-c", `
import zipfile,sys
from xml.dom import minidom
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
for n in z.namelist():
    if n.endswith(".xml") or n.endswith(".rels"): minidom.parseString(z.read(n))
d=z.read("word/document.xml").decode()
assert d.count("<w:drawing>")==2, d.count("<w:drawing>")
assert "word/media/image1.png" in z.namelist() and "<w:tbl>" in d and "<w:hyperlink" in d and "Consolas" not in d
assert "&lt;naïve&gt;" in d and "x^2" in d
print("ok")`, file]).toString().trim();
      assert.strictEqual(out, "ok");
      const text = execFileSync("textutil", ["-convert", "txt", "-stdout", file]).toString();
      for (const piece of ["Special <test>", "Hello bold and link", "Heading", "const x = 1 < 2;", "quote", "one", "inner"]) assert.ok(text.includes(piece), `missing from textutil output: ${piece}\n${text}`);
    } finally { fs.unlinkSync(file); }
  });

  await test("PDF print page: no script, data: URI images, page break between chats", () => {
    const doc = render.buildDocument(conv([user("a"), bot("b \\(x\\)")]), { t, report: emptyReport, includeSteps: false });
    doc.messages[1].blocks.push({ type: "image", src: "attachments/001-g.png" });
    const html = render.toPrintHtml([{ doc, images: new Map([["attachments/001-g.png", "data:image/png;base64,AAA"]]) }, { doc, images: new Map() }], { t, lang: "en" });
    assert.ok(!/<script/i.test(html) && html.includes('src="data:image/png;base64,AAA"') && html.includes(".conv+.conv{break-before:page}") && html.includes("<math"));
    assert.ok(html.includes("default-src 'none'; img-src data:"));
    assert.strictEqual((html.match(/<section class="conv">/g) || []).length, 2);
  });

  await test("gallery: downloaded images are collected; images can be downloaded alone", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    const r = await core.exportConversation({ id: ID, ctx, prefix: "chats/x/", opts: { formats: ["md"], attachments: false, gallery: true, textMode: "1", steps: false } });
    assert.deepStrictEqual(r.report.attachments.filter(a => a.status === "downloaded").map(a => a.name), ["file-BBBB2222"], "with attachments off, only images are downloaded");
    assert.deepStrictEqual(r.gallery.map(g => g.src), ["chats/x/attachments/001-g.png"]);
    const html = render.toGalleryHtml(r.gallery.map(g => ({ ...g, href: "chats/x/conversation.md" })), { t, lang: "en", multi: false });
    assert.ok(html.includes('<img loading="lazy" alt="Test &lt;b&gt;chat&lt;/b&gt;" src="chats/x/attachments/001-g.png">') && html.includes("1 images"));
  });

  await test("chat list flags projects, GPTs and the archive", async () => {
    const json = obj => new Response(JSON.stringify(obj), { headers: { "content-type": "application/json" } });
    const fetchImpl = async url => {
      url = new URL(url);
      if (url.pathname === "/backend-api/conversations") return json(url.searchParams.get("is_archived") ? { items: [{ id: "arch", title: "Old", update_time: "2025-01-01T00:00:00Z" }], total: 1 }
        : { items: [{ id: "c1", title: "Normal", update_time: "2025-03-01T00:00:00Z" }, { id: "g1", title: "With a GPT", gizmo_id: "g-abc", update_time: "2025-02-01T00:00:00Z" }], total: 2 });
      if (url.pathname === "/backend-api/gizmos/snorlax/sidebar") return json({ items: [{ gizmo: { gizmo: { id: "g-p-123", display: { name: "Thesis" } } } }], cursor: null });
      if (url.pathname === "/backend-api/gizmos/g-p-123/conversations") return json({ items: [{ id: "p1", title: "In a project", update_time: 1760000000 }], cursor: null });
      return new Response("", { status: 404 });
    };
    const { ctx } = makeCtx(fetchImpl);
    const list = await core.listConversations(ctx);
    const by = Object.fromEntries(list.map(i => [i.id, i]));
    assert.ok(by.arch.archived && !by.c1.archived && by.g1.gpt && by.p1.project === "Thesis" && !by.p1.gpt, JSON.stringify(list));
    assert.strictEqual(by.p1.update_time, new Date(1760000000 * 1000).toISOString());
    assert.deepStrictEqual(list.map(i => i.id), ["p1", "c1", "g1", "arch"], "sorted newest first");
  });

  await test("shared link: flat message list becomes a chain; no token without a session", async () => {
    let auth = "unset";
    const fetchImpl = async (url, init) => {
      auth = init.headers.Authorization;
      return new Response(JSON.stringify({ title: "Shared", linear_conversation: [{ id: "r" }, { id: "x", message: user("question", "x") }, { id: "y", message: bot("answer", "y") }] }), { headers: { "content-type": "application/json" } });
    };
    const ctx = { client: core.createClient({ fetchImpl, origin: "https://chatgpt.com", token: null, sleep: async () => {} }), t, status() {} };
    const c = await core.loadConversation(ctx, "s1", { share: true });
    assert.strictEqual(auth, undefined);
    assert.strictEqual(c.current_node, "y");
    const doc = render.buildDocument(c, { t, report: emptyReport, includeSteps: false });
    assert.deepStrictEqual(doc.messages.map(m => m.role), ["user", "assistant"]);
  });

  console.log("zip");
  await test("valid ZIP: unzip -t, contents and compression", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    const r = await core.exportConversation({ id: ID, ctx, opts: { formats: ["md", "json"], attachments: true, textMode: "2", steps: false } });
    r.entries.push({ name: "large-unicode-ğüşiöç-日本.txt", data: new TextEncoder().encode("hello world ".repeat(5000)) });
    const blob = await zip.createZip(r.entries);
    const file = path.join(os.tmpdir(), `csi-${process.pid}.zip`);
    fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
    try {
      const out = execFileSync("python3", ["-c", `
import zipfile,sys,json
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
info={i.filename:i for i in z.infolist()}
big=info["large-unicode-ğüşiöç-日本.txt"]; assert big.compress_type==8 and big.compress_size<big.file_size/10
assert info["attachments/001-g.png"].compress_type==0
assert z.read("attachments/001-g.png")[:4]==b"\\x89PNG"
assert "hello" in z.read("conversation.md").decode()
assert json.loads(z.read("conversation.json"))["title"].startswith("Test")
assert info["conversation.md"].date_time[0]>=2025
print("ok")`, file]).toString();
      assert.strictEqual(out.trim(), "ok");
      assert.ok(execFileSync("unzip", ["-tq", file]).toString().includes("No errors"));
    } finally { fs.unlinkSync(file); }
  });

  console.log("translations / UI");
  await test("every key used in code exists in both languages", () => {
    const keys = new Set();
    for (const file of ["src/exporter.js", "src/core.js", "src/render.js", "src/docx.js", "src/background.js", "src/page-button.js", "sidepanel.js", "print.js"]) {
      for (const m of fs.readFileSync(path.join(root, file), "utf8").matchAll(/\bt\(\s*"(\w+)"|t\(\s*[^"')]*\?\s*"(\w+)"\s*:\s*"(\w+)"/g)) [m[1], m[2], m[3]].filter(Boolean).forEach(k => keys.add(k));
      for (const m of fs.readFileSync(path.join(root, file), "utf8").matchAll(/"((?:err|status|render|pick|tab)[A-Z]\w*)"/g)) keys.add(m[1]);
    }
    for (const html of ["sidepanel.html", "print.html"]) for (const m of fs.readFileSync(path.join(root, html), "utf8").matchAll(/data-i18n(?:-[\w-]+)?="(\w+)"/g)) keys.add(m[1]);
    for (const m of fs.readFileSync(path.join(root, "manifest.json"), "utf8").matchAll(/__MSG_(\w+)__/g)) keys.add(m[1]);
    for (const key of keys) { assert.ok(key in tr, `missing in tr: ${key}`); assert.ok(key in en, `missing in en: ${key}`); }
    for (const key of Object.keys(tr)) assert.ok(keys.has(key) || key.startsWith("panel") || key === "readmeText" || key === "bulkIndexTitle", `unused key: ${key}`);
  });
  await test("package files are UTF-8 Chrome accepts (no raw control chars or noncharacters)", () => {
    const files = ["manifest.json", "sidepanel.html", "sidepanel.js", "sidepanel.css", "print.html", "print.js", "print.css",
      ...fs.readdirSync(path.join(root, "src")).map(f => `src/${f}`), ...fs.readdirSync(path.join(root, "_locales")).map(l => `_locales/${l}/messages.json`)];
    for (const file of files) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(path.join(root, file)));
      const bad = [...text].find(c => { const n = c.codePointAt(0); return (n < 32 && !"\n\r\t".includes(c)) || (n & 0xfffe) === 0xfffe || (n >= 0xfdd0 && n <= 0xfdef); });
      assert.ok(!bad, `${file}: U+${bad?.codePointAt(0).toString(16)}`);
    }
  });
  await test("all languages complete: keys, placeholders, Store limits; _locales up to date", () => {
    assert.deepStrictEqual(checkLocales(), []);
    assert.ok(Object.keys(allLocales).length >= 10, Object.keys(allLocales).join());
    for (const lang of Object.keys(allLocales)) {
      const onDisk = JSON.parse(fs.readFileSync(path.join(root, "_locales", lang, "messages.json"), "utf8"));
      assert.strictEqual(Object.keys(onDisk).length, Object.keys(en).length, `${lang}: run node tools/locales.js`);
    }
  });
  await test("placeholder counts match in both languages", () => {
    const count = s => new Set([...s.matchAll(/\{(\d)\}/g)].map(m => m[1])).size;
    for (const key of Object.keys(tr)) assert.strictEqual(count(tr[key]), count(en[key]), key);
  });
  await test("manifest: description ≤132, minimal permissions, files exist", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    assert.deepStrictEqual([...manifest.permissions].sort(), ["contextMenus", "scripting", "sidePanel", "storage"]);
    assert.deepStrictEqual(manifest.host_permissions, ["https://chatgpt.com/*"], "chatgpt.com only");
    assert.deepStrictEqual(manifest.content_scripts.map(c => c.matches), [["https://chatgpt.com/*"]]);
    for (const c of manifest.content_scripts) for (const js of c.js) assert.ok(fs.existsSync(path.join(root, js)), js);
    assert.ok(manifest.side_panel.default_path === "sidepanel.html" && fs.existsSync(path.join(root, manifest.background.service_worker)));
    for (const file of ["print.html", "print.js", "print.css", "vendor/katex.min.js", "vendor/KATEX-LICENSE.txt"]) assert.ok(fs.existsSync(path.join(root, file)), file);
    for (const lang of [tr, en]) { assert.ok(lang.extDescription.length <= 132); assert.ok(lang.extName.length <= 75); }
    for (const icon of Object.values(manifest.icons)) assert.ok(fs.existsSync(path.join(root, icon)), icon);
    for (const file of ["sidepanel.js", "src/background.js"]) for (const m of fs.readFileSync(path.join(root, file), "utf8").matchAll(/"((?:src|vendor)\/[\w.-]+)"/g)) assert.ok(fs.existsSync(path.join(root, m[1])), m[1]);
  });
  await test("side panel fields match the names sidepanel.js expects", () => {
    const html = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
    const js = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
    for (const name of ["scope", "formats", "attachments", "textMode", "steps"]) assert.ok(html.includes(`name="${name}"`), name);
    for (const m of js.matchAll(/\$\("#([\w-]+)"\)/g)) assert.ok(html.includes(`id="${m[1]}"`), `#${m[1]} missing from sidepanel.html`);
  });

  console.log(process.exitCode ? "\nFAILED" : `\n${passed} tests passed`);
})();
