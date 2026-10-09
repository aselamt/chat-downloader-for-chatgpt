// Injected into the chat tab: chat/message lists, the status panel and the export flow.
// Progress is reported to the side panel by message; the panel can stop it with "csi-cancel". For PDF the print page
// goes to the background; in "Save to a folder" mode files go to the side panel (csi-folder port).
// The file runs again on every injection, so it uses an IIFE instead of top-level const/let.
(() => {
  const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
  const UUID = /^[a-f0-9-]{36}$/i;
  const MESSAGE_ID = /^[\w-]{1,80}$/;

  function pageInfo() {
    return {
      chat: location.pathname.match(/\/c\/([a-f0-9-]{36})(?:\/|$)/i)?.[1] || null,
      share: location.pathname.match(/\/share\/(?:e\/)?([a-f0-9-]{36})(?:\/|$)/i)?.[1] || null
    };
  }

  // Without a session, shared links can still be tried (optional = true).
  async function sessionToken(signal, optional = false) {
    try {
      const response = await fetch("/api/auth/session", { credentials: "same-origin", signal });
      if (!response.ok) throw new Error(`${t("errSession")}: HTTP ${response.status}`);
      const session = await response.json();
      if (!session.accessToken) throw new Error(t("errNoToken"));
      return session.accessToken;
    } catch (error) {
      if (optional && !signal?.aborted) return null;
      throw error;
    }
  }

  // ---- Fallback for shared pages: converts the messages on screen to Markdown ----
  function domToMarkdown(root) {
    const walk = node => {
      if (node.nodeType === 3) return node.nodeValue;
      if (node.nodeType !== 1) return "";
      const element = node;
      const tag = element.tagName.toLowerCase();
      const kids = () => [...element.childNodes].map(walk).join("");
      if (element.classList.contains("katex-display") || element.classList.contains("katex")) {
        const tex = element.querySelector('annotation[encoding="application/x-tex"]')?.textContent || "";
        return element.classList.contains("katex-display") ? `\n\n\\[${tex}\\]\n\n` : `\\(${tex}\\)`;
      }
      switch (tag) {
        case "button": case "svg": case "style": case "script": return "";
        case "pre": {
          const code = element.querySelector("code");
          const lang = (code?.className.match(/language-([\w+#.-]+)/) || [])[1] || "";
          const text = (code || element).textContent.replace(/\n$/, "");
          const fence = "`".repeat(Math.max(3, ...(text.match(/`+/g) || []).map(run => run.length + 1)));
          return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
        }
        case "code": return `\`${element.textContent}\``;
        case "strong": case "b": return `**${kids()}**`;
        case "em": case "i": return `*${kids()}*`;
        case "del": case "s": return `~~${kids()}~~`;
        case "a": return `[${kids()}](${element.href})`;
        case "img": return `![${element.alt || ""}](${element.src})`;
        case "br": return "\n";
        case "hr": return "\n\n---\n\n";
        case "p": return `\n\n${kids()}\n\n`;
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return `\n\n${"#".repeat(Number(tag[1]))} ${kids().trim()}\n\n`;
        case "blockquote": return `\n\n${kids().trim().split("\n").map(line => `> ${line}`).join("\n")}\n\n`;
        case "ul": case "ol": {
          const items = [...element.children].filter(child => child.tagName === "LI");
          return `\n\n${items.map((li, i) => `${tag === "ol" ? `${i + 1}.` : "-"} ${walk(li).trim().replace(/\n+/g, "\n   ")}`).join("\n")}\n\n`;
        }
        case "table": {
          const rows = [...element.querySelectorAll("tr")].map(tr => `| ${[...tr.children].map(cell => walk(cell).trim().replace(/\|/g, "\\|").replace(/\n+/g, " ")).join(" | ")} |`);
          if (!rows.length) return "";
          const columns = element.querySelector("tr")?.children.length || 1;
          return `\n\n${[rows[0], `|${" --- |".repeat(columns)}`, ...rows.slice(1)].join("\n")}\n\n`;
        }
        default: return kids();
      }
    };
    return walk(root).replace(/\n{3,}/g, "\n\n").trim();
  }

  function conversationFromDom() {
    const elements = [...document.querySelectorAll("[data-message-author-role]")];
    if (!elements.length) return null;
    const mapping = {};
    let parent = null;
    elements.forEach((element, index) => {
      const role = element.getAttribute("data-message-author-role");
      if (!["user", "assistant"].includes(role)) return;
      const id = element.getAttribute("data-message-id") || `dom-${index}`;
      const body = element.querySelector(".markdown") || element.querySelector(".whitespace-pre-wrap") || element;
      const text = role === "assistant" ? domToMarkdown(body) : body.innerText.trim();
      mapping[id] = { id, parent, children: [], message: { id, author: { role }, content: { content_type: "text", parts: [text] }, metadata: {} } };
      if (parent) mapping[parent].children.push(id);
      parent = id;
    });
    const title = document.title.replace(/^ChatGPT\s*[-–—|]\s*/i, "").trim();
    return parent ? { title, mapping, current_node: parent } : null;
  }

  // ---- Lists for the side panel ----
  globalThis.chatGPTListConversations = async function listForPanel() {
    try {
      const { core } = globalThis.__csi || {};
      if (!core) throw new Error(t("errInternal"));
      if (location.hostname !== "chatgpt.com") throw new Error(t("errWrongSite"));
      const client = core.createClient({ origin: location.origin, token: await sessionToken() });
      const items = await core.listConversations({ client, t, status() {} });
      return { ok: true, items: items.map(item => ({ id: String(item.id), title: String(item.title || ""), update_time: String(item.update_time || ""),
        archived: Boolean(item.archived), project: item.project ? String(item.project) : "", gpt: Boolean(item.gpt) })) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  globalThis.chatGPTListMessages = async function listMessagesForPanel(conversationId) {
    try {
      const { core } = globalThis.__csi || {};
      if (!core) throw new Error(t("errInternal"));
      const page = pageInfo();
      const id = UUID.test(conversationId || "") ? conversationId : page.chat || page.share;
      if (!id) throw new Error(t("errNoChat"));
      const share = !page.chat && id === page.share;
      const client = core.createClient({ origin: location.origin, token: await sessionToken(undefined, share) });
      const ctx = { client, t, status() {} };
      try {
        return { ok: true, ...(await core.listMessages(ctx, id, { share })) };
      } catch (error) {
        const fallback = share && conversationFromDom();
        if (!fallback) throw error;
        const doc = globalThis.__csi.render.buildDocument(fallback, { t, report: { attachments: [] }, includeSteps: false, id });
        return { ok: true, title: doc.title, items: globalThis.__csi.render.messageSummaries(doc) };
      }
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  const toBase64 = bytes => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

  globalThis.chatGPTExporter = function startExport(options) {
    const { core, zip, render } = globalThis.__csi || {};
    if (!core || !zip || !render || !globalThis.__csi.docx || !globalThis.__csi.markdown) return { started: false, error: t("errInternal") };
    if (globalThis.chatGPTExportRunning) return { started: false, error: t("errRunning") };

    const opts = {
      scope: ["all", "choose"].includes(options?.scope) ? options.scope : "current",
      formats: core.FORMATS.filter(format => options?.formats?.includes(format)),
      attachments: options?.attachments !== false,
      textMode: options?.textMode === "2" ? "2" : "1",
      steps: options?.steps === true,
      obsidian: options?.obsidian === true,
      gallery: options?.gallery === true,
      saveMode: options?.saveMode === "folder" ? "folder" : "zip",
      messageIds: Array.isArray(options?.messageIds) ? options.messageIds.filter(id => typeof id === "string" && MESSAGE_ID.test(id)) : null
    };
    const selection = (Array.isArray(options?.selection) ? options.selection : [])
      .filter(item => typeof item?.id === "string" && MESSAGE_ID.test(item.id))
      .map(item => ({ id: item.id, title: String(item.title || ""), update_time: String(item.update_time || "") }));
    const known = options?.known && typeof options.known === "object" ? options.known : null;
    if (!opts.formats.length && !opts.gallery) return { started: false, error: t("errNoFormat") };
    if (location.hostname !== "chatgpt.com") return { started: false, error: t("errWrongSite") };
    const page = pageInfo();
    const explicitId = typeof options?.conversationId === "string" && UUID.test(options.conversationId) ? options.conversationId : null;
    const target = explicitId ? { id: explicitId, share: false } : page.chat ? { id: page.chat, share: false } : page.share ? { id: page.share, share: true } : null;
    if (opts.scope === "current" && !target) return { started: false, error: t("errNoChat") };
    if (opts.scope === "choose" && !selection.length) return { started: false, error: t("errNoSelection") };

    globalThis.chatGPTExportRunning = true;
    if (globalThis.chatGPTExportDownloadUrl) URL.revokeObjectURL(globalThis.chatGPTExportDownloadUrl);
    document.getElementById("chatgpt-export-status")?.remove();

    const controller = new AbortController();
    const notify = (state, message, fraction = null, extra = {}) => {
      try { chrome.runtime.sendMessage({ type: "csi-progress", state, message, fraction, ...extra }).catch(() => {}); } catch {}
    };
    const onPanelMessage = message => { if (message?.type === "csi-cancel") controller.abort(); };
    try { chrome.runtime.onMessage.addListener(onPanelMessage); } catch {}

    const host = document.createElement("div");
    host.id = "chatgpt-export-status";
    host.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:2147483647;max-width:calc(100vw - 40px)";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    // ChatGPT palette: white/black in light theme; #212121 background and a white primary button in dark theme.
    style.textContent = `:host{all:initial}
[hidden]{display:none!important}
section{--bg:#fff;--fg:#0d0d0d;--muted:#6b6b6b;--line:#e5e5e5;--hover:#f4f4f4;--btn:#0d0d0d;--btn-fg:#fff;--focus:#2564c8;
font:14px/1.5 ui-sans-serif,-apple-system,system-ui,"Segoe UI",sans-serif;width:320px;max-width:calc(100vw - 72px);padding:16px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 40px #0003}
header{display:flex;align-items:center;justify-content:space-between;font-weight:600;margin-bottom:10px}
button,a.action{font:inherit;border:0;background:transparent;color:var(--muted);cursor:pointer;padding:0}
a.action{display:block;margin-top:10px;background:var(--btn);color:var(--btn-fg);padding:10px 14px;border-radius:999px;text-decoration:none;text-align:center;font-weight:600}
button.secondary{margin-top:10px;width:100%;padding:9px 14px;border:1px solid var(--line);border-radius:999px;color:var(--fg)}
button.secondary:hover{background:var(--hover)}
button:disabled{opacity:.4;cursor:default}p{margin:0;overflow-wrap:anywhere}
progress{width:100%;height:6px;margin-top:10px;accent-color:var(--fg)}
button:focus-visible,a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
@media(prefers-color-scheme:dark){section{--bg:#212121;--fg:#ececec;--muted:#a0a0a0;--line:#3a3a3a;--hover:#2f2f2f;--btn:#fff;--btn-fg:#0d0d0d;--focus:#6aa5ff;box-shadow:0 8px 40px #0008}}`;
    const panel = document.createElement("section");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", t("extName"));
    const heading = document.createElement("header");
    const title = document.createElement("span");
    title.textContent = t("panelTitle");
    const close = document.createElement("button");
    close.textContent = "✕";
    close.disabled = true;
    close.setAttribute("aria-label", t("panelClose"));
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = t("statusPreparing");
    const progress = document.createElement("progress");
    progress.max = 1;
    const cancel = document.createElement("button");
    cancel.className = "secondary";
    cancel.textContent = t("panelCancel");
    cancel.addEventListener("click", () => { cancel.disabled = true; controller.abort(); });
    let downloadUrl;
    close.addEventListener("click", () => {
      host.remove();
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    });
    heading.append(title, close);
    panel.append(heading, status, progress, cancel);
    shadow.append(style, panel);
    document.body.append(host);

    const update = (message, fraction = null) => {
      status.textContent = message;
      if (typeof fraction === "number") progress.value = Math.min(1, Math.max(0, fraction));
      else progress.removeAttribute("value");
      notify("running", message, fraction);
    };

    function offerFile(blob, filename, markdown) {
      const anchor = document.createElement("a");
      anchor.className = "action";
      anchor.href = downloadUrl = URL.createObjectURL(blob);
      globalThis.chatGPTExportDownloadUrl = downloadUrl;
      anchor.download = filename;
      anchor.textContent = t("panelDownload");
      panel.append(anchor);
      if (markdown !== undefined) {
        const copy = document.createElement("button");
        copy.className = "secondary";
        copy.textContent = t("panelCopy");
        copy.addEventListener("click", async () => {
          try { await navigator.clipboard.writeText(markdown); copy.textContent = t("panelCopied"); }
          catch { copy.textContent = t("panelCopyFailed"); }
        });
        panel.append(copy);
      }
      anchor.click();
    }

    const dateStamp = new Date().toLocaleDateString("sv"); // yerel tarih, YYYY-MM-DD
    const MIME = { md: "text/markdown", html: "text/html", txt: "text/plain", json: "application/json",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    const encoder = new TextEncoder();

    // PDF: the print page with data: URIs goes to the background; the print dialog opens in a new tab.
    async function openPrint(items) {
      update(t("statusPdf"), null);
      const printItems = items.map(({ doc, images }) => ({ doc, images: new Map([...images].map(([path, data]) => {
        const ext = path.split(".").pop().toLowerCase();
        return [path, `data:${IMAGE_MIME[ext] || "application/octet-stream"};base64,${toBase64(data)}`];
      })) }));
      const html = render.toPrintHtml(printItems, { t, lang: chrome.i18n.getUILanguage(), exportedAt: render.formatTime(Date.now() / 1000) });
      const response = await chrome.runtime.sendMessage({ type: "csi-print", html });
      if (!response?.ok) throw new Error(response?.error || t("errPrint"));
    }

    // "Save to a folder": files are sent to the side panel in chunks; the next chunk goes once the previous one is acknowledged.
    async function sendToFolder(entries, manifest) {
      const port = chrome.runtime.connect({ name: "csi-folder" });
      const waiting = [];
      let failure = null;
      port.onMessage.addListener(message => {
        if (message?.type === "error") failure = new Error(message.message || t("errFolder"));
        const next = waiting.shift();
        if (next) failure ? next.reject(failure) : next.resolve();
      });
      port.onDisconnect.addListener(() => {
        failure ||= new Error(t("errFolderPanel"));
        while (waiting.length) waiting.shift().reject(failure);
      });
      const send = message => new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        const timer = setTimeout(() => reject(new Error(t("errFolderPanel"))), 60000);
        waiting.push({ resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } });
        port.postMessage(message);
      });
      try {
        await send({ type: "begin", count: entries.length });
        const CHUNK = 4 * 1024 * 1024;
        for (let i = 0; i < entries.length; i++) {
          controller.signal.throwIfAborted();
          const { name, data } = entries[i];
          update(t("statusFolder", [String(i + 1), String(entries.length)]), i / entries.length);
          for (let offset = 0; offset === 0 || offset < data.length; offset += CHUNK) {
            await send({ type: "chunk", name, data: toBase64(data.subarray(offset, offset + CHUNK)), first: offset === 0, last: offset + CHUNK >= data.length });
          }
        }
        await send({ type: "end", manifest });
      } finally {
        port.disconnect();
      }
    }

    // Reports finished chats to the side panel (for incremental backups).
    const finish = (message, exported = []) => {
      update(message, 1);
      notify("done", message, 1, { exported });
    };

    async function run() {
      const share = opts.scope === "current" && target.share;
      const client = core.createClient({ origin: location.origin, token: await sessionToken(controller.signal, share), signal: controller.signal });
      const ctx = { client, t, signal: controller.signal, lang: chrome.i18n.getUILanguage(), status: update };
      const readme = t("readmeText");
      const zipWithProgress = entries => zip.createZip(entries, { signal: controller.signal, onProgress: (done, total) => update(t("statusZipping"), done / total) });
      const downloadFormats = opts.formats.filter(format => format !== "pdf");
      const folder = opts.saveMode === "folder";

      // In folder mode a single chat also uses the archive layout (chats/<folder>/…) so it merges with later backups.
      if (opts.scope === "current" && !folder) {
        update(t("statusFetching"));
        let conversation;
        if (share) {
          try { conversation = await core.loadConversation(ctx, target.id, { share: true }); }
          catch (error) {
            if (controller.signal.aborted) throw error;
            conversation = conversationFromDom();
            if (!conversation) throw error;
          }
        }
        const result = await core.exportConversation({ id: target.id, ctx, opts: { ...opts, share }, conversation });
        const base = `${core.clean(result.title, "chat")}-${target.id.slice(0, 8)}`;
        const galleryHtml = opts.gallery
          ? render.toGalleryHtml(result.gallery.map(item => ({ ...item, href: result.names.html || result.names.md })), { t, lang: ctx.lang, multi: false }) : null;
        if (opts.formats.includes("pdf")) await openPrint([result.print]);
        const exported = [{ id: target.id, update_time: result.conversation.update_time ? new Date(result.conversation.update_time * 1000).toISOString() : "" }];
        if (!downloadFormats.length && !opts.gallery) { finish(t("statusDonePdf"), exported); return; }
        if (downloadFormats.length === 1 && !result.needsReport && !opts.gallery) {
          const format = downloadFormats[0];
          const body = format === "docx" ? result.docx : result.text[format];
          const name = format === "md" && opts.obsidian ? result.names.md : `${base}.${format}`;
          offerFile(new Blob([body], { type: format === "docx" ? MIME.docx : `${MIME[format]};charset=utf-8` }), name, result.text.md);
          finish(t("statusDoneFile"), exported);
          return;
        }
        const entries = [...result.entries];
        if (galleryHtml) entries.push({ name: "gallery.html", data: encoder.encode(galleryHtml) });
        if (result.needsReport) entries.push({ name: "download-report.json", data: encoder.encode(JSON.stringify(result.report, null, 2)) });
        entries.push({ name: "README.txt", data: encoder.encode(readme) });
        update(t("statusZipping"), 0);
        offerFile(await zipWithProgress(entries), `${base}.zip`, result.text.md);
        const failed = result.report.attachments.filter(item => item.status === "failed").length;
        const ok = result.report.attachments.filter(item => item.status === "downloaded").length;
        finish(t("statusDone", [String(ok), String(failed), String(result.report.unresolved_asset_pointers.length)]), exported);
        return;
      }

      // All chats / chats picked in the side panel / the open chat saved to a folder.
      // "All" skips attachments (memory and rate limits); with the gallery on, only images are downloaded.
      let conversations;
      if (opts.scope === "choose") conversations = selection;
      else if (opts.scope === "current") conversations = [{ id: target.id, title: document.title.replace(/^ChatGPT\s*[-–—|]\s*/i, ""), update_time: "", share: target.share }];
      else {
        conversations = await core.listConversations(ctx);
        if (!conversations.length) throw new Error(t("errNoConversations"));
      }
      let skipped = 0;
      if (known) {
        const before = conversations.length;
        conversations = conversations.filter(item => !item.update_time || known[item.id] !== item.update_time);
        skipped = before - conversations.length;
      }
      const bulkOpts = { ...opts, formats: downloadFormats, attachments: opts.scope === "all" ? false : opts.attachments, sidebar: "multi" };
      const entries = [], index = [], failures = [], printItems = [], gallery = [], exported = [];
      for (let i = 0; i < conversations.length; i++) {
        const item = conversations[i];
        const label = item.title || t("renderUntitled");
        update(t("statusBulk", [String(i + 1), String(conversations.length), label]), i / conversations.length);
        try {
          let conversation;
          if (item.share) {
            try { conversation = await core.loadConversation(ctx, item.id, { share: true }); }
            catch (error) { if (controller.signal.aborted) throw error; conversation = conversationFromDom(); if (!conversation) throw error; }
          }
          const loadedTitle = conversation?.title || label;
          const updated = conversation?.update_time ? new Date(conversation.update_time * 1000).toLocaleDateString("sv") : "";
          const day = item.update_time ? String(item.update_time).slice(0, 10) : updated || dateStamp;
          const folderName = `${day}-${core.clean(loadedTitle, "chat").slice(0, 50)}-${item.id.slice(0, 8)}`;
          const result = await core.exportConversation({ id: item.id, ctx, opts: { ...bulkOpts, share: Boolean(item.share) }, prefix: `chats/${folderName}/`, conversation });
          entries.push(...result.entries);
          if (result.print) printItems.push(result.print);
          const row = { id: item.id, title: result.title, day: day === dateStamp && !item.update_time ? render.formatTime(result.conversation.update_time).slice(0, 10) || day : day, folder: folderName, md: result.names.md || "", html: result.names.html || "" };
          index.push(row);
          const href = row.html ? `chats/${folderName}/${row.html}` : row.md ? `chats/${folderName}/${row.md}` : "";
          gallery.push(...result.gallery.map(image => ({ ...image, id: item.id, href, day: row.day })));
          exported.push({ id: item.id, update_time: item.update_time || (result.conversation.update_time ? new Date(result.conversation.update_time * 1000).toISOString() : "") });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          failures.push({ id: item.id, title: item.title, error: error.message });
        }
        await core.sleepFor(250, controller.signal);
      }
      if (opts.formats.includes("pdf") && printItems.length) await openPrint(printItems);
      const doneMessage = () => t("statusDoneBulk", [String(index.length), String(failures.length)]) + (skipped ? ` ${t("statusSkippedUnchanged", [String(skipped)])}` : "");
      if (!downloadFormats.length && !opts.gallery) { finish(index.length ? t("statusDonePdf") : doneMessage(), exported); return; }

      if (folder) {
        // Index files (index, sidebar, gallery) are merged with the existing archive and written by the side panel.
        await sendToFolder(entries, { rows: index, gallery, formats: downloadFormats, failures, lang: ctx.lang });
        finish(doneMessage(), exported);
        return;
      }
      if (!index.length) { finish(doneMessage(), exported); return; }
      const linkFormat = downloadFormats.find(format => format === "md" || format === "html") || downloadFormats[0];
      const link = row => ["chats", row.folder, linkFormat === "md" ? row.md : linkFormat === "html" ? row.html : `conversation.${linkFormat}`].map(encodeURIComponent).join("/");
      entries.push({ name: "index.md", data: encoder.encode(render.toIndexMarkdown(index, { t, link })) });
      if (downloadFormats.includes("html")) {
        entries.push({ name: "index.html", data: encoder.encode(render.toHtmlIndex(index.length, { t, lang: ctx.lang })) });
        entries.push({ name: "assets/chats.js", data: encoder.encode(render.chatsData(index.map(row => ({ t: row.title, h: `chats/${row.folder}/conversation.html`, d: row.day })))) });
      }
      if (opts.gallery) entries.push({ name: "gallery.html", data: encoder.encode(render.toGalleryHtml(gallery, { t, lang: ctx.lang, multi: downloadFormats.includes("html") })) });
      entries.push({ name: "download-report.json", data: encoder.encode(JSON.stringify({ exported_at: new Date().toISOString(), options: bulkOpts, total: conversations.length + skipped, exported: index.length, unchanged_skipped: skipped, failures }, null, 2)) });
      entries.push({ name: "README.txt", data: encoder.encode(readme) });
      update(t("statusZipping"), 0);
      offerFile(await zipWithProgress(entries), `chatgpt-chats-${dateStamp}.zip`);
      finish(doneMessage(), exported);
    }

    void run().catch(error => {
      const aborted = controller.signal.aborted;
      const message = aborted ? t("statusCancelled") : `${t("statusFailed")}: ${error.message}`;
      update(message, 0);
      notify(aborted ? "cancelled" : "error", message, 0);
      status.style.color = aborted ? "" : "#d44";
    }).finally(() => {
      globalThis.chatGPTExportRunning = false;
      close.disabled = false;
      cancel.remove();
      try { chrome.runtime.onMessage.removeListener(onPanelMessage); } catch {}
    });
    return { started: true };
  };
})();
