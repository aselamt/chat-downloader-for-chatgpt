// Yan panel: aktif sekmeyi izler; sohbet/mesaj listelerini gösterir; dışa aktarmayı sohbet sekmesinde başlatır,
// ilerlemeyi yansıtır; "Klasöre kaydet" modunda sekmeden gelen dosyaları seçilen klasöre yazar.
const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
const $ = selector => document.querySelector(selector);
const form = $("#export-form");
const button = $("#download");
const status = $("#status");
const FILES = ["vendor/katex.min.js", "src/zip.js", "src/markdown.js", "src/render.js", "src/docx.js", "src/core.js", "src/exporter.js"];
const SETTING_FIELDS = ["scope", "formats", "attachments", "textMode", "steps", "obsidian", "gallery", "saveMode", "incremental", "messagesOnly"];

let tab = null;                 // aktif sekme (yalnızca chatgpt.com sekmelerinin url/başlığı görünür)
let windowId = null;
let conversations = null;       // [{ id, title, update_time, archived, project, gpt }]
let listState = "idle";         // idle | loading | error | ready
let listError = "";
const selected = new Set();
let messages = null;            // açık sohbetin mesajları: { chatId, items: [{ id, role, preview, images }] }
let messageState = "idle";
let messageError = "";
const selectedMessages = new Set();
let lastMessageIndex = null;    // Shift ile aralık seçimi için
const progressByTab = new Map(); // tabId → { state, message, fraction }
let backupState = {};           // id → update_time (artımlı yedek)
let folderHandle = null;

for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n);
for (const element of document.querySelectorAll("[data-i18n-placeholder]")) element.placeholder = t(element.dataset.i18nPlaceholder);
for (const element of document.querySelectorAll("[data-i18n-title]")) { element.title = t(element.dataset.i18nTitle); element.setAttribute("aria-label", element.title); }
for (const element of document.querySelectorAll("[data-i18n-aria-label]")) element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
document.documentElement.lang = chrome.i18n.getUILanguage();
const uiLang = chrome.i18n.getUILanguage();

let hintShown = false; // refresh() yalnızca kendi gösterdiği uyarıyı siler.
function setStatus(message, isError = false) {
  status.dataset.error = String(isError);
  status.textContent = message;
}

// ---- Ayarlar (chrome.storage: sayfa düğmesi ve sağ tık menüsü de aynı ayarları kullanır) ----
function currentOptions() {
  const data = new FormData(form);
  return {
    scope: data.get("scope"),
    formats: data.getAll("formats"),
    attachments: data.has("attachments"),
    textMode: data.get("textMode"),
    steps: data.has("steps"),
    obsidian: data.has("obsidian"),
    gallery: data.has("gallery"),
    saveMode: data.get("saveMode"),
    incremental: data.has("incremental"),
    messagesOnly: data.has("messagesOnly")
  };
}

function saveSettings() {
  const options = currentOptions();
  chrome.storage.local.set({ settings: Object.fromEntries(SETTING_FIELDS.map(key => [key, options[key]])) }).catch(() => {});
}

function applySettings(saved = {}) {
  if (saved.scope) form.elements.scope.value = saved.scope;
  if (Array.isArray(saved.formats)) for (const box of form.elements.formats) box.checked = saved.formats.includes(box.value);
  for (const key of ["attachments", "steps", "obsidian", "gallery", "incremental", "messagesOnly"]) {
    if (typeof saved[key] === "boolean") form.elements[key].checked = saved[key];
  }
  if (saved.textMode) form.elements.textMode.value = saved.textMode;
  if (saved.saveMode) form.elements.saveMode.value = saved.saveMode;
}

// ---- Klasör tanıtıcısı (IndexedDB'de saklanır; izin her oturumda kullanıcı eylemiyle yenilenir) ----
function idb(mode, action) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("sohbet-indir", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("handles");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = action(open.result.transaction("handles", mode).objectStore("handles"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    };
  });
}

function renderFolder() {
  const name = $("#folder-name");
  name.dataset.set = String(Boolean(folderHandle));
  name.textContent = folderHandle ? folderHandle.name : t("folderNone");
}

$("#folder-pick").addEventListener("click", async () => {
  try {
    folderHandle = await showDirectoryPicker({ id: "sohbet-indir", mode: "readwrite" });
    await idb("readwrite", store => store.put(folderHandle, "folder"));
  } catch (error) {
    if (error.name !== "AbortError") setStatus(error.message, true);
  }
  renderFolder();
  refresh();
});

async function ensureFolderPermission() {
  if (!folderHandle) throw new Error(t("errNoFolder"));
  if (await folderHandle.queryPermission({ mode: "readwrite" }) === "granted") return;
  if (await folderHandle.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error(t("errFolderPermission"));
}

async function fileAt(path, create = true) {
  const parts = path.split("/");
  let directory = folderHandle;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create });
  return directory.getFileHandle(parts.at(-1), { create });
}

async function readText(path) {
  try { return await (await (await fileAt(path, false)).getFile()).text(); } catch { return null; }
}

async function writeText(path, text) {
  const writable = await (await fileAt(path)).createWritable();
  await writable.write(text);
  await writable.close();
}

const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

// Arşiv dizini: assets/arsiv.json yeni sohbetlerle birleştirilir; index.md, index.html, kenar çubuğu ve galeri yeniden yazılır.
async function writeArchiveIndex(manifest) {
  const { render } = globalThis.__csi;
  const previous = JSON.parse(await readText("assets/arsiv.json") || "{}");
  const ids = new Set(manifest.rows.map(row => row.id));
  const rows = [...manifest.rows, ...(previous.rows || []).filter(row => !ids.has(row.id))]
    .sort((a, b) => String(b.day).localeCompare(String(a.day)));
  const gallery = [...manifest.gallery, ...(previous.gallery || []).filter(item => !ids.has(item.id))];
  await writeText("assets/arsiv.json", JSON.stringify({ updated: new Date().toISOString(), rows, gallery }, null, 2));
  const link = row => ["sohbetler", row.folder, row.md || row.html || "conversation.json"].map(encodeURIComponent).join("/");
  await writeText("index.md", render.toIndexMarkdown(rows, { t, link }));
  const withHtml = rows.filter(row => row.html);
  if (withHtml.length) {
    await writeText("index.html", render.toHtmlIndex(withHtml.length, { t, lang: uiLang }));
    await writeText("assets/chats.js", render.chatsData(withHtml.map(row => ({ t: row.title, h: `sohbetler/${row.folder}/${row.html}`, d: row.day }))));
  }
  if (gallery.length) await writeText("galeri.html", render.toGalleryHtml(gallery, { t, lang: uiLang, multi: withHtml.length > 0 }));
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "csi-folder" || port.sender?.id !== chrome.runtime.id) return;
  let writable = null;
  let queue = Promise.resolve();
  const handle = async message => {
    if (message.type === "begin") {
      if (!folderHandle || await folderHandle.queryPermission({ mode: "readwrite" }) !== "granted") throw new Error(t("errNoFolder"));
    } else if (message.type === "chunk") {
      if (!/^[^/][\s\S]*$/.test(message.name) || message.name.split("/").some(part => part === ".." || part === "." || !part)) throw new Error(t("errFolder"));
      if (message.first) writable = await (await fileAt(message.name)).createWritable();
      await writable.write(fromBase64(message.data));
      if (message.last) { await writable.close(); writable = null; }
    } else if (message.type === "end") {
      await writeArchiveIndex(message.manifest);
    }
  };
  port.onMessage.addListener(message => {
    queue = queue.then(() => handle(message))
      .then(() => port.postMessage({ type: "ack" }), error => port.postMessage({ type: "error", message: error.message }));
  });
  port.onDisconnect.addListener(() => { writable?.abort?.().catch(() => {}); });
});

// ---- Sekme bilgisi ----
function pageKind(target) {
  let url;
  try { url = new URL(target?.url); } catch { return "other"; }
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") return "other";
  if (/\/c\/[a-f0-9-]{36}(?:\/|$)/i.test(url.pathname)) return "chat";
  if (/\/share\/(?:e\/)?[a-f0-9-]{36}(?:\/|$)/i.test(url.pathname)) return "share";
  return "site";
}

const chatIdOf = target => { try { return new URL(target.url).pathname.match(/\/(?:c|share(?:\/e)?)\/([a-f0-9-]{36})/i)?.[1] || null; } catch { return null; } };

function renderTabInfo() {
  const info = $("#tab-info");
  const kind = pageKind(tab);
  info.dataset.kind = kind === "share" ? "chat" : kind;
  const title = (tab?.title || "").replace(/^ChatGPT\s*[-–—|]\s*/i, "").trim();
  info.textContent = kind === "chat" || kind === "share" ? `${kind === "share" ? `${t("tabShare")}: ` : ""}${title || t("tabChat")}` : t(kind === "site" ? "tabSite" : "tabOther");
  info.title = info.textContent;
}

function listMessage(list, text, isError = false) {
  const p = document.createElement("p");
  p.className = isError ? "msg error" : "msg";
  p.textContent = text;
  list.append(p);
}

// ---- Mesaj seçimi (açık sohbet) ----
function renderMessages() {
  const list = $("#msg-list");
  list.textContent = "";
  if (messageState === "loading") return listMessage(list, t("msgLoading"));
  if (messageState === "error") return listMessage(list, messageError, true);
  if (!messages?.items.length) return listMessage(list, t("msgEmpty"));
  messages.items.forEach((item, index) => {
    const row = document.createElement("label");
    row.className = "row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = item.id;
    input.dataset.index = String(index);
    input.checked = selectedMessages.has(item.id);
    const role = document.createElement("span");
    role.className = `role ${item.role}`;
    role.textContent = item.role === "user" ? t("renderUser") : t("renderAssistant");
    const text = document.createElement("span");
    text.className = "t";
    text.textContent = item.preview || (item.images ? t("renderImage") : "…");
    text.title = item.preview;
    row.append(input, role, text);
    if (item.images) {
      const pics = document.createElement("span");
      pics.className = "pics";
      pics.textContent = `🖼 ${item.images}`;
      row.append(pics);
    }
    list.append(row);
  });
  $("#msg-count").textContent = t("pickCount", [String(selectedMessages.size), String(messages.items.length)]);
}

async function loadMessages(force = false) {
  const chatId = chatIdOf(tab);
  if (!chatId || messageState === "loading" || (!force && messages?.chatId === chatId)) return renderMessages();
  messageState = "loading";
  renderMessages();
  try {
    const target = { tabId: tab.id };
    await chrome.scripting.executeScript({ target, files: FILES });
    const [{ result }] = await chrome.scripting.executeScript({ target, func: id => globalThis.chatGPTListMessages(id), args: [chatId] });
    if (!result?.ok) throw new Error(result?.error || t("errListFailed"));
    messages = { chatId, items: result.items };
    selectedMessages.clear();
    result.items.forEach(item => selectedMessages.add(item.id));
    lastMessageIndex = null;
    messageState = "ready";
  } catch (error) {
    messageState = "error";
    messageError = error.message;
  }
  renderMessages();
  refresh();
}

$("#msg-list").addEventListener("click", event => {
  const input = event.target.closest("input[type=checkbox]");
  if (!input) return;
  const index = Number(input.dataset.index);
  // Shift+tık: son tıklanandan bu satıra kadar aynı duruma getirir.
  if (event.shiftKey && lastMessageIndex !== null) {
    const [from, to] = [Math.min(lastMessageIndex, index), Math.max(lastMessageIndex, index)];
    for (const item of messages.items.slice(from, to + 1)) input.checked ? selectedMessages.add(item.id) : selectedMessages.delete(item.id);
  } else {
    input.checked ? selectedMessages.add(input.value) : selectedMessages.delete(input.value);
  }
  lastMessageIndex = index;
  renderMessages();
  refresh();
});
const selectMessages = predicate => {
  selectedMessages.clear();
  for (const item of messages?.items || []) if (predicate(item)) selectedMessages.add(item.id);
  renderMessages();
  refresh();
};
$("#msg-all").addEventListener("click", () => selectMessages(() => true));
$("#msg-answers").addEventListener("click", () => selectMessages(item => item.role === "assistant"));
$("#msg-prompts").addEventListener("click", () => selectMessages(item => item.role === "user"));
$("#msg-none").addEventListener("click", () => selectMessages(() => false));

// ---- Sohbet listesi ("Sohbet seç") ----
function filteredConversations() {
  const query = $("#pick-search").value.trim().toLocaleLowerCase(uiLang);
  const filter = $("#pick-filter").value;
  const from = $("#pick-from").value;
  const to = $("#pick-to").value;
  return conversations.filter(item => {
    const title = (item.title || t("renderUntitled")).toLocaleLowerCase(uiLang);
    const day = item.update_time.slice(0, 10);
    if (query && !title.includes(query)) return false;
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (filter === "none") return !item.project && !item.gpt;
    if (filter === "archived") return item.archived;
    if (filter === "gpt") return item.gpt;
    if (filter.startsWith("p:")) return item.project === filter.slice(2);
    return true;
  });
}

function renderProjects() {
  const select = $("#pick-filter");
  for (const option of [...select.querySelectorAll("option[data-project]")]) option.remove();
  const projects = [...new Set(conversations.map(item => item.project).filter(Boolean))].sort((a, b) => a.localeCompare(b, uiLang));
  for (const name of projects) {
    const option = document.createElement("option");
    option.value = `p:${name}`;
    option.dataset.project = "1";
    option.textContent = `${t("filterProject")}: ${name}`;
    select.append(option);
  }
}

function renderList() {
  const list = $("#pick-list");
  list.textContent = "";
  if (listState === "loading") return listMessage(list, t("pickLoading"));
  if (listState === "error") return listMessage(list, listError, true);
  if (!conversations) return listMessage(list, t(pageKind(tab) === "other" ? "errWrongSite" : "pickLoading"));
  const current = chatIdOf(tab);
  const shown = filteredConversations();
  for (const item of shown) {
    const title = item.title || t("renderUntitled");
    const row = document.createElement("label");
    row.className = "row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = item.id;
    input.checked = selected.has(item.id);
    const name = document.createElement("span");
    name.className = "t";
    name.textContent = title;
    name.title = title;
    row.append(input, name);
    const tag = (text, className = "tag") => { const span = document.createElement("span"); span.className = className; span.textContent = text; span.title = text; row.append(span); };
    if (item.id === current) tag(t("pickCurrent"), "now");
    if (item.project) tag(item.project);
    else if (item.gpt) tag("GPT");
    if (item.archived) tag(t("filterArchivedShort"));
    tag(item.update_time.slice(0, 10), "d");
    list.append(row);
  }
  if (!shown.length) listMessage(list, t("pickEmpty"));
  $("#pick-count").textContent = t("pickCount", [String(selected.size), String(conversations.length)]);
}

const visibleIds = () => [...document.querySelectorAll("#pick-list input")].map(input => input.value);

async function loadList(force = false) {
  if (pageKind(tab) === "other" || listState === "loading" || (conversations && !force)) return renderList();
  listState = "loading";
  renderList();
  try {
    const target = { tabId: tab.id };
    await chrome.scripting.executeScript({ target, files: FILES });
    const [{ result }] = await chrome.scripting.executeScript({ target, func: () => globalThis.chatGPTListConversations() });
    if (!result?.ok) throw new Error(result?.error || t("errListFailed"));
    conversations = result.items;
    const known = new Set(conversations.map(item => item.id));
    for (const id of selected) if (!known.has(id)) selected.delete(id);
    const current = chatIdOf(tab);
    if (!selected.size && current && known.has(current)) selected.add(current);
    renderProjects();
    listState = "ready";
  } catch (error) {
    listState = "error";
    listError = error.message;
  }
  renderList();
  refresh();
}

for (const id of ["#pick-search", "#pick-from", "#pick-to"]) $(id).addEventListener("input", renderList);
$("#pick-filter").addEventListener("change", renderList);
for (const id of ["#pick-search", "#pick-from", "#pick-to"]) $(id).addEventListener("keydown", event => { if (event.key === "Enter") event.preventDefault(); }); // formu göndermesin
$("#pick-reload").addEventListener("click", () => loadList(true));
$("#pick-all").addEventListener("click", () => { visibleIds().forEach(id => selected.add(id)); renderList(); refresh(); });
$("#pick-none").addEventListener("click", () => { visibleIds().forEach(id => selected.delete(id)); renderList(); refresh(); });
$("#pick-list").addEventListener("change", event => {
  const input = event.target;
  if (input.checked) selected.add(input.value); else selected.delete(input.value);
  renderList();
  refresh();
});

// ---- İlerleme (sohbet sekmesinden gelen mesajlar) ----
function renderProgress() {
  const box = $("#progress");
  const entry = tab ? progressByTab.get(tab.id) : null;
  box.hidden = !entry;
  if (!entry) return;
  box.dataset.state = entry.state;
  $("#progress-text").textContent = entry.message;
  const bar = $("#progress-bar");
  if (typeof entry.fraction === "number") bar.value = entry.fraction; else bar.removeAttribute("value");
  $("#cancel").hidden = entry.state !== "running";
}

function renderBackupInfo() {
  const count = Object.keys(backupState).length;
  $("#incremental-info").textContent = count ? t("incrementalInfo", [String(count)]) : t("incrementalHint");
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "csi-progress" || !sender.tab || sender.id !== chrome.runtime.id) return;
  progressByTab.set(sender.tab.id, { state: message.state, message: String(message.message || ""), fraction: message.fraction });
  if (message.state === "done" && Array.isArray(message.exported) && message.exported.length) {
    for (const item of message.exported) if (item?.id && item.update_time) backupState[item.id] = item.update_time;
    chrome.storage.local.set({ backupState }).catch(() => {});
    renderBackupInfo();
  }
  if (tab && sender.tab.id === tab.id) { renderProgress(); refresh(); }
});

$("#cancel").addEventListener("click", () => {
  if (tab) chrome.tabs.sendMessage(tab.id, { type: "csi-cancel" }).catch(() => {});
});

$("#page-button").addEventListener("change", event => chrome.storage.local.set({ pageButton: event.target.checked }).catch(() => {}));
$("#reset-backup").addEventListener("click", () => {
  backupState = {};
  chrome.storage.local.set({ backupState }).catch(() => {});
  renderBackupInfo();
  setStatus(t("resetBackupDone"));
});

// Kapsama ve seçimlere göre arayüzü ve düğme durumunu günceller.
function refresh() {
  const options = currentOptions();
  const { scope, formats, attachments, saveMode } = options;
  const all = scope === "all";
  const choose = scope === "choose";
  const current = scope === "current";
  const messagesOnly = current && options.messagesOnly;
  form.elements.attachments.disabled = all;
  $("#attachment-fieldset").hidden = all;
  $("#text-mode").hidden = all || !attachments || !formats.some(format => ["md", "html", "docx", "pdf"].includes(format));
  $("#bulk-note").hidden = !all;
  $("#picker").hidden = !choose;
  $("#messages").hidden = !current;
  $("#msg-picker").hidden = !messagesOnly;
  $("#incremental-row").hidden = current;
  $("#pdf-note").hidden = !formats.includes("pdf");
  $("#folder-row").hidden = saveMode !== "folder";
  $("#folder-note").hidden = saveMode !== "folder";
  $("#download-label").textContent = choose ? t("pickStart", [String(selected.size)]) : t("downloadButton");
  const kind = pageKind(tab);
  const running = progressByTab.get(tab?.id)?.state === "running";
  const ready = current ? kind === "chat" || kind === "share" : kind !== "other";
  const problem = !ready ? (current ? "errOpenChat" : "errWrongSite")
    : formats.length === 0 && !options.gallery ? "errNoFormat"
    : choose && selected.size === 0 && listState === "ready" ? "errNoSelection"
    : messagesOnly && messageState === "ready" && selectedMessages.size === 0 ? "errNoMessages"
    : saveMode === "folder" && !folderHandle ? "errNoFolder" : "";
  button.disabled = Boolean(problem) || running || (choose && selected.size === 0) || (messagesOnly && messageState !== "ready");
  if (problem) {
    setStatus(t(problem), true);
    hintShown = true;
  } else if (hintShown) {
    setStatus("");
    hintShown = false;
  }
}

form.addEventListener("change", event => {
  if (event.target.closest("#picker, #msg-list") || event.target.id === "page-button") return;
  saveSettings();
  refresh();
  const options = currentOptions();
  if (options.scope === "choose") loadList();
  if (options.scope === "current" && options.messagesOnly) loadMessages();
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  button.disabled = true;
  setStatus(t("statusStarting"));
  hintShown = false;
  try {
    const options = currentOptions();
    // Klasör izni kullanıcı eyleminin hemen ardından istenmeli.
    if (options.saveMode === "folder") await ensureFolderPermission();
    const kind = pageKind(tab);
    if (kind === "other" || (options.scope === "current" && kind !== "chat" && kind !== "share")) throw new Error(t(options.scope === "current" ? "errOpenChat" : "errWrongSite"));
    if (options.scope === "choose") options.selection = conversations.filter(item => selected.has(item.id));
    if (options.scope === "current" && options.messagesOnly) options.messageIds = [...selectedMessages];
    if (options.scope !== "current" && options.incremental) options.known = backupState;
    const target = { tabId: tab.id };
    await chrome.scripting.executeScript({ target, files: FILES });
    const [{ result }] = await chrome.scripting.executeScript({ target, func: opts => globalThis.chatGPTExporter(opts), args: [options] });
    if (!result?.started) throw new Error(result?.error || t("errCouldNotStart"));
    progressByTab.set(tab.id, { state: "running", message: t("statusStarted"), fraction: null });
    setStatus("");
    renderProgress();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    refresh();
  }
});

// ---- Aktif sekmeyi izleme ----
async function setTab(next) {
  const previous = tab;
  tab = next;
  renderTabInfo();
  renderProgress();
  const options = currentOptions();
  if (pageKind(previous) === "other" && pageKind(tab) !== "other" && options.scope === "choose") loadList();
  else if (options.scope === "choose") renderList();
  if (options.scope === "current" && options.messagesOnly && chatIdOf(previous) !== chatIdOf(tab)) loadMessages();
  refresh();
}

chrome.tabs.onActivated.addListener(async info => {
  if (info.windowId !== windowId) return;
  try { setTab(await chrome.tabs.get(info.tabId)); } catch {}
});
chrome.tabs.onUpdated.addListener((tabId, change, updated) => {
  if (tab && tabId === tab.id && (change.url || change.title || change.status === "complete")) setTab(updated);
});
chrome.tabs.onRemoved.addListener(tabId => progressByTab.delete(tabId));

(async () => {
  const stored = await chrome.storage.local.get(["settings", "pageButton", "backupState"]).catch(() => ({}));
  applySettings(stored.settings);
  $("#page-button").checked = stored.pageButton !== false;
  backupState = stored.backupState || {};
  renderBackupInfo();
  try { folderHandle = await idb("readonly", store => store.get("folder")) || null; } catch {}
  renderFolder();
  windowId = (await chrome.windows.getCurrent()).id;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  await setTab(active || null);
  const options = currentOptions();
  if (options.scope === "choose") loadList();
  if (options.scope === "current" && options.messagesOnly) loadMessages();
})();
