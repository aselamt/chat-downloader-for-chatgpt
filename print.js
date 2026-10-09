// PDF sayfası: arka plandan yazdırma HTML'ini alır, korumalı iframe'e koyar ve yazdırma penceresini açar.
// Hedef olarak "PDF olarak kaydet" seçilir; dönüştürme tamamen tarayıcıda yapılır, sunucu yoktur.
const t = key => chrome.i18n.getMessage(key) || key;
for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n);
document.documentElement.lang = chrome.i18n.getUILanguage();
const frame = document.querySelector("#frame");
const button = document.querySelector("#print");

function print() {
  frame.contentWindow.focus();
  frame.contentWindow.print();
}

(async () => {
  const { html } = await chrome.runtime.sendMessage({ type: "csi-print-get", id: location.hash.slice(1) });
  if (!html) {
    const error = document.querySelector("#error");
    error.textContent = t("printExpired");
    error.hidden = false;
    frame.hidden = true;
    return;
  }
  frame.addEventListener("load", async () => {
    const title = frame.contentDocument.title;
    document.title = title;
    document.querySelector("#title").textContent = title;
    await Promise.all([...frame.contentDocument.images].map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; })));
    button.disabled = false;
    setTimeout(print, 300);
  }, { once: true });
  frame.srcdoc = html;
})();
button.addEventListener("click", print);
