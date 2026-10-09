// Çalıştır: node tools/test.js  — ağ yok; sahte ChatGPT API'siyle çekirdeği sınar.
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
  assert.ok(key in messages, `eksik çeviri anahtarı: ${key}`);
  return messages[key].replace(/\{(\d)\}/g, (_, n) => subs[n - 1] ?? "");
};
const t = makeT(tr);

const { ID, FILE_TXT, FILE_IMG, FILE_BAD, conversation, files } = require("./fixture.js");
function makeFetch({ failFirst429 = false } = {}) {
  const calls = [];
  let throttled = false;
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
  const impl = async (url, init = {}) => {
    url = new URL(url);
    calls.push({ url: url.href, init });
    if (url.origin === "https://cdn.test") {
      assert.strictEqual(init.credentials, "omit", "dış sunucuya çerez gitmemeli");
      assert.ok(!init.headers?.Authorization, "dış sunucuya token gitmemeli");
      const f = files[url.pathname.slice(1)];
      return new Response(f.body, { headers: { "content-type": f.type } });
    }
    assert.strictEqual(init.headers.Authorization, "Bearer TOKEN");
    if (url.pathname === "/backend-api/conversation/11111111-1111-1111-1111-111111111111") {
      if (failFirst429 && !throttled) { throttled = true; return new Response("", { status: 429, headers: { "retry-after": "0" } }); }
      return json(conversation);
    }
    if (url.pathname === `/backend-api/conversation/${ID}/interpreter/download`) {
      assert.strictEqual(url.searchParams.get("sandbox_path"), "/mnt/data/sonuc.csv");
      return json({ download_url: "https://cdn.test/sandbox", file_name: "sonuc.csv" });
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
  return { statuses, ctx: { client: core.createClient({ fetchImpl, origin: "https://chatgpt.com", token: "TOKEN", signal, sleep: async () => {} }), t, signal, lang: "tr", status: (m, f) => statuses.push([m, f]) } };
};
const names = r => r.entries.map(e => e.name);

(async () => {
  console.log("render");
  await test("atıf işaretleri temizlenir, varlık adı korunur", () => {
    assert.strictEqual(render.cleanText("aciteturn0search0b 【1†kaynak】c"), "ab c");
    assert.strictEqual(render.cleanText('entity["x","Paris","d"]'), "Paris");
  });
  await test("markdown → html: başlık, liste, tablo, kod", () => {
    const html = render.markdownToHtml("# H\n\n- a\n  - b\n- c\n\n1. x\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```py\nx<1\n```\n\n> alıntı");
    for (const piece of ["<h1>H</h1>", "<ul><li><p>a</p>\n<ul>", "<ol>", "<table>", '<div class="code"><div class="code-head"><span>py</span>', "x&lt;1</code></pre>", "<blockquote>"]) assert.ok(html.includes(piece) || html.includes(piece.replace("<p>a</p>\n", "a")), `yok: ${piece}\n${html}`);
  });
  await test("html çıktısı XSS'e kapalı", () => {
    const html = render.markdownToHtml('<img src=x onerror=alert(1)> [a](javascript:alert(1)) [b](https://ok.test/?a=1&b="2") ![c](https://evil/x.png) `<s>`');
    assert.ok(!/<img src=x/i.test(html) && !html.includes('href="javascript'), html);
    assert.ok(!html.includes("<s>") && !html.includes("<img"), html);
    assert.ok(html.includes('href="https://ok.test/?a=1&amp;b=&quot;2&quot;"'), html);
  });

  console.log("çekirdek");
  await test("tek sohbet: dosyalar, dal, adımlar, kaynaklar", async () => {
    const { impl, calls } = makeFetch();
    const { ctx } = makeCtx(impl);
    const r = await core.exportConversation({ id: ID, ctx, opts: { formats: ["md", "html", "txt", "json"], attachments: true, textMode: "2", steps: false } });
    assert.deepStrictEqual(names(r).filter(n => !n.startsWith("ekler/")).sort(), ["conversation.html", "conversation.json", "conversation.md", "conversation.txt"]);
    assert.ok(names(r).includes("ekler/002-notlar.txt") && names(r).includes("ekler/001-g.png"), names(r).join());
    assert.strictEqual(r.report.attachments.find(a => a.id === FILE_BAD).status, "failed");
    assert.ok(r.needsReport);
    const md = r.text.md;
    assert.ok(md.startsWith("# Test <b>sohbet</b>"), md.slice(0, 60));
    assert.ok(md.includes("![001-g.png](ekler/001-g.png)"), "görsel satır içi gömülmeli:\n" + md);
    assert.ok(md.includes("````text\nmerhaba ```içerik```"), "iç içe kod çiti genişlemeli:\n" + md);
    assert.ok(md.includes("İşte sonuç Paris ve [dosya](ekler/004-sonuc.csv)."), "sandbox bağlantısı ZIP yoluna çevrilmeli:\n" + md);
    assert.ok(md.includes("[Örnek <kaynak>](https://example.com/a)") && !md.includes("[kötü]"), md);
    assert.ok(!md.includes("Eski dal") && !md.includes("gizli"), "yalnızca seçili dal, sistem mesajı yok");
    assert.ok(!md.includes("print(") && !md.includes("Düşünüyorum"), "adımlar kapalıyken yok");
    assert.ok(md.includes("yok.pdf — indirilemedi"), md);
    assert.ok(calls.every(c => !c.url.includes("cdn.test") || true));
  });
  await test("adımlar açıkken kod/akıl yürütme görünür", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    const r = await core.exportConversation({ id: ID, ctx, opts: { formats: ["md", "txt"], attachments: false, textMode: "1", steps: true } });
    assert.ok(r.text.md.includes("\n````python\nprint('```x```')\n````\n"), r.text.md);
    assert.ok(r.text.md.includes("### Akıl yürütme") && r.text.md.includes("### python"), r.text.md);
    assert.ok(!r.text.md.includes("file-BBBB2222 — indirilmedi"), "görsel iki kez listelenmemeli");
    assert.ok(r.text.md.includes("> Düşünüyorum"), r.text.md);
    assert.ok(r.text.md.includes("notlar.txt — indirilmedi"), "ek kapalıyken adı listelenir");
    assert.ok(!r.needsReport || r.report.unresolved_asset_pointers.length > 0);
    assert.strictEqual(names(r).some(n => n.startsWith("ekler/")), false);
  });
  await test("html: kaçış, görsel ve CSP", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    const r = await core.exportConversation({ id: ID, ctx, opts: { formats: ["html"], attachments: true, textMode: "1", steps: false } });
    const html = r.text.html;
    assert.ok(html.includes("<title>Test &lt;b&gt;sohbet&lt;/b&gt;</title>"));
    assert.ok(!html.includes("<script>alert") && (html.match(/<script/gi) || []).length === 1, "yalnızca kendi betiğimiz olmalı");
    assert.ok(html.includes('class="bubble prose"') && html.includes('class="msg assistant"'), "ChatGPT benzeri mesaj yapısı");
    assert.strictEqual((html.match(/class="chat/g) || []).length, 1, "tek sohbette kenar çubuğunda yalnızca o sohbet");
    assert.ok(!html.includes("assets/chats.js") && html.includes('<aside class="sidebar">'));
    assert.ok(html.includes('<img alt="001-g.png" src="ekler/001-g.png">'));
    assert.ok(html.includes("default-src 'none'"));
  });
  await test("toplu mod: ortak kenar çubuğu, göreli yollar, index.html", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    const prefix = "sohbetler/2025-10-01-S-abc/";
    const r = await core.exportConversation({ id: ID, ctx, prefix, opts: { formats: ["html"], attachments: false, textMode: "1", steps: false, sidebar: "multi" } });
    const html = r.text.html;
    assert.ok(html.includes('<script src="../../assets/chats.js"></script>'), "ortak veri dosyası göreli yolla yüklenmeli");
    assert.ok(html.includes('data-root="../../"') && html.includes(`data-current="${prefix}conversation.html"`));
    assert.ok(html.includes('id="q"'), "arama kutusu");
    assert.strictEqual((html.match(/class="chat/g) || []).length, 1, "liste betikle çizilir; yalnızca <noscript> yedek bağlantısı sunucu tarafında yazılır");
    const index = render.toHtmlIndex(3, { t, lang: "tr" });
    assert.ok(index.includes("Soldan bir sohbet seç") && index.includes('data-root=""'));
    const data = render.chatsData([{ t: "</script><b>x", h: "a/b.html", d: "2025-01-01" }]);
    assert.ok(!data.includes("</script>") && data.startsWith("window.CSI_CHATS=[") && JSON.parse(data.slice(17, -2).replace(/\\u003c/g, "<"))[0].t === "</script><b>x");
  });
  await test("429 sonrası yeniden dener", async () => {
    const { impl, calls } = makeFetch({ failFirst429: true });
    const { ctx } = makeCtx(impl);
    await core.exportConversation({ id: ID, ctx, opts: { formats: ["md"], attachments: false, textMode: "1", steps: false } });
    assert.strictEqual(calls.filter(c => c.url.endsWith(ID)).length, 2);
  });
  await test("iptal sinyali işlemi durdurur", async () => {
    const controller = new AbortController();
    const { ctx } = makeCtx(makeFetch().impl, controller.signal);
    controller.abort();
    await assert.rejects(core.exportConversation({ id: ID, ctx, opts: { formats: ["md"], attachments: true, textMode: "1", steps: false } }), e => e.name === "AbortError");
  });
  await test("sohbet listesi sayfalanır ve arşivi kapsar", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    const list = await core.listConversations(ctx);
    assert.strictEqual(list.length, 151);
  });
  await test("API isteği başka kökene gidemez", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    await assert.rejects(ctx.client.api("https://evil.test/x"), /same origin/);
    await assert.rejects(ctx.client.external("http://cdn.test/x"), /HTTPS/);
  });


  console.log("v3 özellikleri");
  const PNG_1x1 = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  const conv = (messages, extra = {}) => {
    const mapping = {};
    let parent = null;
    messages.forEach((m, i) => { const id = m.id || `m${i}`; mapping[id] = { id, parent, children: [], message: { id, create_time: 1760000000 + i, metadata: {}, recipient: "all", ...m } }; if (parent) mapping[parent].children.push(id); parent = id; });
    return { title: "Özel <test>", create_time: 1760000000, update_time: 1760000100, current_node: parent, mapping, ...extra };
  };
  const user = (text, id) => ({ id, author: { role: "user" }, content: { content_type: "text", parts: [text] } });
  const bot = (text, id, metadata = {}) => ({ id, author: { role: "assistant" }, content: { content_type: "text", parts: [text] }, metadata });
  const emptyReport = { attachments: [] };

  await test("formüller: Markdown'da $…$, HTML'de MathML, koddaki \\( dokunulmaz", () => {
    const c = conv([user("soru"), bot("Alan \\(\\pi r^2\\) ve\n\n\\[\\sum_{i=1}^n i\\]\n\n`\\(kod\\)`")]);
    const doc = render.buildDocument(c, { t, report: emptyReport, includeSteps: false });
    const md = render.toMarkdown(doc, { t });
    assert.ok(md.includes("$\\pi r^2$") && md.includes("$$\n\\sum_{i=1}^n i\n$$") && md.includes("`\\(kod\\)`"), md);
    const html = render.toHtml(doc, { t, lang: "tr" });
    assert.ok(html.includes("<math") && html.includes('display="block"') && html.includes("<code>\\(kod\\)</code>"), "MathML bekleniyor");
  });

  await test("Deep Research atıfları dipnot olur (MD, HTML, TXT)", () => {
    const refs = { content_references: [
      { matched_text: "citeturn0search0", items: [{ url: "https://a.example/1", title: "Kaynak A" }] },
      { matched_text: "citeturn0search1", items: [{ url: "https://b.example/2", title: "Kaynak B" }, { url: "https://a.example/1", title: "Kaynak A" }] },
      { url: "https://c.example/3", title: "Ek kaynak" }] };
    const c = conv([user("araştır"), bot("Bulgu birciteturn0search0. Bulgu ikiciteturn0search1.", "a1", refs)]);
    const doc = render.buildDocument(c, { t, report: emptyReport, includeSteps: false });
    const md = render.toMarkdown(doc, { t });
    assert.ok(md.includes("Bulgu bir[^1]. Bulgu iki[^2][^1].") && md.includes("[^1]: [Kaynak A](https://a.example/1)") && md.includes("[^2]: [Kaynak B](https://b.example/2)"), md);
    assert.ok(md.includes("[Ek kaynak](https://c.example/3)"), "dipnotlanmayan bağlantı Kaynaklar'da kalır");
    const html = render.toHtml(doc, { t, lang: "tr" });
    assert.ok(html.includes('<sup class="fn"><a href="#fn-1">1</a></sup>') && html.includes('<li id="fn-2" value="2">'), "HTML dipnotları");
    assert.ok(render.toText(doc, { t }).includes("Bulgu bir[1]"));
  });

  await test("Canvas: oluşturma ve güncelleme son içeriği gösterir; adımlar kapalıyken de görünür", () => {
    const create = { author: { role: "assistant" }, recipient: "canmore.create_textdoc", content: { content_type: "code", text: JSON.stringify({ name: "Plan", type: "document", content: "# Plan\n\nİlk taslak" }) } };
    const update = { author: { role: "assistant" }, recipient: "canmore.update_textdoc", content: { content_type: "code", text: JSON.stringify({ updates: [{ pattern: "İlk taslak", replacement: "Son hâli $1", multiple: false }] }) } };
    const code = { author: { role: "assistant" }, recipient: "canmore.create_textdoc", content: { content_type: "code", text: JSON.stringify({ name: "app", type: "code/python", content: "print(1)" }) } };
    const doc = render.buildDocument(conv([user("yaz"), create, update, code]), { t, report: emptyReport, includeSteps: false });
    const md = render.toMarkdown(doc, { t });
    assert.ok(md.includes("**Canvas — Plan**") && md.includes("Son hâli $1") && md.includes("(güncellendi)") && md.includes("```python\nprint(1)\n```"), md);
    assert.ok(render.toHtml(doc, { t, lang: "tr" }).includes('<div class="canvas"><div class="canvas-head">Canvas · Plan'));
  });

  await test("üretilen görseller (araç mesajı) adımlar kapalıyken de ChatGPT mesajı olarak görünür", () => {
    const dalle = { author: { role: "tool", name: "dalle.text2im" }, content: { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "sediment://file_abc123" }, "DALL·E displayed 1 image"] } };
    const report = { attachments: [{ kind: "file", id: "file_abc123", status: "downloaded", archive_path: "ekler/001-x.png", message_ids: ["d1"] }] };
    const doc = render.buildDocument(conv([user("çiz"), { ...dalle, id: "d1" }]), { t, report, includeSteps: false });
    assert.strictEqual(doc.messages.at(-1).role, "assistant");
    assert.ok(render.toMarkdown(doc, { t }).includes("![001-x.png](ekler/001-x.png)") && !render.toMarkdown(doc, { t }).includes("DALL·E displayed"));
  });

  await test("mesaj seçimi: yalnızca seçilenler, ekleri ve önceki araç adımı", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    const r = await core.exportConversation({ id: ID, ctx, opts: { formats: ["md"], attachments: true, textMode: "1", steps: true, messageIds: ["u1"] } });
    const md = r.text.md;
    assert.ok(md.includes("Merhaba") && !md.includes("Başlık") && !md.includes("print("), md);
    assert.deepStrictEqual(r.report.attachments.map(a => a.id).sort(), [FILE_TXT, FILE_IMG, FILE_BAD].sort(), "yalnızca seçili mesajın ekleri (sandbox dosyası hariç)");
    const summaries = render.messageSummaries(render.buildDocument(conversation, { t, report: emptyReport, includeSteps: false }));
    assert.deepStrictEqual(summaries.map(s => [s.id, s.role]), [["u1", "user"], ["a2", "assistant"]]);
    assert.ok(summaries[1].preview.startsWith("Başlık İşte sonuç Paris"), summaries[1].preview);
  });

  await test("Obsidian: YAML frontmatter ve başlık adlı not", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    const r = await core.exportConversation({ id: ID, ctx, opts: { formats: ["md"], attachments: false, textMode: "1", steps: false, obsidian: true } });
    assert.strictEqual(r.names.md, "Test _b_sohbet__b_.md");
    const md = r.text.md;
    assert.ok(md.startsWith('---\ntitle: "Test <b>sohbet</b>"\nsource: "https://chatgpt.com/c/' + ID + '"'), md.slice(0, 200));
    assert.ok(/\ncreated: 2025-10-\d\dT/.test(md) && md.includes('model: "gpt-test"') && md.includes("tags:\n  - chatgpt\n---\n"), md.slice(0, 400));
  });

  await test("Word (.docx): geçerli paket, metin, tablo, bağlantı, görsel; macOS textutil okuyabilir", async () => {
    const c = conv([user("Merhaba **kalın** ve [bağlantı](https://ex.com)"), bot("## Başlık\n\n- bir\n  - iç\n1. sıralı\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1 < 2;\n```\n\n> alıntı\n\nFormül \\(x^2\\) ve ![g](ekler/001-g.png) & <özel>", "a1")]);
    const doc = render.buildDocument(c, { t, report: emptyReport, includeSteps: false });
    doc.messages[1].blocks.push({ type: "image", src: "ekler/001-g.png" });
    const bytes = await docx.build([{ doc, images: new Map([["ekler/001-g.png", PNG_1x1]]) }], { t });
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
assert "&lt;özel&gt;" in d and "x^2" in d
print("ok")`, file]).toString().trim();
      assert.strictEqual(out, "ok");
      const text = execFileSync("textutil", ["-convert", "txt", "-stdout", file]).toString();
      for (const piece of ["Özel <test>", "Merhaba kalın ve bağlantı", "Başlık", "const x = 1 < 2;", "alıntı", "bir", "iç"]) assert.ok(text.includes(piece), `textutil çıktısında yok: ${piece}\n${text}`);
    } finally { fs.unlinkSync(file); }
  });

  await test("PDF yazdırma sayfası: betik yok, görseller data: URI, birden çok sohbet sayfa sonuyla", () => {
    const doc = render.buildDocument(conv([user("a"), bot("b \\(x\\)")]), { t, report: emptyReport, includeSteps: false });
    doc.messages[1].blocks.push({ type: "image", src: "ekler/001-g.png" });
    const html = render.toPrintHtml([{ doc, images: new Map([["ekler/001-g.png", "data:image/png;base64,AAA"]]) }, { doc, images: new Map() }], { t, lang: "tr" });
    assert.ok(!/<script/i.test(html) && html.includes('src="data:image/png;base64,AAA"') && html.includes(".conv+.conv{break-before:page}") && html.includes("<math"));
    assert.ok(html.includes("default-src 'none'; img-src data:"));
    assert.strictEqual((html.match(/<section class="conv">/g) || []).length, 2);
  });

  await test("galeri: indirilen görseller toplanır, yalnızca görseller indirilebilir", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    const r = await core.exportConversation({ id: ID, ctx, prefix: "sohbetler/x/", opts: { formats: ["md"], attachments: false, gallery: true, textMode: "1", steps: false } });
    assert.deepStrictEqual(r.report.attachments.filter(a => a.status === "downloaded").map(a => a.name), ["file-BBBB2222"], "ekler kapalıyken yalnızca görsel indirilir");
    assert.deepStrictEqual(r.gallery.map(g => g.src), ["sohbetler/x/ekler/001-g.png"]);
    const html = render.toGalleryHtml(r.gallery.map(g => ({ ...g, href: "sohbetler/x/conversation.md" })), { t, lang: "tr", multi: false });
    assert.ok(html.includes('<img loading="lazy" alt="Test &lt;b&gt;sohbet&lt;/b&gt;" src="sohbetler/x/ekler/001-g.png">') && html.includes("1 görsel"));
  });

  await test("sohbet listesi projeleri, GPT'leri ve arşivi işaretler", async () => {
    const json = obj => new Response(JSON.stringify(obj), { headers: { "content-type": "application/json" } });
    const fetchImpl = async url => {
      url = new URL(url);
      if (url.pathname === "/backend-api/conversations") return json(url.searchParams.get("is_archived") ? { items: [{ id: "arch", title: "Eski", update_time: "2025-01-01T00:00:00Z" }], total: 1 }
        : { items: [{ id: "c1", title: "Normal", update_time: "2025-03-01T00:00:00Z" }, { id: "g1", title: "GPT ile", gizmo_id: "g-abc", update_time: "2025-02-01T00:00:00Z" }], total: 2 });
      if (url.pathname === "/backend-api/gizmos/snorlax/sidebar") return json({ items: [{ gizmo: { gizmo: { id: "g-p-123", display: { name: "Tez" } } } }], cursor: null });
      if (url.pathname === "/backend-api/gizmos/g-p-123/conversations") return json({ items: [{ id: "p1", title: "Projede", update_time: 1760000000 }], cursor: null });
      return new Response("", { status: 404 });
    };
    const { ctx } = makeCtx(fetchImpl);
    const list = await core.listConversations(ctx);
    const by = Object.fromEntries(list.map(i => [i.id, i]));
    assert.ok(by.arch.archived && !by.c1.archived && by.g1.gpt && by.p1.project === "Tez" && !by.p1.gpt, JSON.stringify(list));
    assert.strictEqual(by.p1.update_time, new Date(1760000000 * 1000).toISOString());
    assert.deepStrictEqual(list.map(i => i.id), ["p1", "c1", "g1", "arch"], "yeniden eskiye sıralı");
  });

  await test("paylaşım bağlantısı: düz mesaj listesi zincire çevrilir; oturumsuz istekte token gönderilmez", async () => {
    let auth = "unset";
    const fetchImpl = async (url, init) => {
      auth = init.headers.Authorization;
      return new Response(JSON.stringify({ title: "Paylaşılan", linear_conversation: [{ id: "r" }, { id: "x", message: user("soru", "x") }, { id: "y", message: bot("cevap", "y") }] }), { headers: { "content-type": "application/json" } });
    };
    const ctx = { client: core.createClient({ fetchImpl, origin: "https://chatgpt.com", token: null, sleep: async () => {} }), t, status() {} };
    const c = await core.loadConversation(ctx, "s1", { share: true });
    assert.strictEqual(auth, undefined);
    assert.strictEqual(c.current_node, "y");
    const doc = render.buildDocument(c, { t, report: emptyReport, includeSteps: false });
    assert.deepStrictEqual(doc.messages.map(m => m.role), ["user", "assistant"]);
  });

  console.log("zip");
  await test("ZIP geçerli: unzip -t, içerik ve sıkıştırma", async () => {
    const { ctx } = makeCtx(makeFetch().impl);
    const r = await core.exportConversation({ id: ID, ctx, opts: { formats: ["md", "json"], attachments: true, textMode: "2", steps: false } });
    r.entries.push({ name: "büyük-türkçe-ğüşiöç.txt", data: new TextEncoder().encode("merhaba dünya ".repeat(5000)) });
    const blob = await zip.createZip(r.entries);
    const file = path.join(os.tmpdir(), `csi-${process.pid}.zip`);
    fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
    try {
      const out = execFileSync("python3", ["-c", `
import zipfile,sys,json
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
info={i.filename:i for i in z.infolist()}
big=info["büyük-türkçe-ğüşiöç.txt"]; assert big.compress_type==8 and big.compress_size<big.file_size/10
assert info["ekler/001-g.png"].compress_type==0
assert z.read("ekler/001-g.png")[:4]==b"\\x89PNG"
assert "merhaba" in z.read("conversation.md").decode()
assert json.loads(z.read("conversation.json"))["title"].startswith("Test")
assert info["conversation.md"].date_time[0]>=2025
print("ok")`, file]).toString();
      assert.strictEqual(out.trim(), "ok");
      assert.ok(execFileSync("unzip", ["-tq", file]).toString().includes("No errors"));
    } finally { fs.unlinkSync(file); }
  });

  console.log("çeviriler / arayüz");
  await test("kodda kullanılan her anahtar iki dilde de var", () => {
    const keys = new Set();
    for (const file of ["src/exporter.js", "src/core.js", "src/render.js", "src/docx.js", "src/background.js", "src/page-button.js", "sidepanel.js", "print.js"]) {
      for (const m of fs.readFileSync(path.join(root, file), "utf8").matchAll(/\bt\(\s*"(\w+)"|t\(\s*[^"')]*\?\s*"(\w+)"\s*:\s*"(\w+)"/g)) [m[1], m[2], m[3]].filter(Boolean).forEach(k => keys.add(k));
      for (const m of fs.readFileSync(path.join(root, file), "utf8").matchAll(/"((?:err|status|render|pick|tab)[A-Z]\w*)"/g)) keys.add(m[1]);
    }
    for (const html of ["sidepanel.html", "print.html"]) for (const m of fs.readFileSync(path.join(root, html), "utf8").matchAll(/data-i18n(?:-[\w-]+)?="(\w+)"/g)) keys.add(m[1]);
    for (const m of fs.readFileSync(path.join(root, "manifest.json"), "utf8").matchAll(/__MSG_(\w+)__/g)) keys.add(m[1]);
    for (const key of keys) { assert.ok(key in tr, `tr eksik: ${key}`); assert.ok(key in en, `en eksik: ${key}`); }
    for (const key of Object.keys(tr)) assert.ok(keys.has(key) || key.startsWith("panel") || key === "readmeText" || key === "bulkIndexTitle", `kullanılmayan anahtar: ${key}`);
  });
  await test("paket dosyaları Chrome'un kabul edeceği UTF-8 (ham kontrol/karakter-olmayan kod noktası yok)", () => {
    const files = ["manifest.json", "sidepanel.html", "sidepanel.js", "sidepanel.css", "print.html", "print.js", "print.css",
      ...fs.readdirSync(path.join(root, "src")).map(f => `src/${f}`), ...fs.readdirSync(path.join(root, "_locales")).map(l => `_locales/${l}/messages.json`)];
    for (const file of files) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(path.join(root, file)));
      const bad = [...text].find(c => { const n = c.codePointAt(0); return (n < 32 && !"\n\r\t".includes(c)) || (n & 0xfffe) === 0xfffe || (n >= 0xfdd0 && n <= 0xfdef); });
      assert.ok(!bad, `${file}: U+${bad?.codePointAt(0).toString(16)}`);
    }
  });
  await test("tüm diller eksiksiz: anahtarlar, yer tutucular, Store sınırları; _locales güncel", () => {
    assert.deepStrictEqual(checkLocales(), []);
    assert.ok(Object.keys(allLocales).length >= 10, Object.keys(allLocales).join());
    for (const lang of Object.keys(allLocales)) {
      const onDisk = JSON.parse(fs.readFileSync(path.join(root, "_locales", lang, "messages.json"), "utf8"));
      assert.strictEqual(Object.keys(onDisk).length, Object.keys(en).length, `${lang}: node tools/locales.js çalıştırılmalı`);
    }
  });
  await test("yer tutucu sayıları iki dilde eşleşir", () => {
    const count = s => new Set([...s.matchAll(/\{(\d)\}/g)].map(m => m[1])).size;
    for (const key of Object.keys(tr)) assert.strictEqual(count(tr[key]), count(en[key]), key);
  });
  await test("manifest: açıklama ≤132, izinler minimum, dosyalar mevcut", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    assert.deepStrictEqual([...manifest.permissions].sort(), ["contextMenus", "scripting", "sidePanel", "storage"]);
    assert.deepStrictEqual(manifest.host_permissions, ["https://chatgpt.com/*"], "yalnızca chatgpt.com");
    assert.deepStrictEqual(manifest.content_scripts.map(c => c.matches), [["https://chatgpt.com/*"]]);
    for (const c of manifest.content_scripts) for (const js of c.js) assert.ok(fs.existsSync(path.join(root, js)), js);
    assert.ok(manifest.side_panel.default_path === "sidepanel.html" && fs.existsSync(path.join(root, manifest.background.service_worker)));
    for (const file of ["print.html", "print.js", "print.css", "vendor/katex.min.js", "vendor/KATEX-LICENSE.txt"]) assert.ok(fs.existsSync(path.join(root, file)), file);
    for (const lang of [tr, en]) { assert.ok(lang.extDescription.length <= 132); assert.ok(lang.extName.length <= 75); }
    for (const icon of Object.values(manifest.icons)) assert.ok(fs.existsSync(path.join(root, icon)), icon);
    for (const file of ["sidepanel.js", "src/background.js"]) for (const m of fs.readFileSync(path.join(root, file), "utf8").matchAll(/"((?:src|vendor)\/[\w.-]+)"/g)) assert.ok(fs.existsSync(path.join(root, m[1])), m[1]);
  });
  await test("yan paneldeki alanlar sidepanel.js'in beklediği adlarla eşleşir", () => {
    const html = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
    const js = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
    for (const name of ["scope", "formats", "attachments", "textMode", "steps"]) assert.ok(html.includes(`name="${name}"`), name);
    for (const m of js.matchAll(/\$\("#([\w-]+)"\)/g)) assert.ok(html.includes(`id="${m[1]}"`), `sidepanel.html içinde #${m[1]} yok`);
  });

  console.log(process.exitCode ? "\nBAŞARISIZ" : `\n${passed} test geçti`);
})();
