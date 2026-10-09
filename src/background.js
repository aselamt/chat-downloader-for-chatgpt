// Arka plan: yan panel davranışı, kısayol, sağ tık menüsü, sayfadaki "İndir" düğmesi ve PDF yazdırma sekmesi.
const t = key => chrome.i18n.getMessage(key) || key;
const FILES = ["vendor/katex.min.js", "src/zip.js", "src/markdown.js", "src/render.js", "src/docx.js", "src/core.js", "src/exporter.js"];
const CHAT_LINK = /^https:\/\/chatgpt\.com\/(?:g\/[^/]+\/)?c\/([a-f0-9-]{36})(?:[/?#]|$)/i;
const DEFAULTS = { formats: ["md", "html"], attachments: true, textMode: "1", steps: false, obsidian: false, gallery: false };
const prints = new Map(); // id → yazdırma HTML'i (print.html bir kez okur)

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "csi-export-link", title: t("menuExportLink"), contexts: ["link"], targetUrlPatterns: ["https://chatgpt.com/c/*", "https://chatgpt.com/g/*/c/*"] });
    chrome.contextMenus.create({ id: "csi-export-page", title: t("menuExportPage"), contexts: ["page"], documentUrlPatterns: ["https://chatgpt.com/c/*", "https://chatgpt.com/g/*", "https://chatgpt.com/share/*"] });
    chrome.contextMenus.create({ id: "csi-open-panel", title: t("menuOpenPanel"), contexts: ["page", "link"], documentUrlPatterns: ["https://chatgpt.com/*"] });
  });
});

// Son yan panel ayarlarıyla açık (veya bağlantısı verilen) sohbeti indirir. Klasör modu yalnızca yan panelden çalışır.
async function quickExport(tab, conversationId = null) {
  if (!tab?.id) return;
  const { settings = {} } = await chrome.storage.local.get("settings");
  const options = { ...DEFAULTS, ...settings, scope: "current", saveMode: "zip", conversationId };
  delete options.selection;
  delete options.messageIds;
  if (!options.formats?.length) options.formats = DEFAULTS.formats;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: FILES });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: opts => globalThis.chatGPTExporter(opts), args: [options] });
  } catch (error) {
    console.warn("Sohbet İndir:", error.message);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "csi-open-panel" && tab) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  else if (info.menuItemId === "csi-export-link") quickExport(tab, info.linkUrl?.match(CHAT_LINK)?.[1] || null);
  else if (info.menuItemId === "csi-export-page") quickExport(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "open-side-panel" && tab?.windowId !== undefined) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Yalnızca bu eklentinin kendi betiklerinden gelen mesajlar işlenir.
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "csi-quick-export" && sender.tab) {
    quickExport(sender.tab);
  } else if (message?.type === "csi-print" && typeof message.html === "string") {
    const id = crypto.randomUUID();
    prints.set(id, message.html);
    setTimeout(() => prints.delete(id), 10 * 60 * 1000);
    chrome.tabs.create({ url: chrome.runtime.getURL(`print.html#${id}`), index: sender.tab ? sender.tab.index + 1 : undefined })
      .then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  } else if (message?.type === "csi-print-get") {
    const html = prints.get(message.id);
    prints.delete(message.id);
    sendResponse({ html: html ?? null });
  }
});
