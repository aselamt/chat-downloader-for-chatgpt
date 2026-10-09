// End-to-end test with the real extension: node tools/e2e/extension.js <chrome-path> <output-dir>
// Start the server first (with the same E2E_LANG): python3 tools/e2e/server.py 8765 <output-dir> <cert.pem> <key.pem>
// Loads the extension, opens a mock chatgpt.com tab, and opens the side panel page in its own tab bound to that tab.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const [chrome, out] = process.argv.slice(2);
const root = path.join(__dirname, "..", "..");
const PORT = 9340;
const LANG = process.env.E2E_LANG || "en";  // side panel UI language (for Store screenshots; macOS ignores --lang)
const tag = `-${LANG}`;
const TITLES = require("../fixture.js").chatTitles[LANG === "tr" ? "tr" : "en"]; // start server.py with the same E2E_LANG
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
    if (Date.now() - start > timeout) throw new Error(`timed out: ${label}`);
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
    const loaded = await browser.send("Extensions.loadUnpacked", { path: process.env.EXT_PATH || root }); // EXT_PATH: an unpacked dist package
    const extId = loaded.result?.id;
    assert.ok(extId, `could not load the extension: ${JSON.stringify(loaded.error)}`);
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
    // The side panel normally follows the active tab; here it lives in its own tab, so it is bound to the mock chat tab.
    const bind = (pattern = "https://chatgpt.com/c/*") => panel.evaluate(`(async () => { const [m] = await chrome.tabs.query({ url: ${JSON.stringify(pattern)} }); await setTab(m); return pageKind(tab); })()`);
    const shot = async name => {
      const r = await panel.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(out, `${name}${tag}.png`), Buffer.from(r.result.data, "base64"));
    };
    const state = () => panel.evaluate("JSON.stringify(progressByTab.get(tab.id) || null)").then(JSON.parse);
    const click = selector => panel.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const setFormats = formats => panel.evaluate(`(() => { for (const b of form.elements.formats) b.checked = ${JSON.stringify(formats)}.includes(b.value); form.dispatchEvent(new Event("change", { bubbles: true })); })()`);

    {
      // Headless Chrome uses the OS language, so reload the panel text from the requested language's messages.json.
      await panel.evaluate(`(async () => {
        const messages = await (await fetch(chrome.runtime.getURL("_locales/${LANG}/messages.json"))).json();
        Object.defineProperty(chrome.i18n, "getMessage", { configurable: true, value: (key, subs = []) => messages[key]?.message.replace(/\\$P(\\d)\\$/gi, (_, n) => subs[n - 1] ?? "") ?? "" });
        Object.defineProperty(chrome.i18n, "getUILanguage", { configurable: true, value: () => "${LANG}" });
        for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
        for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
      })()`);
    }
    await step("side panel recognizes the mock chatgpt.com chat tab", async () => {
      assert.strictEqual(await bind(), "chat");
      const info = await panel.evaluate("document.querySelector('#tab-info').textContent");
      assert.ok(info.includes(TITLES[0]), info);
      console.log("    UI language:", await panel.evaluate("chrome.i18n.getUILanguage()"));
      assert.strictEqual(await panel.evaluate("document.querySelector('#download').disabled"), false);
    });
    for (const scheme of ["light", "dark"]) {
      await panel.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await sleep(200);
      await shot(`panel-current-${scheme}`);
    }

    await step("open chat → a single .md file is downloaded", async () => {
      await click('input[name=scope][value=current]');
      await panel.evaluate("form.elements.attachments.checked = false");
      await setFormats(["md"]);
      await click("#download");
      const s = await waitFor(async () => { const v = await state(); return v && v.state !== "running" ? v : null; }, "single chat");
      assert.strictEqual(s.state, "done", s.message);
      await waitFor(() => fs.existsSync(downloads) && fs.readdirSync(downloads).some(f => f.endsWith(".md")), "md indirmesi");
    });

    await step("open chat + attachments → ZIP has attachments, report and HTML", async () => {
      await panel.evaluate("progressByTab.clear(); renderProgress(); form.elements.attachments.checked = true");
      await setFormats(["md", "html"]);
      const before = new Set(fs.readdirSync(downloads));
      await click("#download");
      const s = await waitFor(async () => { const v = await state(); return v && v.state !== "running" ? v : null; }, "ekli zip");
      assert.strictEqual(s.state, "done", s.message);
      const zipFile = await waitFor(() => fs.readdirSync(downloads).find(f => !before.has(f) && f.endsWith(".zip") && !f.endsWith(".crdownload")), "zip");
      const list = require("child_process").execFileSync("unzip", ["-Z1", path.join(downloads, zipFile)]).toString();
      for (const name of ["conversation.md", "conversation.html", "download-report.json", "attachments/001-g.png", "attachments/002-notes.txt", "attachments/004-result.csv"]) assert.ok(list.includes(name), `${name} missing:\n${list}`);
      fs.unlinkSync(path.join(downloads, zipFile));
    });

    await step("Choose chats: list loads, selection is counted, nothing downloads without a selection", async () => {
      await panel.evaluate("progressByTab.clear(); renderProgress()");
      await panel.evaluate("form.elements.attachments.checked = true");
      await setFormats(["md", "html"]);
      await click('input[name=scope][value=choose]');
      await waitFor(() => panel.evaluate("listState === 'ready'"), "liste");
      assert.strictEqual(await panel.evaluate("document.querySelectorAll('#pick-list .row').length"), 3);
      assert.strictEqual(await panel.evaluate("document.querySelector('#download').disabled"), true, "button disabled without a selection");
      await click("#pick-all");
      await panel.evaluate(`(() => { const b = document.querySelector('#pick-list input'); b.click(); })()`);
      assert.strictEqual(await panel.evaluate("selected.size"), 2);
      assert.match(await panel.evaluate("document.querySelector('#pick-count').textContent"), /2\D+3|3\D+2/);
      await panel.evaluate(`(() => { const s = document.querySelector('#pick-search'); s.value = ${JSON.stringify(TITLES[2].split(" ")[0].toLowerCase())}; s.dispatchEvent(new Event('input')); })()`);
      assert.strictEqual(await panel.evaluate("document.querySelectorAll('#pick-list .row').length"), 1, "search filters");
      await panel.evaluate(`(() => { const s = document.querySelector('#pick-search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
    });
    for (const scheme of ["light", "dark"]) {
      await panel.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await sleep(200);
      await shot(`panel-choose-${scheme}`);
    }

    await step("Choose chats → only the 2 picked chats go into the ZIP", async () => {
      const before = new Set(fs.readdirSync(downloads));
      await click("#download");
      const s = await waitFor(async () => { const v = await state(); return v && v.state !== "running" ? v : null; }, "selected download", 30000);
      assert.strictEqual(s.state, "done", s.message);
      assert.match(s.message, /\b2\b/);
      const zipFile = await waitFor(() => fs.readdirSync(downloads).find(f => !before.has(f) && f.startsWith("chatgpt-chats-") && f.endsWith(".zip")), "zip");
      const list = require("child_process").execFileSync("unzip", ["-Z1", path.join(downloads, zipFile)]).toString();
      assert.strictEqual(new Set(list.split("\n").filter(l => l.startsWith("chats/")).map(l => l.split("/")[1])).size, 2, list);
      assert.ok(list.includes("index.html") && list.includes("assets/chats.js"));
      fs.unlinkSync(path.join(downloads, zipFile)); // the next ZIP has the same name
    });
    await panel.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await shot("panel-done-light");

    await step("All chats → 3 chats, index.html and a shared sidebar", async () => {
      await panel.evaluate("progressByTab.clear(); renderProgress()");
      await click('input[name=scope][value=all]');
      const before = new Set(fs.readdirSync(downloads));
      await click("#download");
      const s = await waitFor(async () => { const v = await state(); return v && v.state !== "running" ? v : null; }, "all chats", 30000);
      assert.strictEqual(s.state, "done", s.message);
      const zipFile = await waitFor(() => fs.readdirSync(downloads).find(f => !before.has(f) && f.endsWith(".zip") && !f.endsWith(".crdownload")), "zip");
      const list = require("child_process").execFileSync("unzip", ["-Z1", path.join(downloads, zipFile)]).toString();
      assert.strictEqual(new Set(list.split("\n").filter(l => l.startsWith("chats/")).map(l => l.split("/")[1])).size, 3);
      assert.ok(!list.includes("/attachments/"), "All chats should be text only");
      fs.unlinkSync(path.join(downloads, zipFile));
    });


    const lastState = (label, timeout = 30000) => waitFor(async () => { const v = await state(); return v && v.state !== "running" ? v : null; }, label, timeout);
    // Files with the same name are overwritten, so a "new" file is detected by its modification time.
    const newFile = async (since, test, label) => waitFor(() => fs.readdirSync(downloads)
      .find(f => !f.endsWith(".crdownload") && test(f) && fs.statSync(path.join(downloads, f)).mtimeMs >= since), label);
    const unzipList = file => require("child_process").execFileSync("unzip", ["-Z1", path.join(downloads, file)]).toString();

    await step("message selection: Answers only → only the ChatGPT message is downloaded", async () => {
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
      assert.strictEqual((await lastState("message selection")).state, "done");
      const md = fs.readFileSync(path.join(downloads, await newFile(before, f => f.endsWith(".md"), "md")), "utf8");
      assert.ok(md.includes("Heading") && !md.includes("Hello"), md.slice(0, 300));
      await click("#messages-only");
    });
    await panel.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

    await step("Word + PDF: conversation.docx in the ZIP, PDF print tab opens", async () => {
      await panel.evaluate("progressByTab.clear(); renderProgress(); form.elements.attachments.checked = true");
      await setFormats(["docx", "pdf"]);
      const before = Date.now() - 50;
      await click("#download");
      const printTarget = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.url.includes("/print.html#")), "print tab");
      const printer = connect(printTarget.webSocketDebuggerUrl);
      await printer.ready;
      const info = await waitFor(() => printer.evaluate(`(() => { const d = document.querySelector('#frame').contentDocument; return d && d.querySelector('section.conv') ? JSON.stringify({ sections: d.querySelectorAll('section.conv').length, dataImages: [...d.images].filter(i => i.src.startsWith('data:image/png')).length, button: !document.querySelector('#print').disabled }) : ''; })()`), "print content");
      const parsed = JSON.parse(info);
      assert.ok(parsed.sections === 1 && parsed.dataImages >= 1 && parsed.button, info);
      const r = await printer.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(out, `print-page${tag}.png`), Buffer.from(r.result.data, "base64"));
      printer.close();
      await fetch(`http://127.0.0.1:${PORT}/json/close/${printTarget.id}`);
      // The print tab came to the front and the panel started following it; bind back to the chat tab.
      await sleep(300);
      await bind();
      assert.strictEqual((await lastState("word+pdf")).state, "done");
      const zipFile = await newFile(before, f => f.endsWith(".zip"), "docx zip");
      assert.ok(unzipList(zipFile).includes("conversation.docx"));
      fs.unlinkSync(path.join(downloads, zipFile));
    });

    await step("All + gallery + incremental: only images download; unchanged chats are skipped on the second run", async () => {
      await panel.evaluate("progressByTab.clear(); renderProgress()");
      await click("#reset-backup");
      await click('input[name=scope][value=all]');
      await setFormats(["md", "html"]);
      await panel.evaluate(`form.elements.gallery.checked = true; form.elements.incremental.checked = true; form.dispatchEvent(new Event("change", { bubbles: true }))`);
      let before = Date.now() - 50;
      await click("#download");
      assert.strictEqual((await lastState("gallery")).state, "done");
      const zipFile = await newFile(before, f => f.endsWith(".zip"), "gallery zip");
      const list = unzipList(zipFile);
      assert.ok(list.includes("gallery.html") && /chats\/[^/]+\/attachments\/001-g\.png/.test(list) && !list.includes("notes.txt"), list);
      fs.unlinkSync(path.join(downloads, zipFile));
      assert.strictEqual(await panel.evaluate("Object.keys(backupState).length"), 3, "yedek durumu kaydedildi");
      await panel.evaluate("progressByTab.clear(); renderProgress()");
      before = Date.now() - 50;
      await click("#download");
      const s = await lastState("incremental");
      assert.ok(s.state === "done" && /3/.test(s.message), s.message);
      await sleep(800);
      assert.ok(!fs.readdirSync(downloads).some(f => fs.statSync(path.join(downloads, f)).mtimeMs >= before), "nothing should download when nothing changed");
      await panel.evaluate(`form.elements.gallery.checked = false; form.elements.incremental.checked = false; form.dispatchEvent(new Event("change", { bubbles: true }))`);
    });

    await step("save to folder (Obsidian): files are written; a second backup is merged into the archive index", async () => {
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
      let s = await lastState("folder");
      assert.strictEqual(s.state, "done", s.message);
      const read = expression => panel.evaluate(`(async () => { ${expression} })()`);
      const tree = JSON.parse(await read(`
        const out = []; const walk = async (dir, prefix) => { for await (const [name, h] of dir.entries()) { if (h.kind === "directory") await walk(h, prefix + name + "/"); else out.push(prefix + name); } };
        await walk(folderHandle, ""); return JSON.stringify(out.sort());`));
      assert.ok(tree.includes("index.md") && tree.includes("index.html") && tree.includes("assets/chats.js") && tree.includes("assets/archive.json"), tree.join("\n"));
      const note = tree.find(f => f.startsWith("chats/") && f.endsWith(`/${TITLES[1]}.md`));
      assert.ok(note, "Obsidian note should be named after the title:\n" + tree.join("\n"));
      const md = await read(`let h = folderHandle; for (const part of ${JSON.stringify(note.split("/"))}.slice(0, -1)) h = await h.getDirectoryHandle(part); return (await (await h.getFileHandle(${JSON.stringify(TITLES[1] + ".md")})).getFile()).text();`);
      assert.ok(md.startsWith(`---\ntitle: "${TITLES[1]}"`), md.slice(0, 120));
      // Second backup: the open chat into the same folder; the index merges.
      await panel.evaluate("progressByTab.clear(); renderProgress()");
      await click('input[name=scope][value=current]');
      await click("#download");
      s = await lastState("folder 2");
      assert.strictEqual(s.state, "done", s.message);
      const rows = JSON.parse(await read(`return await (await (await (await folderHandle.getDirectoryHandle("assets")).getFileHandle("archive.json")).getFile()).text();`)).rows;
      assert.strictEqual(rows.length, 3, JSON.stringify(rows));
      await panel.evaluate(`form.elements.saveMode.value = "zip"; form.elements.obsidian.checked = false; form.dispatchEvent(new Event("change", { bubbles: true }))`);
    });

    await step("on-page Download button and context menu (background) export with the last settings", async () => {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const pageTarget = targets.find(x => x.url.startsWith("https://chatgpt.com:8765/c/"));
      const pageWs = connect(pageTarget.webSocketDebuggerUrl);
      await pageWs.ready;
      await waitFor(() => pageWs.evaluate("Boolean(document.querySelector('#csi-page-button'))"), "page button");
      assert.strictEqual(await pageWs.evaluate("document.querySelector('#csi-page-button').nextElementSibling.dataset.testid"), "share-chat-button");
      await setFormats(["md"]);
      await panel.evaluate("form.elements.attachments.checked = false; saveSettings()");
      await sleep(300);
      let before = Date.now() - 50;
      await pageWs.evaluate("document.querySelector('#csi-page-button').shadowRoot.querySelector('button').click()");
      await newFile(before, f => f.endsWith(".md") && f.includes("11111111"), "button download");
      await pageWs.evaluate("document.querySelector('#csi-page-button') && 0");
      // Context menu "Download this chat": a background export using the chat id in the link.
      const sw = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.type === "service_worker" && x.url.includes(extId));
      assert.ok(sw, "service worker not found");
      const worker = connect(sw.webSocketDebuggerUrl);
      await worker.ready;
      before = Date.now() - 50;
      await waitFor(() => pageWs.evaluate("!globalThis.document.querySelector('#chatgpt-export-status progress[value=\"1\"]') || true"), "ready");
      await sleep(600);
      await worker.evaluate(`chrome.tabs.query({ url: "https://chatgpt.com/*" }).then(([tab]) => quickExport(tab, "00000002-1111-2222-3333-444444444442")).then(() => true)`);
      await newFile(before, f => f.endsWith(".md") && f.includes("00000002"), "context menu download");
      worker.close();
      pageWs.close();
    });


    await step("shared link (/share/…) is exported as the open chat", async () => {
      await open("https://chatgpt.com:8765/share/22222222-2222-2222-2222-222222222222");
      await sleep(800);
      assert.strictEqual(await bind("https://chatgpt.com/share/*"), "share");
      await panel.evaluate("form.elements.attachments.checked = false");
      await click('input[name=scope][value=current]');
      await setFormats(["md"]);
      const before = Date.now() - 50;
      await click("#download");
      assert.strictEqual((await lastState("share")).state, "done");
      const md = fs.readFileSync(path.join(downloads, await newFile(before, f => f.endsWith(".md") && f.includes("22222222"), "share md")), "utf8");
      assert.ok(md.startsWith("# Shared chat") && md.includes("Hello") && md.includes("Heading"), md.slice(0, 200));
      await bind();
    });


    await step("if the share API fails, the messages on screen are converted to Markdown", async () => {
      await open("https://chatgpt.com:8765/share/33333333-3333-3333-3333-333333333333");
      await sleep(800);
      assert.strictEqual(await bind("https://chatgpt.com/share/3333*"), "share");
      await panel.evaluate("progressByTab.clear(); renderProgress()");
      const before = Date.now() - 50;
      await click("#download");
      assert.strictEqual((await lastState("dom fallback")).state, "done");
      const md = fs.readFileSync(path.join(downloads, await newFile(before, f => f.endsWith(".md") && f.includes("33333333"), "dom md")), "utf8");
      for (const piece of ["Short question?", "## Answer", "**bold**", "$x^2$", "```python\nprint(1)\n```", "- one\n- two"]) assert.ok(md.includes(piece), `${piece} missing:\n${md}`);
      assert.ok(!md.includes("Copy code"), "the code block button must not leak into the text");
      await bind();
    });

    await step("Cancel in the side panel stops the export in the page", async () => {
      await panel.evaluate("progressByTab.clear(); renderProgress()");
      await click('input[name=scope][value=all]');
      await click("#download");
      await waitFor(async () => (await state())?.state === "running" && panel.evaluate("!document.querySelector('#cancel').hidden"), "running");
      await click("#cancel");
      const s = await waitFor(async () => { const v = await state(); return v && v.state !== "running" ? v : null; }, "iptal");
      assert.strictEqual(s.state, "cancelled", s.message);
    });

    await step("no script errors in the side panel", async () => {
      assert.deepStrictEqual(panel.errors, []);
    });
    await panel.evaluate(`document.querySelector('input[name=scope][value=current]').click()`);
    console.log(`\n${passed} end-to-end tests passed`);
  } catch (error) {
    console.error("  ✗", error.message);
    try { console.error("    panel state:", await globalThis.__panel?.evaluate("document.querySelector('#status').textContent + ' | ' + JSON.stringify([...progressByTab.values()])"), "\n    panel errors:", globalThis.__panel?.errors); } catch {}
    process.exitCode = 1;
  } finally {
    proc.kill();
  }
})();
