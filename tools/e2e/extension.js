// Gerçek eklentiyle uçtan uca test: node tools/e2e/extension.js <chrome-yolu> <kayıt-klasörü>
// Önce sunucu (aynı E2E_LANG ile): python3 tools/e2e/server.py 8765 <kayıt-klasörü> <cert.pem> <key.pem>
// Eklenti yüklenir, sahte chatgpt.com sekmesi açılır, yan panel sayfası ayrı sekmede açılıp o sekmeye bağlanır.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const [chrome, out] = process.argv.slice(2);
const root = path.join(__dirname, "..", "..");
const PORT = 9340;
const LANG = process.env.E2E_LANG || "tr";  // yan panel arayüz dili (Store görselleri için; macOS'ta --lang yok sayılır)
const tag = LANG === "tr" ? "" : `-${LANG}`;
const TITLES = require("../fixture.js").chatTitles[LANG === "tr" ? "tr" : "en"]; // server.py aynı E2E_LANG ile başlatılmalı
const sleep = ms => new Promise(r => setTimeout(r, ms));

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener("message", e => {
    const m = JSON.parse(e.data);
    if (m.id) pending.get(m.id)?.(m);
    else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "evaluate failed");
    return r.result?.result?.value;
  };
  return { ready: new Promise(r => ws.addEventListener("open", r)), send, evaluate, errors, close: () => ws.close() };
}

async function waitFor(fn, label, timeout = 15000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`zaman aşımı: ${label}`);
    await sleep(150);
  }
}

(async () => {
  const downloads = path.join(out, "downloads-ext");
  fs.rmSync(downloads, { recursive: true, force: true });
  fs.rmSync(path.join(out, "ext-profile"), { recursive: true, force: true });
  const proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--enable-unsafe-extension-debugging", "--ignore-certificate-errors",
    `--user-data-dir=${out}/ext-profile`, `--remote-debugging-port=${PORT}`, "--host-resolver-rules=MAP chatgpt.com 127.0.0.1", "about:blank"], { stdio: "ignore" });
  let passed = 0;
  const step = async (name, fn) => { await fn(); passed++; console.log("  ✓", name); };
  try {
    await waitFor(async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { return null; } }, "chrome");
    const browser = connect((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl);
    await browser.ready;
    await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
    const loaded = await browser.send("Extensions.loadUnpacked", { path: process.env.EXT_PATH || root }); // EXT_PATH: çıkarılmış dist paketi
    const extId = loaded.result?.id;
    assert.ok(extId, `eklenti yüklenemedi: ${JSON.stringify(loaded.error)}`);
    const open = async url => (await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json());
    await open("https://chatgpt.com:8765/c/11111111-1111-1111-1111-111111111111");
    await sleep(800);
    const panelTarget = await open(`chrome-extension://${extId}/sidepanel.html`);
    const panel = connect(panelTarget.webSocketDebuggerUrl);
    globalThis.__panel = panel;
    await panel.ready;
    await panel.send("Runtime.enable");
    await panel.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 860, deviceScaleFactor: 2, mobile: false });
    await sleep(800);
    // Yan panel normalde aktif sekmeyi izler; burada panel kendi sekmesinde olduğundan sahte sohbet sekmesine bağlanır.
    const bind = (pattern = "https://chatgpt.com/c/*") => panel.evaluate(`(async () => { const [m] = await chrome.tabs.query({ url: ${JSON.stringify(pattern)} }); await setTab(m); return pageKind(tab); })()`);
    const shot = async name => {
      const r = await panel.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(out, `${name}${tag}.png`), Buffer.from(r.result.data, "base64"));
    };
    const state = () => panel.evaluate("JSON.stringify(progressByTab.get(tab.id) || null)").then(JSON.parse);
    const click = selector => panel.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const setFormats = formats => panel.evaluate(`(() => { for (const b of form.elements.formats) b.checked = ${JSON.stringify(formats)}.includes(b.value); form.dispatchEvent(new Event("change", { bubbles: true })); })()`);

    if (LANG !== "tr") {
      // Yalnızca görseller için: panel metinlerini istenen dilin messages.json dosyasından yeniden yükle.
      await panel.evaluate(`(async () => {
        const messages = await (await fetch(chrome.runtime.getURL("_locales/${LANG}/messages.json"))).json();
        Object.defineProperty(chrome.i18n, "getMessage", { configurable: true, value: (key, subs = []) => messages[key]?.message.replace(/\\$P(\\d)\\$/gi, (_, n) => subs[n - 1] ?? "") ?? "" });
        Object.defineProperty(chrome.i18n, "getUILanguage", { configurable: true, value: () => "${LANG}" });
        for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
        for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
      })()`);
    }
    await step("yan panel sahte chatgpt.com sohbet sekmesini tanır", async () => {
      assert.strictEqual(await bind(), "chat");
      const info = await panel.evaluate("document.querySelector('#tab-info').textContent");
      assert.ok(info.includes(TITLES[0]), info);
      console.log("    arayüz dili:", await panel.evaluate("chrome.i18n.getUILanguage()"));
      assert.strictEqual(await panel.evaluate("document.querySelector('#download').disabled"), false);
    });
    for (const scheme of ["light", "dark"]) {
      await panel.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await sleep(200);
      await shot(`panel-current-${scheme}`);
    }

    await step("açık sohbet → tek .md dosyası gerçekten indirilir", async () => {
      await click('input[name=scope][value=current]');
      await panel.evaluate("form.elements.attachments.checked = false");
      await setFormats(["md"]);
      await click("#download");
      const s = await waitFor(async () => { const v = await state(); return v && v.state !== "running" ? v : null; }, "tek sohbet");
      assert.strictEqual(s.state, "done", s.message);
      await waitFor(() => fs.existsSync(downloads) && fs.readdirSync(downloads).some(f => f.endsWith(".md")), "md indirmesi");
    });

    await step("açık sohbet + ekler → ZIP'te ekler, rapor ve HTML var", async () => {
      await panel.evaluate("progressByTab.clear(); renderProgress(); form.elements.attachments.checked = true");
      await setFormats(["md", "html"]);
      const before = new Set(fs.readdirSync(downloads));
      await click("#download");
      const s = await waitFor(async () => { const v = await state(); return v && v.state !== "running" ? v : null; }, "ekli zip");
      assert.strictEqual(s.state, "done", s.message);
      const zipFile = await waitFor(() => fs.readdirSync(downloads).find(f => !before.has(f) && f.endsWith(".zip") && !f.endsWith(".crdownload")), "zip");
      const list = require("child_process").execFileSync("unzip", ["-Z1", path.join(downloads, zipFile)]).toString();
      for (const name of ["conversation.md", "conversation.html", "indirme-raporu.json", "ekler/001-g.png", "ekler/002-notlar.txt", "ekler/004-sonuc.csv"]) assert.ok(list.includes(name), `${name} yok:\n${list}`);
      fs.unlinkSync(path.join(downloads, zipFile));
    });

    await step("Sohbet seç: liste yüklenir, seçim sayılır, seçilmeden indirilemez", async () => {
      await panel.evaluate("progressByTab.clear(); renderProgress()");
      await panel.evaluate("form.elements.attachments.checked = true");
      await setFormats(["md", "html"]);
      await click('input[name=scope][value=choose]');
      await waitFor(() => panel.evaluate("listState === 'ready'"), "liste");
      assert.strictEqual(await panel.evaluate("document.querySelectorAll('#pick-list .row').length"), 3);
      assert.strictEqual(await panel.evaluate("document.querySelector('#download').disabled"), true, "seçim yokken düğme kapalı");
      await click("#pick-all");
      await panel.evaluate(`(() => { const b = document.querySelector('#pick-list input'); b.click(); })()`);
      assert.strictEqual(await panel.evaluate("selected.size"), 2);
      assert.match(await panel.evaluate("document.querySelector('#pick-count').textContent"), /2\D+3|3\D+2/);
      await panel.evaluate(`(() => { const s = document.querySelector('#pick-search'); s.value = ${JSON.stringify(TITLES[2].split(" ")[0].toLowerCase())}; s.dispatchEvent(new Event('input')); })()`);
      assert.strictEqual(await panel.evaluate("document.querySelectorAll('#pick-list .row').length"), 1, "arama süzer");
      await panel.evaluate(`(() => { const s = document.querySelector('#pick-search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
    });
    for (const scheme of ["light", "dark"]) {
      await panel.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await sleep(200);
      await shot(`panel-choose-${scheme}`);
    }

    await step("Sohbet seç → yalnızca seçilen 2 sohbet ZIP'e girer", async () => {
      const before = new Set(fs.readdirSync(downloads));
      await click("#download");
      const s = await waitFor(async () => { const v = await state(); return v && v.state !== "running" ? v : null; }, "seçili indirme", 30000);
      assert.strictEqual(s.state, "done", s.message);
      assert.match(s.message, /\b2\b/);
      const zipFile = await waitFor(() => fs.readdirSync(downloads).find(f => !before.has(f) && f.startsWith("chatgpt-sohbetler-") && f.endsWith(".zip")), "zip");
      const list = require("child_process").execFileSync("unzip", ["-Z1", path.join(downloads, zipFile)]).toString();
      assert.strictEqual(new Set(list.split("\n").filter(l => l.startsWith("sohbetler/")).map(l => l.split("/")[1])).size, 2, list);
      assert.ok(list.includes("index.html") && list.includes("assets/chats.js"));
      fs.unlinkSync(path.join(downloads, zipFile)); // aynı adlı sonraki ZIP üzerine yazılır
    });
    await panel.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await shot("panel-done-light");

    await step("Tüm sohbetler → 3 sohbet, index.html ve ortak kenar çubuğu", async () => {
      await panel.evaluate("progressByTab.clear(); renderProgress()");
      await click('input[name=scope][value=all]');
      const before = new Set(fs.readdirSync(downloads));
      await click("#download");
      const s = await waitFor(async () => { const v = await state(); return v && v.state !== "running" ? v : null; }, "tüm sohbetler", 30000);
      assert.strictEqual(s.state, "done", s.message);
      const zipFile = await waitFor(() => fs.readdirSync(downloads).find(f => !before.has(f) && f.endsWith(".zip") && !f.endsWith(".crdownload")), "zip");
      const list = require("child_process").execFileSync("unzip", ["-Z1", path.join(downloads, zipFile)]).toString();
      assert.strictEqual(new Set(list.split("\n").filter(l => l.startsWith("sohbetler/")).map(l => l.split("/")[1])).size, 3);
      assert.ok(!list.includes("/ekler/"), "Tüm sohbetler yalnızca metin olmalı");
      fs.unlinkSync(path.join(downloads, zipFile));
    });


    const lastState = (label, timeout = 30000) => waitFor(async () => { const v = await state(); return v && v.state !== "running" ? v : null; }, label, timeout);
    // Aynı adlı dosyalar üzerine yazıldığından "yeni" dosya, değiştirilme zamanıyla belirlenir.
    const newFile = async (since, test, label) => waitFor(() => fs.readdirSync(downloads)
      .find(f => !f.endsWith(".crdownload") && test(f) && fs.statSync(path.join(downloads, f)).mtimeMs >= since), label);
    const unzipList = file => require("child_process").execFileSync("unzip", ["-Z1", path.join(downloads, file)]).toString();

    await step("mesaj seçimi: Yalnızca cevaplar → yalnızca ChatGPT mesajı indirilir", async () => {
      await panel.evaluate("progressByTab.clear(); renderProgress(); form.elements.attachments.checked = false");
      await click('input[name=scope][value=current]');
      await setFormats(["md"]);
      await click("#messages-only");
      await waitFor(() => panel.evaluate("messageState === 'ready'"), "mesaj listesi");
      assert.strictEqual(await panel.evaluate("document.querySelectorAll('#msg-list .row').length"), 2);
      await click("#msg-answers");
      assert.strictEqual(await panel.evaluate("selectedMessages.size"), 1);
      for (const f of fs.readdirSync(downloads)) if (f.endsWith(".md")) fs.unlinkSync(path.join(downloads, f));
      const before = Date.now() - 50;
      await click("#download");
      assert.strictEqual((await lastState("mesaj seçimi")).state, "done");
      const md = fs.readFileSync(path.join(downloads, await newFile(before, f => f.endsWith(".md"), "md")), "utf8");
      assert.ok(md.includes("Başlık") && !md.includes("Merhaba"), md.slice(0, 300));
      await click("#messages-only");
    });
    await panel.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

    await step("Word + PDF: ZIP'te conversation.docx, PDF yazdırma sekmesi açılır", async () => {
      await panel.evaluate("progressByTab.clear(); renderProgress(); form.elements.attachments.checked = true");
      await setFormats(["docx", "pdf"]);
      const before = Date.now() - 50;
      await click("#download");
      const printTarget = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.url.includes("/print.html#")), "yazdırma sekmesi");
      const printer = connect(printTarget.webSocketDebuggerUrl);
      await printer.ready;
      const info = await waitFor(() => printer.evaluate(`(() => { const d = document.querySelector('#frame').contentDocument; return d && d.querySelector('section.conv') ? JSON.stringify({ sections: d.querySelectorAll('section.conv').length, dataImages: [...d.images].filter(i => i.src.startsWith('data:image/png')).length, button: !document.querySelector('#print').disabled }) : ''; })()`), "yazdırma içeriği");
      const parsed = JSON.parse(info);
      assert.ok(parsed.sections === 1 && parsed.dataImages >= 1 && parsed.button, info);
      const r = await printer.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(out, `print-page${tag}.png`), Buffer.from(r.result.data, "base64"));
      printer.close();
      await fetch(`http://127.0.0.1:${PORT}/json/close/${printTarget.id}`);
      // Yazdırma sekmesi öne geçtiği için yan panel onu izlemeye başladı; sohbet sekmesine geri bağla.
      await sleep(300);
      await bind();
      assert.strictEqual((await lastState("word+pdf")).state, "done");
      const zipFile = await newFile(before, f => f.endsWith(".zip"), "docx zip");
      assert.ok(unzipList(zipFile).includes("conversation.docx"));
      fs.unlinkSync(path.join(downloads, zipFile));
    });

    await step("Tümü + galeri + artımlı: yalnızca görseller iner; ikinci çalıştırmada değişmeyenler atlanır", async () => {
      await panel.evaluate("progressByTab.clear(); renderProgress()");
      await click("#reset-backup");
      await click('input[name=scope][value=all]');
      await setFormats(["md", "html"]);
      await panel.evaluate(`form.elements.gallery.checked = true; form.elements.incremental.checked = true; form.dispatchEvent(new Event("change", { bubbles: true }))`);
      let before = Date.now() - 50;
      await click("#download");
      assert.strictEqual((await lastState("galeri")).state, "done");
      const zipFile = await newFile(before, f => f.endsWith(".zip"), "galeri zip");
      const list = unzipList(zipFile);
      assert.ok(list.includes("galeri.html") && /sohbetler\/[^/]+\/ekler\/001-g\.png/.test(list) && !list.includes("notlar.txt"), list);
      fs.unlinkSync(path.join(downloads, zipFile));
      assert.strictEqual(await panel.evaluate("Object.keys(backupState).length"), 3, "yedek durumu kaydedildi");
      await panel.evaluate("progressByTab.clear(); renderProgress()");
      before = Date.now() - 50;
      await click("#download");
      const s = await lastState("artımlı");
      assert.ok(s.state === "done" && /3/.test(s.message), s.message);
      await sleep(800);
      assert.ok(!fs.readdirSync(downloads).some(f => fs.statSync(path.join(downloads, f)).mtimeMs >= before), "değişen yokken dosya inmemeli");
      await panel.evaluate(`form.elements.gallery.checked = false; form.elements.incremental.checked = false; form.dispatchEvent(new Event("change", { bubbles: true }))`);
    });

    await step("klasöre kaydet (Obsidian): dosyalar yazılır, ikinci yedek arşiv dizinine eklenir", async () => {
      await panel.evaluate(`(async () => {
        folderHandle = await navigator.storage.getDirectory();
        for await (const name of folderHandle.keys()) await folderHandle.removeEntry(name, { recursive: true });
        renderFolder();
        form.elements.saveMode.value = "folder"; form.elements.obsidian.checked = true;
        form.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
      await setFormats(["md", "html"]);
      await panel.evaluate("progressByTab.clear(); renderProgress()");
      await click('input[name=scope][value=choose]');
      await waitFor(() => panel.evaluate("listState === 'ready'"), "liste");
      await click("#pick-all");
      await panel.evaluate(`(() => { document.querySelector('#pick-list input').click(); })()`);
      await click("#download");
      let s = await lastState("klasör");
      assert.strictEqual(s.state, "done", s.message);
      const read = expression => panel.evaluate(`(async () => { ${expression} })()`);
      const tree = JSON.parse(await read(`
        const out = []; const walk = async (dir, prefix) => { for await (const [name, h] of dir.entries()) { if (h.kind === "directory") await walk(h, prefix + name + "/"); else out.push(prefix + name); } };
        await walk(folderHandle, ""); return JSON.stringify(out.sort());`));
      assert.ok(tree.includes("index.md") && tree.includes("index.html") && tree.includes("assets/chats.js") && tree.includes("assets/arsiv.json"), tree.join("\n"));
      const note = tree.find(f => f.startsWith("sohbetler/") && f.endsWith(`/${TITLES[1]}.md`));
      assert.ok(note, "Obsidian not adı başlık olmalı:\n" + tree.join("\n"));
      const md = await read(`let h = folderHandle; for (const part of ${JSON.stringify(note.split("/"))}.slice(0, -1)) h = await h.getDirectoryHandle(part); return (await (await h.getFileHandle(${JSON.stringify(TITLES[1] + ".md")})).getFile()).text();`);
      assert.ok(md.startsWith(`---\ntitle: "${TITLES[1]}"`), md.slice(0, 120));
      // İkinci yedek: açık sohbet aynı klasöre; dizin birleşir.
      await panel.evaluate("progressByTab.clear(); renderProgress()");
      await click('input[name=scope][value=current]');
      await click("#download");
      s = await lastState("klasör 2");
      assert.strictEqual(s.state, "done", s.message);
      const rows = JSON.parse(await read(`return await (await (await (await folderHandle.getDirectoryHandle("assets")).getFileHandle("arsiv.json")).getFile()).text();`)).rows;
      assert.strictEqual(rows.length, 3, JSON.stringify(rows));
      await panel.evaluate(`form.elements.saveMode.value = "zip"; form.elements.obsidian.checked = false; form.dispatchEvent(new Event("change", { bubbles: true }))`);
    });

    await step("sayfadaki İndir düğmesi ve sağ tık (arka plan) son ayarlarla indirir", async () => {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const pageTarget = targets.find(x => x.url.startsWith("https://chatgpt.com:8765/c/"));
      const pageWs = connect(pageTarget.webSocketDebuggerUrl);
      await pageWs.ready;
      await waitFor(() => pageWs.evaluate("Boolean(document.querySelector('#csi-page-button'))"), "sayfa düğmesi");
      assert.strictEqual(await pageWs.evaluate("document.querySelector('#csi-page-button').nextElementSibling.dataset.testid"), "share-chat-button");
      await setFormats(["md"]);
      await panel.evaluate("form.elements.attachments.checked = false; saveSettings()");
      await sleep(300);
      let before = Date.now() - 50;
      await pageWs.evaluate("document.querySelector('#csi-page-button').shadowRoot.querySelector('button').click()");
      await newFile(before, f => f.endsWith(".md") && f.includes("11111111"), "düğmeyle indirme");
      await pageWs.evaluate("document.querySelector('#csi-page-button') && 0");
      // Sağ tık "Bu sohbeti indir": bağlantıdaki sohbet kimliğiyle arka plan dışa aktarması.
      const sw = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.type === "service_worker" && x.url.includes(extId));
      assert.ok(sw, "servis çalışanı bulunamadı");
      const worker = connect(sw.webSocketDebuggerUrl);
      await worker.ready;
      before = Date.now() - 50;
      await waitFor(() => pageWs.evaluate("!globalThis.document.querySelector('#chatgpt-export-status progress[value=\"1\"]') || true"), "hazır");
      await sleep(600);
      await worker.evaluate(`chrome.tabs.query({ url: "https://chatgpt.com/*" }).then(([tab]) => quickExport(tab, "00000002-1111-2222-3333-444444444442")).then(() => true)`);
      await newFile(before, f => f.endsWith(".md") && f.includes("00000002"), "sağ tık indirmesi");
      worker.close();
      pageWs.close();
    });


    await step("paylaşım bağlantısı (/share/…) açık sohbet olarak indirilir", async () => {
      await open("https://chatgpt.com:8765/share/22222222-2222-2222-2222-222222222222");
      await sleep(800);
      assert.strictEqual(await bind("https://chatgpt.com/share/*"), "share");
      await panel.evaluate("form.elements.attachments.checked = false");
      await click('input[name=scope][value=current]');
      await setFormats(["md"]);
      const before = Date.now() - 50;
      await click("#download");
      assert.strictEqual((await lastState("paylaşım")).state, "done");
      const md = fs.readFileSync(path.join(downloads, await newFile(before, f => f.endsWith(".md") && f.includes("22222222"), "paylaşım md")), "utf8");
      assert.ok(md.startsWith("# Paylaşılan sohbet") && md.includes("Merhaba") && md.includes("Başlık"), md.slice(0, 200));
      await bind();
    });


    await step("paylaşım API'si yanıt vermezse ekrandaki mesajlar Markdown'a çevrilir", async () => {
      await open("https://chatgpt.com:8765/share/33333333-3333-3333-3333-333333333333");
      await sleep(800);
      assert.strictEqual(await bind("https://chatgpt.com/share/3333*"), "share");
      await panel.evaluate("progressByTab.clear(); renderProgress()");
      const before = Date.now() - 50;
      await click("#download");
      assert.strictEqual((await lastState("dom yedeği")).state, "done");
      const md = fs.readFileSync(path.join(downloads, await newFile(before, f => f.endsWith(".md") && f.includes("33333333"), "dom md")), "utf8");
      for (const piece of ["Kısa soru?", "## Yanıt", "**kalın**", "$x^2$", "```python\nprint(1)\n```", "- bir\n- iki"]) assert.ok(md.includes(piece), `${piece} yok:\n${md}`);
      assert.ok(!md.includes("Kopyala"), "kod bloğu düğmesi metne karışmamalı");
      await bind();
    });

    await step("yan paneldeki İptal düğmesi sayfadaki işlemi durdurur", async () => {
      await panel.evaluate("progressByTab.clear(); renderProgress()");
      await click('input[name=scope][value=all]');
      await click("#download");
      await waitFor(async () => (await state())?.state === "running" && panel.evaluate("!document.querySelector('#cancel').hidden"), "çalışıyor");
      await click("#cancel");
      const s = await waitFor(async () => { const v = await state(); return v && v.state !== "running" ? v : null; }, "iptal");
      assert.strictEqual(s.state, "cancelled", s.message);
    });

    await step("yan panelde betik hatası yok", async () => {
      assert.deepStrictEqual(panel.errors, []);
    });
    await panel.evaluate(`document.querySelector('input[name=scope][value=current]').click()`);
    console.log(`\n${passed} uçtan uca test geçti`);
  } catch (error) {
    console.error("  ✗", error.message);
    try { console.error("    panel durumu:", await globalThis.__panel?.evaluate("document.querySelector('#status').textContent + ' | ' + JSON.stringify([...progressByTab.values()])"), "\n    panel hataları:", globalThis.__panel?.errors); } catch {}
    process.exitCode = 1;
  } finally {
    proc.kill();
  }
})();
