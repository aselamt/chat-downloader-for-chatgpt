// Turns chat data into a shared block model and produces Markdown, HTML, TXT, print (PDF) and gallery output.
// It does not touch the DOM, so it can be tested in Node. Load it after markdown.js.
(() => {
  const ns = globalThis.__csi ||= {};
  const FILE_ID = /(?:file-service|sediment):\/\/((?:file-|file_)[a-z0-9_-]+)/i;
  const FN_TOKEN = /\u0002F(\d+)\u0002/g;

  // Removes the private citation/entity markers ChatGPT embeds in text.
  // keepFootnotes: keeps footnote markers (\u0002F<n>\u0002).
  function cleanText(text, keepFootnotes = false) {
    return String(text ?? "")
      .replace(keepFootnotes ? /[\u0000\u0001]/g : /[\u0000-\u0002]/g, "")
      .replace(/\ue200entity\ue202\[\s*"(?:[^"\\]|\\.)*"\s*,\s*("(?:[^"\\]|\\.)*")[^\ue201]*\ue201/g, (_, name) => {
        try { return JSON.parse(name); } catch { return ""; }
      })
      .replace(/\ue200[^\ue201]*\ue201/g, "")
      .replace(/【[^】]*†[^】]*】/g, "")
      .replace(/[\ue200-\ue2ff]/g, "");
  }

  const pad = n => String(n).padStart(2, "0");
  function formatTime(seconds) {
    if (!seconds) return "";
    const d = new Date(seconds * 1000);
    if (Number.isNaN(d.getTime())) return "";
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const isoTime = seconds => { const d = new Date(seconds * 1000); return seconds && !Number.isNaN(d.getTime()) ? d.toISOString() : ""; };
  const isUrl = url => typeof url === "string" && /^https?:\/\//i.test(url);

  // Turns citation markers into footnote markers numbered across the document; remaining links become "Sources".
  function referencesFor(message, footnotes) {
    const used = new Map();
    const number = item => {
      if (!footnotes.has(item.url)) footnotes.set(item.url, { n: footnotes.size + 1, url: item.url, title: String(item.title || item.url) });
      const note = footnotes.get(item.url);
      used.set(note.n, note);
      return note.n;
    };
    const markers = [];
    for (const ref of message.metadata?.content_references || []) {
      if (typeof ref?.matched_text !== "string" || !ref.matched_text.trim()) continue;
      const items = (Array.isArray(ref.items) && ref.items.length ? ref.items : [ref]).filter(item => isUrl(item?.url));
      if (items.length) markers.push({ marker: ref.matched_text, items });
    }
    const apply = text => {
      for (const { marker, items } of markers) {
        if (!text.includes(marker)) continue;
        text = text.split(marker).join([...new Set(items.map(number))].map(n => `\u0002F${n}\u0002`).join(""));
      }
      return text;
    };
    const others = () => {
      const found = new Map();
      const add = (url, title) => { if (isUrl(url) && !footnotes.has(url) && !found.has(url)) found.set(url, String(title || url)); };
      for (const ref of message.metadata?.content_references || []) {
        add(ref.url, ref.title);
        for (const item of ref.items || []) add(item.url, item.title);
      }
      for (const group of message.metadata?.search_result_groups || []) for (const entry of group.entries || []) add(entry.url, entry.title);
      return [...found].map(([url, title]) => ({ url, title }));
    };
    return { apply, used, others };
  }

  // Splits a message's content into {type, ...} blocks.
  function messageBlocks(message, role, isStep, footnotes, imagesOnly = false) {
    const content = message.content || {};
    const blocks = [];
    const refs = role === "assistant" && !isStep ? referencesFor(message, footnotes) : null;
    const text = value => {
      if (imagesOnly) return;
      const raw = String(value ?? "").replace(/[\u0000-\u0002]/g, "");
      const cleaned = cleanText(refs ? refs.apply(raw) : raw, true);
      if (cleaned.replace(FN_TOKEN, "").trim()) blocks.push({ type: "text", text: cleaned });
    };
    switch (content.content_type) {
      case "text":
      case "multimodal_text":
        for (const part of content.parts || []) {
          if (typeof part === "string") text(part);
          else if (part?.content_type === "image_asset_pointer") {
            blocks.push({ type: "image", fileId: String(part.asset_pointer || "").match(FILE_ID)?.[1] || null, pointer: part.asset_pointer });
          } else if (typeof part?.text === "string") text(part.text);
          else if (part && typeof part === "object" && !imagesOnly) blocks.push({ type: "code", lang: "json", text: JSON.stringify(part, null, 2) });
        }
        break;
      case "code":
        if (content.text) blocks.push({ type: "code", lang: content.language && content.language !== "unknown" ? content.language : "", text: content.text });
        break;
      case "execution_output":
        if (content.text) blocks.push({ type: "code", lang: "", text: content.text });
        break;
      case "thoughts":
        for (const thought of content.thoughts || []) {
          const body = [thought.summary, thought.content].filter(Boolean).join("\n\n");
          if (body.trim()) blocks.push({ type: "thought", text: cleanText(body) });
        }
        break;
      case "reasoning_recap":
        if (content.content) blocks.push({ type: "thought", text: cleanText(content.content) });
        break;
      default:
        if (typeof content.text === "string") text(content.text);
        else if (Array.isArray(content.parts)) content.parts.forEach(part => typeof part === "string" && text(part));
    }
    if (refs) {
      if (refs.used.size) blocks.push({ type: "footnotes", items: [...refs.used.values()].sort((a, b) => a.n - b.n) });
      const sources = refs.others();
      if (sources.length) blocks.push({ type: "sources", items: sources });
    }
    return blocks;
  }

  // Extracts document content from Canvas (canmore) tool calls and applies updates to the latest document.
  function canvasBlock(message, canvases) {
    let payload;
    try { payload = JSON.parse(message.content?.text || ""); } catch { return null; }
    if (message.recipient === "canmore.create_textdoc" && typeof payload?.content === "string") {
      canvases.last = { name: String(payload.name || "Canvas"), kind: String(payload.type || "document"), content: payload.content };
      return { type: "canvas", ...canvases.last, updated: false };
    }
    if (message.recipient === "canmore.update_textdoc" && canvases.last && Array.isArray(payload?.updates)) {
      for (const update of payload.updates) {
        try {
          const replacement = String(update.replacement ?? "");
          canvases.last.content = canvases.last.content.replace(new RegExp(String(update.pattern), update.multiple ? "gs" : "s"), () => replacement);
        } catch {}
      }
      return { type: "canvas", ...canvases.last, updated: true };
    }
    return null;
  }

  function stepLabel(message, t) {
    if (["thoughts", "reasoning_recap"].includes(message.content?.content_type)) return t("renderThinking");
    return message.author?.name || (message.recipient && message.recipient !== "all" ? message.recipient : t("renderStep"));
  }

  // Walks the selected branch (current_node → root) and orders the visible messages.
  // options.onlyIds: keeps only these messages (and the tool steps right before them).
  function buildDocument(conversation, { t, report, inlineText, includeSteps, onlyIds, id }) {
    const branch = [];
    const visited = new Set();
    let current = conversation.current_node;
    while (current && conversation.mapping[current] && !visited.has(current)) {
      visited.add(current);
      const node = conversation.mapping[current];
      if (node.message) branch.unshift(node.message);
      current = node.parent;
    }
    const filesById = new Map(report.attachments.filter(f => f.kind === "file").map(f => [f.id, f]));
    const shown = new Set();
    const footnotes = new Map();
    const canvases = {};
    let messages = [];

    function fileItem(file) {
      const label = file.archive_path?.split("/").pop() || file.name;
      if (file.status === "skipped") return { label, skipped: true };
      if (file.status !== "downloaded") return { label, error: file.error || "" };
      const item = { label, href: file.archive_path };
      if (file.text_decoding_error) item.textError = t("renderTextDecodeError");
      else if (inlineText?.has(file.archive_path)) item.text = inlineText.get(file.archive_path);
      return item;
    }

    for (const message of branch) {
      const author = message.author?.role;
      if (message.metadata?.is_visually_hidden_from_conversation) continue;
      if (!["user", "assistant", "tool"].includes(author)) continue;
      const type = message.content?.content_type;
      const recipient = message.recipient || "all";
      const time = formatTime(message.create_time);
      const model = author === "assistant" ? message.metadata?.model_slug || "" : "";
      if (author === "assistant" && recipient.startsWith("canmore.")) {
        const block = canvasBlock(message, canvases);
        if (block) messages.push({ id: message.id, role: "assistant", label: t("renderAssistant"), time, model, blocks: [block] });
        if (block || !includeSteps) continue;
      }
      // Output of image generation tools (DALL·E etc.) is shown as part of the chat.
      const toolImages = author === "tool" && type === "multimodal_text" && (message.content.parts || []).some(part => part?.content_type === "image_asset_pointer");
      const isStep = !toolImages && (author === "tool" ||
        (author === "assistant" && (type === "code" || recipient !== "all" || ["thoughts", "reasoning_recap"].includes(type))));
      if (isStep && !includeSteps) continue;
      const role = toolImages ? "assistant" : author;
      const blocks = messageBlocks(message, role, isStep, footnotes, toolImages);
      for (const block of blocks) {
        const file = block.type === "image" && block.fileId ? filesById.get(block.fileId) : null;
        if (file?.status === "downloaded") block.src = file.archive_path;
        if (file && file.status !== "failed") shown.add(file); // a failed image is listed under "Attachments" with its error
      }
      for (const file of report.attachments) {
        if (file.kind !== "sandbox" || file.status !== "downloaded" || !file.message_ids.includes(message.id)) continue;
        for (const block of blocks) {
          if (block.type !== "text") continue;
          block.text = block.text.split(`sandbox:${file.path}`).join(hrefFor(file.archive_path))
            .split(`sandbox:${encodeURI(file.path)}`).join(hrefFor(file.archive_path));
        }
      }
      const attached = report.attachments.filter(f => f.message_ids?.includes(message.id) && !shown.has(f));
      attached.forEach(f => shown.add(f));
      if (attached.length) blocks.push({ type: "files", items: attached.map(fileItem) });
      if (!blocks.length) continue;
      messages.push({
        id: message.id,
        role: isStep ? "step" : role,
        label: isStep ? stepLabel(message, t) : (role === "user" ? t("renderUser") : t("renderAssistant")),
        time,
        model: isStep ? "" : model,
        blocks
      });
    }
    if (onlyIds) {
      let keepNext = false;
      messages = messages.reverse().filter(message => {
        if (message.role === "step") return keepNext;
        keepNext = onlyIds.has(message.id);
        return keepNext;
      }).reverse();
    }
    const rest = onlyIds ? [] : report.attachments.filter(f => !shown.has(f));
    const lastModel = [...messages].reverse().find(m => m.model)?.model || "";
    const conversationId = id || conversation.conversation_id || conversation.id || "";
    return {
      id: conversationId,
      url: conversationId && /^[\w-]+$/.test(conversationId) ? `https://chatgpt.com/c/${conversationId}` : "",
      title: conversation.title || t("renderUntitled"),
      created: formatTime(conversation.create_time),
      updated: formatTime(conversation.update_time),
      createdIso: isoTime(conversation.create_time),
      updatedIso: isoTime(conversation.update_time),
      model: lastModel,
      messages,
      leftover: rest.length ? rest.map(fileItem) : []
    };
  }

  // Short preview list for message selection in the side panel.
  function messageSummaries(doc) {
    return doc.messages.filter(m => m.role !== "step").map(m => {
      const block = m.blocks.find(b => b.type === "text" || b.type === "canvas" || b.type === "code");
      const raw = block ? (block.text ?? block.content ?? "") : "";
      const preview = raw.replace(FN_TOKEN, "").replace(/[#*`>_~\[\]()!|-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
      const images = m.blocks.filter(b => b.type === "image").length;
      return { id: m.id, role: m.role, preview, images, time: m.time };
    });
  }

  const fenceFor = text => "`".repeat(Math.max(3, ...(String(text).match(/`+/g) || []).map(run => run.length + 1)));
  const escapeLabel = text => String(text).replace(/([\\\[\]])/g, "\\$1");
  const hrefFor = path => path.split("/")
    .map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
  const codeBlock = (lang, text) => {
    const fence = fenceFor(text);
    return `${fence}${lang || ""}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
  };
  const canvasLang = kind => (String(kind).match(/^code\/(.+)$/) || [])[1] || "";

  function fileMarkdown(item, t) {
    if (item.skipped) return `- ${escapeLabel(item.label)} — ${t("renderSkipped")}`;
    if (!item.href) return `- ${escapeLabel(item.label)} — ${t("renderFailed")}: ${item.error}`;
    const link = `- [${escapeLabel(item.label)}](${hrefFor(item.href)})`;
    if (item.textError) return `${link}\n\n${item.textError}`;
    if (item.text === undefined) return link;
    return `${link}\n\n**${t("renderAttachmentContent")}:**\n\n${codeBlock("text", item.text)}\n`;
  }

  const yaml = value => JSON.stringify(String(value ?? ""));

  // options.obsidian: adds YAML frontmatter. Math is always converted to $…$ / $$…$$.
  function toMarkdown(doc, { t, exportedAt, obsidian = false }) {
    const { dollarMath } = ns.markdown;
    const prose = text => dollarMath(text).replace(FN_TOKEN, "[^$1]");
    const out = [];
    if (obsidian) {
      out.push("---", `title: ${yaml(doc.title)}`);
      if (doc.url) out.push(`source: ${yaml(doc.url)}`, `conversation_id: ${yaml(doc.id)}`);
      if (doc.createdIso) out.push(`created: ${doc.createdIso}`);
      if (doc.updatedIso) out.push(`updated: ${doc.updatedIso}`);
      if (doc.model) out.push(`model: ${yaml(doc.model)}`);
      out.push(`messages: ${doc.messages.filter(m => m.role !== "step").length}`, "tags:", "  - chatgpt", "---", "");
    }
    out.push(`# ${doc.title}`, "");
    const meta = [doc.created && `${t("renderCreated")}: ${doc.created}`, doc.updated && `${t("renderUpdated")}: ${doc.updated}`,
      exportedAt && `${t("renderExported")}: ${exportedAt}`].filter(Boolean);
    if (meta.length) out.push(`*${meta.join(" · ")}*`, "");
    const defined = new Set();
    for (const message of doc.messages) {
      const extra = [message.time, message.model].filter(Boolean).join(" · ");
      out.push(`${message.role === "step" ? "###" : "##"} ${message.label}${extra ? ` — ${extra}` : ""}`, "");
      for (const block of message.blocks) {
        if (block.type === "text") out.push(prose(block.text), "");
        else if (block.type === "code") out.push(codeBlock(block.lang, block.text), "");
        else if (block.type === "thought") out.push(...prose(block.text).split("\n").map(line => `> ${line}`), "");
        else if (block.type === "canvas") {
          out.push(`**Canvas — ${block.name}${block.updated ? ` (${t("renderCanvasUpdated")})` : ""}**`, "");
          out.push(block.kind.startsWith("code") ? codeBlock(canvasLang(block.kind), block.content) : prose(block.content), "");
        } else if (block.type === "image") {
          out.push(block.src ? `![${escapeLabel(block.src.split("/").pop())}](${hrefFor(block.src)})` : `*[${t("renderImage")}${block.fileId ? `: ${block.fileId}` : ""}]*`, "");
        } else if (block.type === "footnotes") {
          const fresh = block.items.filter(note => !defined.has(note.n));
          fresh.forEach(note => defined.add(note.n));
          if (fresh.length) out.push(...fresh.map(note => `[^${note.n}]: [${escapeLabel(note.title)}](${note.url})`), "");
        } else if (block.type === "sources") {
          out.push(`**${t("renderSources")}:**`, "", ...block.items.map(s => `- [${escapeLabel(s.title)}](${s.url})`), "");
        } else if (block.type === "files") {
          out.push(`**${t("renderAttachments")}:**`, "", ...block.items.map(item => fileMarkdown(item, t)), "");
        }
      }
    }
    if (doc.leftover.length) out.push(`## ${t("renderLeftover")}`, "", ...doc.leftover.map(item => fileMarkdown(item, t)), "");
    return out.join("\n");
  }

  const plainFile = t => i => i.href ? `- ${i.href}` : `- ${i.label} (${t(i.skipped ? "renderSkipped" : "renderFailed")})`;

  function toText(doc, { t }) {
    const prose = text => ns.markdown.dollarMath(text).replace(FN_TOKEN, "[$1]");
    const out = [doc.title, "=".repeat(Math.min(doc.title.length, 72)), ""];
    for (const message of doc.messages) {
      const extra = [message.time, message.model].filter(Boolean).join(" · ");
      out.push(`[${message.label}${extra ? ` — ${extra}` : ""}]`);
      for (const block of message.blocks) {
        if (block.type === "text") out.push(prose(block.text));
        else if (block.type === "code") out.push(block.text);
        else if (block.type === "thought") out.push(prose(block.text).split("\n").map(line => `  | ${line}`).join("\n"));
        else if (block.type === "canvas") out.push(`Canvas — ${block.name}:`, block.content);
        else if (block.type === "image") out.push(`[${t("renderImage")}${block.src ? `: ${block.src}` : ""}]`);
        else if (block.type === "footnotes") out.push(...block.items.map(note => `[${note.n}] ${note.title} <${note.url}>`));
        else if (block.type === "sources") out.push(t("renderSources") + ":", ...block.items.map(s => `- ${s.title} <${s.url}>`));
        else if (block.type === "files") out.push(t("renderAttachments") + ":", ...block.items.map(plainFile(t)));
      }
      out.push("");
    }
    if (doc.leftover.length) out.push(t("renderLeftover") + ":", ...doc.leftover.map(plainFile(t)), "");
    return out.join("\n");
  }

  // ---- HTML ----
  const escapeHtml = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const labels = { copy: "Copy", done: "Copied" };
  const codeCard = (lang, text) => `<div class="code"><div class="code-head"><span>${escapeHtml(lang || "")}</span><button type="button" data-copy data-done="${escapeHtml(labels.done)}">${escapeHtml(labels.copy)}</button></div><pre><code>${escapeHtml(text)}</code></pre></div>`;
  const printCodeCard = (lang, text) => `<div class="code"><div class="code-head"><span>${escapeHtml(lang || "")}</span></div><pre><code>${escapeHtml(text)}</code></pre></div>`;
  const fnLink = n => `<sup class="fn"><a href="#fn-${n}">${n}</a></sup>`;

  // Backward compatibility: the public markdownToHtml uses the code card with a copy button.
  const markdownToHtml = (source, ctx = {}) => ns.markdown.toHtml(source, { codeCard: ctx.codeCard || codeCard, img: ctx.img, fn: ctx.fn || fnLink });

  const CSS = `:root{color-scheme:light dark;--bg:#fff;--side:#f9f9f9;--fg:#0d0d0d;--muted:#6b6b6b;--line:#e5e5e5;--hover:#ececec;--active:#ececec;--bubble:#f4f4f4;--code:#f9f9f9;--codehead:#ececec;--link:#2564c8;--chip:#f4f4f4}
@media(prefers-color-scheme:dark){:root{--bg:#000;--side:#000;--fg:#ececec;--muted:#9b9b9b;--line:#262626;--hover:#161616;--active:#212121;--bubble:#2a2a2a;--code:#0f0f0f;--codehead:#212121;--link:#6aa5ff;--chip:#1c1c1c}}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.75 ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.app{display:flex;height:100vh}.sidebar{width:260px;flex:none;background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;overflow:hidden}
.side-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px 10px;font-size:20px;font-weight:600;line-height:1.3}
.search{padding:4px 10px 6px}.search input{width:100%;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit;font:inherit;font-size:14px;outline:none}.search input:focus{border-color:var(--muted)}
.side-title{margin:14px 18px 6px;font-size:13px;color:var(--muted);line-height:1.4}
#chat-list{flex:1;overflow:auto;padding:0 8px 12px}.chat{display:block;padding:8px 10px;border-radius:10px;color:inherit;text-decoration:none;font-size:14px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chat:hover{background:var(--hover)}.chat.active{background:var(--active)}.empty{margin:8px 10px;font-size:13px;color:var(--muted)}
main{flex:1;min-width:0;display:flex;flex-direction:column}.top{display:flex;align-items:center;gap:10px;min-height:56px;padding:8px 20px}
.top h1{margin:0;font-size:16px;font-weight:600;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.top .meta{margin-left:auto;font-size:12px;color:var(--muted);white-space:nowrap}
.scroll{flex:1;overflow:auto}.thread{max-width:768px;margin:0 auto;padding:12px 24px 96px}.landing{display:grid;place-items:center;height:100%;color:var(--muted);text-align:center;padding:24px}.landing h2{margin:0 0 6px;font-size:28px;font-weight:500;color:var(--fg)}
.icon-btn{display:none;cursor:pointer;width:36px;height:36px;border-radius:10px;align-items:center;justify-content:center;font-size:18px;color:var(--muted)}.icon-btn:hover{background:var(--hover)}
.msg{margin:20px 0}.msg.user{display:flex;flex-direction:column;align-items:flex-end}.bubble{max-width:80%;background:var(--bubble);border-radius:24px;padding:10px 20px}.bubble>:first-child{margin-top:0}.bubble>:last-child{margin-bottom:0}
.bubble p{margin:.4em 0}.msg-meta{font-size:12px;color:var(--muted);opacity:0;transition:opacity .15s;margin-top:4px;line-height:1.4}.msg:hover .msg-meta{opacity:1}
.prose>:first-child{margin-top:0}.prose p{margin:0 0 1em;white-space:pre-wrap}.prose h1,.prose h2,.prose h3,.prose h4{line-height:1.35;margin:1.4em 0 .6em}.prose h1{font-size:1.6em}.prose h2{font-size:1.35em}.prose h3{font-size:1.15em}
.prose ul,.prose ol{margin:0 0 1em;padding-left:1.6em}.prose li{margin:.25em 0}.prose li>p{margin:0}.prose a{color:var(--link)}.prose hr{border:0;border-top:1px solid var(--line);margin:1.5em 0}
.prose blockquote{margin:1em 0;padding:0 0 0 1em;border-left:3px solid var(--line);color:var(--muted)}.prose img{max-width:100%;border-radius:14px}
.prose :not(pre)>code{background:var(--bubble);padding:.15em .4em;border-radius:6px;font-size:.88em}code{font:13.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.prose table{border-collapse:collapse;margin:1em 0;display:block;overflow:auto;max-width:100%}.prose th,.prose td{padding:.5em 1em;border-bottom:1px solid var(--line);text-align:left}.prose th{font-weight:600}
.math-display{margin:1em 0;padding:.3em 0;overflow-x:auto;overflow-y:hidden}math{font-size:1.08em}.math{white-space:pre-wrap}
.code{margin:1em 0;border:1px solid var(--line);border-radius:14px;background:var(--code);overflow:hidden}.code-head{display:flex;align-items:center;justify-content:space-between;padding:6px 14px;background:var(--codehead);font-size:12px;color:var(--muted);line-height:1.6}
.code-head button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:2px 6px;border-radius:6px}.code-head button:hover{color:var(--fg)}.code pre{margin:0;padding:14px 16px;overflow:auto}
.step{margin:12px 0;font-size:14px;color:var(--muted)}.step summary{cursor:pointer;line-height:1.6}.step .prose{margin-top:8px}.thought{color:var(--muted);font-style:italic}
.canvas{margin:12px 0;border:1px solid var(--line);border-radius:14px;overflow:hidden}.canvas-head{padding:8px 16px;background:var(--codehead);font-size:13px;font-weight:600}.canvas-body{padding:12px 18px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.chip{display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:8px 12px;border:1px solid var(--line);border-radius:12px;background:var(--chip);color:inherit;text-decoration:none;font-size:14px;line-height:1.4}
.chip svg{flex:none;width:18px;height:18px;opacity:.7}.chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.prose a.chip{color:inherit}a.chip:hover{border-color:var(--muted)}.chip.failed{color:#d44;border-style:dashed}
sup.fn a{font-size:.72em;text-decoration:none;padding:0 .3em;border-radius:6px;background:var(--chip);color:var(--muted)}.footnotes{margin:10px 0;padding-left:1.4em;font-size:13px;color:var(--muted)}.footnotes a{color:var(--link)}
.sources{margin:10px 0}.sources .label{font-size:13px;color:var(--muted);margin-bottom:4px}.sources a{display:inline-block;margin:0 6px 6px 0;padding:3px 10px;border-radius:999px;background:var(--chip);border:1px solid var(--line);color:inherit;font-size:12.5px;text-decoration:none;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:top}
.file-text{margin:6px 0}.file-text summary{cursor:pointer;font-size:13px;color:var(--muted)}.failed{color:#d44}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;padding:16px 24px 80px}.gallery figure{margin:0}.gallery img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:12px;background:var(--chip)}
.gallery figcaption{font-size:12.5px;line-height:1.4;margin-top:6px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gallery figcaption a{color:inherit}
#nav-toggle{display:none}.scrim{display:none}
@media(max-width:820px){.icon-btn{display:flex}.sidebar{position:fixed;inset:0 auto 0 0;z-index:20;transform:translateX(-100%);transition:transform .2s;width:min(300px,86vw)}#nav-toggle:checked~.app .sidebar{transform:none}
#nav-toggle:checked~.app .scrim{display:block;position:fixed;inset:0;z-index:10;background:#0006}.thread{padding:8px 16px 80px}.bubble{max-width:92%}.top .meta{display:none}}`;

  const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';

  // Small self-contained script for the copy button, sidebar list and search (no external resources).
  const PAGE_SCRIPT = `(function(){
document.addEventListener("click",function(e){var b=e.target.closest("[data-copy]");if(!b)return;var c=b.closest(".code").querySelector("code").textContent;
(navigator.clipboard?navigator.clipboard.writeText(c):Promise.reject()).then(function(){var o=b.textContent;b.textContent=b.dataset.done;setTimeout(function(){b.textContent=o},1500)},function(){})});
var nav=document.getElementById("chat-list");if(!nav||!nav.dataset.multi)return;
var chats=window.CSI_CHATS||[],root=nav.dataset.root||"",cur=nav.dataset.current||"",q=document.getElementById("q");
function draw(){var f=q?q.value.trim().toLocaleLowerCase():"",n=0;nav.textContent="";
chats.forEach(function(c){if(f&&c.t.toLocaleLowerCase().indexOf(f)<0)return;n++;var a=document.createElement("a");a.className="chat"+(c.h===cur?" active":"");a.href=root+c.h.split("/").map(encodeURIComponent).join("/");a.title=c.t+(c.d?" — "+c.d:"");a.textContent=c.t;if(c.h===cur)a.setAttribute("aria-current","page");nav.appendChild(a)});
if(!n){var p=document.createElement("p");p.className="empty";p.textContent=nav.dataset.empty;nav.appendChild(p)}}
if(q)q.addEventListener("input",draw);draw();var a=nav.querySelector(".active");if(a&&a.scrollIntoView)a.scrollIntoView({block:"center"})})();`;

  const CSP = "default-src 'none'; img-src 'self' data: file:; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'self' file:";

  function pageShell({ t, lang, title, layout, headerTitle, meta, body }) {
    const multi = layout.mode === "multi";
    const side = multi
      ? `<div class="search"><input id="q" type="search" placeholder="${escapeHtml(t("htmlSearch"))}" aria-label="${escapeHtml(t("htmlSearch"))}"></div>
<p class="side-title">${escapeHtml(t("htmlRecent"))}</p>
<nav id="chat-list" data-multi="1" data-root="${escapeHtml(layout.root || "")}" data-current="${escapeHtml(layout.current || "")}" data-empty="${escapeHtml(t("htmlNoMatch"))}"><noscript><a class="chat" href="${escapeHtml((layout.root || "") + "index.html")}">${escapeHtml(t("htmlRecent"))}</a></noscript></nav>`
      : `<p class="side-title">${escapeHtml(t("htmlRecent"))}</p>
<nav id="chat-list"><a class="chat active" aria-current="page" title="${escapeHtml(title)}">${escapeHtml(title)}</a></nav>`;
    return `<!doctype html>
<html lang="${escapeHtml(lang || "en")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>
<input type="checkbox" id="nav-toggle" aria-hidden="true">
<div class="app">
<aside class="sidebar"><div class="side-head"><span>ChatGPT</span><label class="icon-btn" for="nav-toggle" aria-label="${escapeHtml(t("htmlCloseMenu"))}">✕</label></div>
${side}
</aside><label class="scrim" for="nav-toggle"></label>
<main><header class="top"><label class="icon-btn" for="nav-toggle" aria-label="${escapeHtml(t("htmlMenu"))}">☰</label><h1>${escapeHtml(headerTitle)}</h1><span class="meta">${escapeHtml(meta || "")}</span></header>
<div class="scroll">${body}</div></main>
</div>
${multi ? `<script src="${escapeHtml((layout.root || "") + "assets/chats.js")}"></script>\n` : ""}<script>${PAGE_SCRIPT}</script>
</body></html>
`;
  }

  function fileChips(items, t, ctx) {
    const chips = items.map(item => {
      if (item.skipped) return `<span class="chip">${FILE_ICON}<span>${escapeHtml(item.label)} — ${escapeHtml(t("renderSkipped"))}</span></span>`;
      if (!item.href) return `<span class="chip failed">${FILE_ICON}<span>${escapeHtml(item.label)} — ${escapeHtml(t("renderFailed"))}: ${escapeHtml(item.error)}</span></span>`;
      return `<a class="chip" href="${escapeHtml(hrefFor(item.href))}">${FILE_ICON}<span>${escapeHtml(item.label)}</span></a>`;
    }).join("");
    const details = items.filter(i => i.href && (i.text !== undefined || i.textError)).map(i => i.textError
      ? `<p class="failed">${escapeHtml(i.label)}: ${escapeHtml(i.textError)}</p>`
      : `<details class="file-text"${ctx.print ? " open" : ""}><summary>${escapeHtml(i.label)} — ${escapeHtml(t("renderAttachmentContent"))}</summary>${ctx.codeCard("", i.text)}</details>`).join("");
    return `<div class="chips">${chips}</div>${details}`;
  }

  // ctx: { t, codeCard, img(path) → url, print }
  function blocksHtml(blocks, ctx) {
    const { t } = ctx;
    const mdCtx = { codeCard: ctx.codeCard, img: ctx.img, fn: fnLink };
    return blocks.map(block => {
      if (block.type === "text") return ns.markdown.toHtml(block.text, mdCtx);
      if (block.type === "code") return ctx.codeCard(block.lang, block.text);
      if (block.type === "thought") return `<blockquote class="thought">${ns.markdown.toHtml(block.text, mdCtx)}</blockquote>`;
      if (block.type === "canvas") {
        const body = block.kind.startsWith("code") ? ctx.codeCard(canvasLang(block.kind), block.content) : `<div class="canvas-body prose">${ns.markdown.toHtml(block.content, mdCtx)}</div>`;
        return `<div class="canvas"><div class="canvas-head">Canvas · ${escapeHtml(block.name)}${block.updated ? ` · ${escapeHtml(t("renderCanvasUpdated"))}` : ""}</div>${body}</div>`;
      }
      if (block.type === "image") {
        return block.src ? `<p><img alt="${escapeHtml(block.src.split("/").pop())}" src="${escapeHtml(ctx.img(block.src))}"></p>`
          : `<p class="chip">${FILE_ICON}<span>${escapeHtml(t("renderImage"))}</span></p>`;
      }
      if (block.type === "footnotes") {
        return `<ol class="footnotes">${block.items.map(note => `<li id="fn-${note.n}" value="${note.n}"><a href="${escapeHtml(note.url)}" rel="noopener noreferrer" target="_blank">${escapeHtml(note.title)}</a></li>`).join("")}</ol>`;
      }
      if (block.type === "sources") {
        return `<div class="sources"><div class="label">${escapeHtml(t("renderSources"))}</div>${block.items.map(s =>
          `<a href="${escapeHtml(s.url)}" rel="noopener noreferrer" target="_blank" title="${escapeHtml(s.url)}">${escapeHtml(s.title)}</a>`).join("")}</div>`;
      }
      return block.type === "files" ? fileChips(block.items, t, ctx) : "";
    }).join("\n");
  }

  function messagesHtml(doc, ctx) {
    const body = doc.messages.map(message => {
      const extra = [message.time, message.model].filter(Boolean).join(" · ");
      const meta = extra ? `<div class="msg-meta">${escapeHtml(extra)}</div>` : "";
      if (message.role === "user") return `<article class="msg user"><div class="bubble prose">${blocksHtml(message.blocks, ctx)}</div>${meta}</article>`;
      if (message.role === "step") return `<details class="step"${ctx.print ? " open" : ""}><summary>${escapeHtml(message.label)}</summary><div class="prose">${blocksHtml(message.blocks, ctx)}</div></details>`;
      return `<article class="msg assistant"><div class="prose">${blocksHtml(message.blocks, ctx)}</div>${meta}</article>`;
    });
    if (doc.leftover.length) body.push(`<article class="msg assistant"><div class="prose"><h3>${escapeHtml(ctx.t("renderLeftover"))}</h3>${fileChips(doc.leftover, ctx.t, ctx)}</div></article>`);
    return body.join("\n");
  }

  // layout: { mode: "single" } | { mode: "multi", root: "../../", current: "chats/x/conversation.html" }
  function toHtml(doc, { t, exportedAt, lang, layout = { mode: "single" } }) {
    labels.copy = t("renderCopy"); labels.done = t("renderCopied");
    const meta = [doc.created, exportedAt && `${t("renderExported")}: ${exportedAt}`].filter(Boolean).join(" · ");
    const ctx = { t, codeCard, img: hrefFor };
    return pageShell({ t, lang, title: doc.title, layout, headerTitle: doc.title, meta, body: `<div class="thread">${messagesHtml(doc, ctx)}</div>` });
  }

  // Print page for PDF: no sidebar or script, images embedded as data: URIs, light theme, page breaks.
  // items: [{ doc, images: Map(archive path → data URI) }]
  const PRINT_CSS = `@page{margin:16mm 14mm}*{box-sizing:border-box}body{margin:0;color:#0d0d0d;background:#fff;font:11.5pt/1.6 ui-sans-serif,-apple-system,system-ui,"Segoe UI",Helvetica,Arial,sans-serif}
.conv+.conv{break-before:page}h1.title{font-size:20pt;line-height:1.25;margin:0 0 4px}.meta{color:#6b6b6b;font-size:9.5pt;margin:0 0 18px}
.msg{margin:14px 0;break-inside:auto}.msg.user .bubble{background:#f4f4f4;border-radius:14px;padding:8px 14px;margin-left:12%}.msg-meta{font-size:8.5pt;color:#8a8a8a;margin-top:2px}.msg.user .msg-meta{text-align:right}
.prose p{margin:0 0 .8em;white-space:pre-wrap}.prose h1,.prose h2,.prose h3{line-height:1.3;margin:1.1em 0 .5em;break-after:avoid}.prose h1{font-size:16pt}.prose h2{font-size:14pt}.prose h3{font-size:12pt}
.prose ul,.prose ol{margin:0 0 .8em;padding-left:1.5em}.prose a{color:#2564c8;text-decoration:none}.prose blockquote{margin:.8em 0;padding-left:.9em;border-left:3px solid #ddd;color:#555}
.prose img{max-width:100%;max-height:200mm;border-radius:8px}.prose :not(pre)>code{background:#f2f2f2;padding:.1em .35em;border-radius:4px;font-size:.9em}
code{font:9.5pt/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.code{margin:.8em 0;border:1px solid #e5e5e5;border-radius:8px;break-inside:avoid-page}.code-head{padding:3px 10px;background:#f2f2f2;font-size:8.5pt;color:#6b6b6b;min-height:6px}
.code pre{margin:0;padding:8px 10px;white-space:pre-wrap;overflow-wrap:anywhere}table{border-collapse:collapse;margin:.8em 0;font-size:10pt}th,td{border-bottom:1px solid #e5e5e5;padding:4px 8px;text-align:left}
.math-display{margin:.8em 0}.step{color:#6b6b6b;font-size:10pt}.step summary{list-style:none;font-weight:600}.thought{color:#6b6b6b;font-style:italic}
.canvas{border:1px solid #e5e5e5;border-radius:8px;margin:.8em 0}.canvas-head{padding:4px 10px;background:#f2f2f2;font-weight:600;font-size:9.5pt}.canvas-body{padding:6px 12px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}.chip{display:inline-flex;gap:6px;align-items:center;padding:3px 9px;border:1px solid #e5e5e5;border-radius:8px;font-size:9pt;color:#333;text-decoration:none}.chip svg{width:12px;height:12px}
sup.fn a{font-size:7.5pt;color:#6b6b6b;text-decoration:none}.footnotes{font-size:9pt;color:#555;padding-left:1.4em}.footnotes a{color:#2564c8;overflow-wrap:anywhere}
.sources{font-size:9pt;color:#555}.sources a{display:inline-block;margin:0 8px 4px 0;color:#2564c8}.sources .label{font-weight:600}.failed{color:#c33}`;

  function toPrintHtml(items, { t, lang, exportedAt }) {
    const sections = items.map(({ doc, images }) => {
      const ctx = { t, print: true, codeCard: printCodeCard, img: path => images?.get(path) || hrefFor(path) };
      const meta = [doc.created && `${t("renderCreated")}: ${doc.created}`, doc.updated && `${t("renderUpdated")}: ${doc.updated}`,
        exportedAt && `${t("renderExported")}: ${exportedAt}`].filter(Boolean).join(" · ");
      return `<section class="conv"><h1 class="title">${escapeHtml(doc.title)}</h1><p class="meta">${escapeHtml(meta)}</p>${messagesHtml(doc, ctx)}</section>`;
    });
    const title = items.length === 1 ? items[0].doc.title : t("bulkIndexTitle");
    return `<!doctype html>
<html lang="${escapeHtml(lang || "en")}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head><body>
${sections.join("\n")}
</body></html>
`;
  }

  // Landing page of a bulk export: full sidebar plus a welcome view.
  function toHtmlIndex(count, { t, lang }) {
    labels.copy = t("renderCopy"); labels.done = t("renderCopied");
    return pageShell({ t, lang, title: t("bulkIndexTitle"), layout: { mode: "multi", root: "", current: "" }, headerTitle: t("bulkIndexTitle"),
      meta: String(count), body: `<div class="landing"><div><h2>${escapeHtml(t("htmlPickChat"))}</h2><p>${escapeHtml(String(count))} ${escapeHtml(t("htmlChatsWord"))}</p></div></div>` });
  }

  // Image gallery. items: [{ src, conversation, href?, day }] — paths are relative to gallery.html.
  function toGalleryHtml(items, { t, lang, multi }) {
    const figures = items.map(item => `<figure><a href="${escapeHtml(hrefFor(item.src))}"><img loading="lazy" alt="${escapeHtml(item.conversation)}" src="${escapeHtml(hrefFor(item.src))}"></a>
<figcaption>${item.href ? `<a href="${escapeHtml(hrefFor(item.href))}">${escapeHtml(item.conversation)}</a>` : escapeHtml(item.conversation)}${item.day ? ` · ${escapeHtml(item.day)}` : ""}</figcaption></figure>`);
    const body = items.length ? `<div class="gallery">${figures.join("\n")}</div>` : `<div class="landing"><p>${escapeHtml(t("galleryEmpty"))}</p></div>`;
    labels.copy = t("renderCopy"); labels.done = t("renderCopied");
    return pageShell({ t, lang, title: t("galleryTitle"), layout: multi ? { mode: "multi", root: "", current: "" } : { mode: "single" },
      headerTitle: t("galleryTitle"), meta: `${items.length} ${t("galleryImagesWord")}`, body });
  }

  // Markdown index of a bulk archive. rows: [{ title, day, ... }], link(row) → relative path
  const toIndexMarkdown = (rows, { t, link }) =>
    [`# ${t("bulkIndexTitle")}`, "", ...rows.map(row => `- ${row.day} — [${escapeLabel(row.title)}](${link(row)})`), ""].join("\n");

  // Shared data read by the sidebar (assets/chats.js). chats: [{ t: title, h: path, d: date }]
  const chatsData = chats => `window.CSI_CHATS=${JSON.stringify(chats).replace(/</g, "\\u003c")};\n`;

  const api = { cleanText, buildDocument, messageSummaries, toMarkdown, toText, toHtml, toPrintHtml, toHtmlIndex, toGalleryHtml, toIndexMarkdown, chatsData,
    markdownToHtml, escapeHtml, formatTime, hrefFor, FN_TOKEN };
  ns.render = api;
  if (typeof module !== "undefined") module.exports = api;
})();
