// DOM-independent export core: API client, attachment scanning/downloading, and output file generation.
(() => {
  const ns = globalThis.__csi ||= {};
  const encoder = new TextEncoder();
  const FORMATS = ["md", "html", "txt", "json", "docx", "pdf"];

  const clean = (name, fallback = "file") => String(name || fallback)
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, "_").replace(/^\.+/, "_").replace(/[. ]+$/, "").slice(0, 150) || fallback;

  const sleepFor = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });

  // The session token is only sent to the same origin; no cookies or token go to external file servers.
  function createClient({ fetchImpl = globalThis.fetch.bind(globalThis), origin, token, signal, sleep = sleepFor }) {
    async function request(url, init, timeout, retries = 3) {
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        let response;
        try {
          response = await fetchImpl(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)].filter(Boolean)) });
        } catch (error) {
          if (signal?.aborted || attempt >= retries) throw error;
          await sleep(1000 * 2 ** attempt, signal);
          continue;
        }
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          const retryAfter = Number(response.headers.get("retry-after"));
          await sleep(Math.min(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt, 20000), signal);
          continue;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response;
      }
    }
    async function api(path) {
      const url = new URL(path, origin);
      if (url.origin !== origin) throw new Error("API request must stay on the same origin");
      return request(url, { credentials: "same-origin", headers: token ? { Authorization: `Bearer ${token}` } : {} }, 60000);
    }
    async function external(href) {
      const url = new URL(href, origin);
      if (url.protocol !== "https:") throw new Error("Download URL is not HTTPS");
      return url.origin === origin ? api(url.href) : request(url, { credentials: "omit" }, 120000);
    }
    return { api, external };
  }

  // Scans known attachment shapes; update this scanner if new schemas appear.
  function scanAttachments(conversation) {
    const files = new Map();
    const unresolved = new Set();
    function addFile(fileId, name, messageId, isImage = false) {
      if (!/^(?:file-|file_)[a-z0-9_-]+$/i.test(fileId)) return;
      if (!files.has(fileId)) files.set(fileId, { kind: "file", id: fileId, name: name || fileId, message_ids: [] });
      if (isImage) files.get(fileId).isImage = true;
      else if (name && files.get(fileId).name === fileId) files.get(fileId).name = name;
      if (messageId && !files.get(fileId).message_ids.includes(messageId)) files.get(fileId).message_ids.push(messageId);
    }
    function scan(value, messageId, key = "") {
      if (typeof value === "string") {
        for (const match of value.matchAll(/(?:file-service|sediment):\/\/((?:file-|file_)[a-z0-9_-]+)/gi)) addFile(match[1], null, messageId, key === "asset_pointer");
        if (/^(file_id|file_ids|attachment_id|attachment_ids)$/.test(key)) addFile(value, null, messageId);
        if (key === "asset_pointer" && !/^(?:file-service|sediment):\/\/(?:file-|file_)/i.test(value)) unresolved.add(value);
        for (const match of value.matchAll(/sandbox:(\/[^\s)\]<>"`]+)/g)) {
          let path = match[1];
          try { path = decodeURIComponent(path); } catch {}
          const fileKey = `${messageId}:${path}`;
          if (!files.has(fileKey)) files.set(fileKey, { kind: "sandbox", message_id: messageId, message_ids: [messageId], path, name: path.split("/").pop() });
        }
      } else if (Array.isArray(value)) {
        for (const item of value) scan(item, messageId, key);
      } else if (value && typeof value === "object") {
        const fileId = value.file_id || value.attachment_id || (key === "attachments" ? value.id : null);
        if (typeof fileId === "string") addFile(fileId, value.name || value.filename || value.file_name, messageId);
        for (const [childKey, item] of Object.entries(value)) scan(item, messageId, childKey);
      }
    }
    for (const node of Object.values(conversation.mapping)) {
      if (node.message) scan(node.message, node.message.id || node.id);
    }
    return { files, unresolved };
  }

  const EXTENSIONS = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "application/pdf": ".pdf",
    "audio/mpeg": ".mp3", "audio/wav": ".wav", "video/mp4": ".mp4", "text/plain": ".txt", "text/markdown": ".md" };

  async function pool(items, limit, worker, signal) {
    let next = 0;
    const run = async () => {
      while (next < items.length) {
        signal?.throwIfAborted();
        const index = next++;
        await worker(items[index], index);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  }

  async function downloadAttachment(file, conversationId, ctx) {
    const path = file.kind === "file"
      ? `/backend-api/files/${encodeURIComponent(file.id)}/download`
      : `/backend-api/conversation/${conversationId}/interpreter/download?${new URLSearchParams({ message_id: file.message_id, sandbox_path: file.path })}`;
    let response = await ctx.client.api(path);
    let returnedName;
    if (response.headers.get("content-type")?.includes("json")) {
      const info = await response.json();
      if (!info.download_url) throw new Error(ctx.t("errNoDownloadUrl"));
      returnedName = info.file_name || info.filename;
      response = await ctx.client.external(info.download_url);
    }
    const type = response.headers.get("content-type")?.split(";")[0];
    if (type === "text/html") throw new Error(ctx.t("errHtmlInstead"));
    let name = file.name;
    if (name === file.id && returnedName) name = returnedName;
    if (name === file.id && EXTENSIONS[type]) name += EXTENSIONS[type];
    return { name, data: new Uint8Array(await response.arrayBuffer()) };
  }

  function decodeText(data) {
    const encoding = data[0] === 0xff && data[1] === 0xfe ? "utf-16le" : data[0] === 0xfe && data[1] === 0xff ? "utf-16be" : "utf-8";
    return new TextDecoder(encoding, { fatal: true }).decode(data);
  }

  // Regular chats are read from /conversation, shared links from the /share endpoint.
  // A share response may be a flat message list (linear_conversation); it is turned into a chain.
  async function loadConversation(ctx, id, { share = false } = {}) {
    const data = await (await ctx.client.api(`/backend-api/${share ? "share" : "conversation"}/${encodeURIComponent(id)}`)).json();
    if (data?.mapping && typeof data.mapping === "object") return data;
    if (Array.isArray(data?.linear_conversation)) {
      const mapping = {};
      let parent = null;
      for (const node of data.linear_conversation) {
        const nodeId = node.id || node.message?.id;
        if (!nodeId) continue;
        mapping[nodeId] = { id: nodeId, parent, children: [], message: node.message || null };
        if (parent) mapping[parent].children.push(nodeId);
        parent = nodeId;
      }
      return { ...data, mapping, current_node: data.current_node && mapping[data.current_node] ? data.current_node : parent };
    }
    throw new Error(ctx.t("errFormatChanged"));
  }

  const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;

  // opts: { formats: ["md","html","txt","json","docx","pdf"], attachments, textMode: "1"|"2", steps, sidebar?: "multi",
  //         messageIds?: [...], gallery?, obsidian?, share? }
  async function exportConversation({ id, ctx, opts, prefix = "", conversation }) {
    const { render } = ns;
    const { t, signal } = ctx;
    conversation ||= await loadConversation(ctx, id, { share: opts.share });
    if (!conversation.mapping || typeof conversation.mapping !== "object") throw new Error(t("errFormatChanged"));
    const onlyIds = Array.isArray(opts.messageIds) && opts.messageIds.length ? new Set(opts.messageIds) : null;
    const scanned = scanAttachments(conversation);
    const unresolved = scanned.unresolved;
    let list = [...scanned.files.values()];
    if (onlyIds) list = list.filter(file => file.message_ids.some(messageId => onlyIds.has(messageId)));
    const date = conversation.update_time ? new Date(conversation.update_time * 1000) : new Date();
    const entries = [];
    const put = (name, value) => entries.push({ name: prefix + name, data: typeof value === "string" ? encoder.encode(value) : value, date });
    const report = {
      conversation_id: id, exported_at: new Date().toISOString(),
      options: { formats: opts.formats, attachments: opts.attachments, markdown_text_attachments: opts.textMode === "2" ? "full_contents" : "links_only",
        include_steps: opts.steps, selected_messages: onlyIds ? onlyIds.size : undefined },
      attachments: [], unresolved_asset_pointers: [...unresolved]
    };
    const inlineText = new Map();
    const binary = new Map(); // archive path → data (images for Word/PDF/gallery)
    // With the gallery on but attachments off, only images are downloaded.
    const wanted = file => opts.attachments || (opts.gallery && file.isImage);
    const download = list.filter(wanted);
    const results = new Map(list.map(file => [file, { ...file, status: "skipped" }]));
    let finished = 0;
    await pool(download, 3, async file => {
      const index = list.indexOf(file);
      ctx.status(t("statusAttachment", [String(finished + 1), String(download.length), file.name]), download.length ? finished / download.length : 0);
      try {
        const { name, data } = await downloadAttachment(file, id, ctx);
        const archivePath = `attachments/${String(index + 1).padStart(3, "0")}-${clean(name)}`;
        entries.push({ name: prefix + archivePath, data, date });
        const result = { ...file, isImage: file.isImage || IMAGE_NAME.test(name), status: "downloaded", archive_path: archivePath, bytes: data.length };
        if (result.isImage) binary.set(archivePath, data);
        if (opts.textMode === "2" && /\.(txt|md)$/i.test(name)) {
          try { inlineText.set(archivePath, decodeText(data)); } catch { result.text_decoding_error = true; }
        }
        results.set(file, result);
      } catch (error) {
        if (signal?.aborted) throw error;
        results.set(file, { ...file, status: "failed", error: error.message });
      }
      finished++;
    }, signal);
    report.attachments = list.map(file => results.get(file));

    const title = conversation.title || t("renderUntitled");
    const result = { id, title, conversation, entries, report, text: {}, names: {} };
    const doc = render.buildDocument(conversation, { t, report, inlineText, includeSteps: opts.steps, onlyIds, id });
    result.doc = doc;
    const exportedAt = render.formatTime(Date.now() / 1000);
    // In bulk mode every page uses the shared sidebar (assets/chats.js); a single chat lists only itself.
    const depth = prefix.split("/").filter(Boolean).length;
    const layout = opts.sidebar === "multi" ? { mode: "multi", root: "../".repeat(depth), current: `${prefix}conversation.html` } : { mode: "single" };
    const renderCtx = { t, exportedAt, lang: ctx.lang, layout, obsidian: opts.obsidian };
    const outputs = {
      json: () => JSON.stringify(conversation, null, 2),
      md: () => render.toMarkdown(doc, renderCtx),
      html: () => render.toHtml(doc, renderCtx),
      txt: () => render.toText(doc, renderCtx)
    };
    for (const format of ["md", "html", "txt", "json"]) {
      if (!opts.formats.includes(format)) continue;
      // In Obsidian mode the note is named after the chat title.
      const name = format === "md" && opts.obsidian ? `${clean(title, "chat")}.md` : `conversation.${format}`;
      result.text[format] = outputs[format]();
      result.names[format] = name;
      put(name, result.text[format]);
    }
    if (opts.formats.includes("docx")) {
      ctx.status(t("statusWord"), null);
      result.names.docx = "conversation.docx";
      result.docx = await ns.docx.build([{ doc, images: binary }], { t });
      put("conversation.docx", result.docx);
    }
    if (opts.formats.includes("pdf")) result.print = { doc, images: binary };
    result.gallery = report.attachments.filter(file => file.status === "downloaded" && file.isImage)
      .map(file => ({ src: prefix + file.archive_path, conversation: title, day: render.formatTime(conversation.update_time).slice(0, 10) }));
    result.needsReport = unresolved.size > 0 || report.attachments.some(file => file.status !== "skipped");
    return result;
  }

  // For message selection in the side panel: a short list of the open chat's visible messages.
  async function listMessages(ctx, id, { share = false } = {}) {
    const conversation = await loadConversation(ctx, id, { share });
    const doc = ns.render.buildDocument(conversation, { t: ctx.t, report: { attachments: [] }, includeSteps: false, id });
    return { title: doc.title, items: ns.render.messageSummaries(doc) };
  }

  const isoDate = value => typeof value === "number" ? new Date(value * 1000).toISOString() : String(value || "");

  // Projects are read from the unofficial "snorlax" endpoint; skipped silently on failure.
  async function listProjects(ctx) {
    const projects = [];
    try {
      let cursor = null;
      for (let page = 0; page < 20; page++) {
        const params = new URLSearchParams({ owned_only: "true", conversations_per_gizmo: "0" });
        if (cursor) params.set("cursor", cursor);
        const data = await (await ctx.client.api(`/backend-api/gizmos/snorlax/sidebar?${params}`)).json();
        for (const entry of data.items || []) {
          const gizmo = entry?.gizmo?.gizmo || entry?.gizmo;
          if (gizmo?.id) projects.push({ id: gizmo.id, name: String(gizmo.display?.name || gizmo.name || gizmo.id) });
        }
        cursor = data.cursor;
        if (!cursor) break;
      }
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
    }
    return projects;
  }

  async function projectConversations(ctx, project) {
    const items = [];
    try {
      let cursor = "0";
      for (let page = 0; page < 50 && cursor !== null && cursor !== undefined; page++) {
        const data = await (await ctx.client.api(`/backend-api/gizmos/${encodeURIComponent(project.id)}/conversations?cursor=${encodeURIComponent(cursor)}`)).json();
        items.push(...(data.items || []));
        cursor = data.cursor ?? null;
      }
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
    }
    return items;
  }

  // Returns: [{ id, title, update_time (ISO), archived, project?, gpt? }]
  async function listConversations(ctx, { includeArchived = true, includeProjects = true } = {}) {
    const found = new Map();
    const add = (item, extra = {}) => {
      if (!item?.id) return;
      const previous = found.get(item.id) || {};
      found.set(item.id, { ...previous, ...item, update_time: isoDate(item.update_time || previous.update_time), ...extra });
    };
    for (const archived of includeArchived ? [false, true] : [false]) {
      for (let offset = 0, pages = 0; pages < 100; offset += 100, pages++) {
        const params = new URLSearchParams({ offset: String(offset), limit: "100", order: "updated" });
        if (archived) params.set("is_archived", "true");
        const page = await (await ctx.client.api(`/backend-api/conversations?${params}`)).json();
        if (!Array.isArray(page.items)) throw new Error(ctx.t("errFormatChanged"));
        for (const item of page.items) add(item, { archived });
        ctx.status(ctx.t("statusListing", [String(found.size)]), null);
        if (page.items.length < 100 || (typeof page.total === "number" && offset + page.items.length >= page.total)) break;
      }
    }
    if (includeProjects) {
      for (const project of await listProjects(ctx)) {
        for (const item of await projectConversations(ctx, project)) add(item, { project: project.name, archived: found.get(item.id)?.archived || false });
        ctx.status(ctx.t("statusListing", [String(found.size)]), null);
      }
    }
    return [...found.values()].map(item => ({
      ...item,
      archived: Boolean(item.archived),
      gpt: Boolean(item.gizmo_id) && !String(item.gizmo_id).startsWith("g-p-") && !item.project
    })).sort((a, b) => String(b.update_time).localeCompare(String(a.update_time)));
  }

  const api = { clean, createClient, scanAttachments, loadConversation, exportConversation, listMessages, listConversations, FORMATS, pool, sleepFor };
  ns.core = api;
  if (typeof module !== "undefined") module.exports = api;
})();
