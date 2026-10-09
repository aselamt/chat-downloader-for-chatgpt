// chatgpt.com content script: adds a small "Download" button next to the "Share" button in the chat header.
// Clicking it exports the open chat with the last side panel settings. It can be turned off in the side panel.
// If the ChatGPT UI changes and the "Share" button is not found, nothing is added.
(() => {
  if (globalThis.__csiPageButton) return;
  globalThis.__csiPageButton = true;
  const ID = "csi-page-button";
  const t = key => chrome.i18n.getMessage(key) || key;
  let enabled = true;
  let scheduled = false;

  function build() {
    const host = document.createElement("span");
    host.id = ID;
    host.style.cssText = "display:inline-flex;align-items:center;margin-inline-end:4px";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `button{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 12px;border:0;border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:14px;cursor:pointer}
button:hover{background:color-mix(in srgb,currentColor 9%,transparent)}button:focus-visible{outline:2px solid #2564c8;outline-offset:2px}svg{width:18px;height:18px}`;
    const button = document.createElement("button");
    button.type = "button";
    button.title = t("pageButtonTitle");
    button.setAttribute("aria-label", t("pageButtonTitle"));
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    for (const d of ["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"]) {
      const path = document.createElementNS(svgNs, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    const label = document.createElement("span");
    label.textContent = t("pageButtonLabel");
    button.append(svg, label);
    button.addEventListener("click", () => chrome.runtime.sendMessage({ type: "csi-quick-export" }).catch(() => {}));
    shadow.append(style, button);
    return host;
  }

  function place() {
    scheduled = false;
    const existing = document.getElementById(ID);
    const onChat = /\/(?:c|share(?:\/e)?)\/[a-f0-9-]{36}/i.test(location.pathname);
    const share = onChat && enabled ? document.querySelector('[data-testid="share-chat-button"]') : null;
    if (!share) { existing?.remove(); return; }
    if (existing && existing.nextElementSibling === share) return;
    existing?.remove();
    share.parentElement.insertBefore(build(), share);
  }

  const schedule = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(place); } };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  chrome.storage.local.get("pageButton").then(({ pageButton }) => { enabled = pageButton !== false; schedule(); }).catch(schedule);
  chrome.storage.onChanged.addListener(changes => {
    if (changes.pageButton) { enabled = changes.pageButton.newValue !== false; schedule(); }
  });
})();
