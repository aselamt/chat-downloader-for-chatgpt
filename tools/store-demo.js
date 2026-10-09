// Store görselleri için gerçekçi demo dışa aktarma (çok sohbetli kenar çubuğu): node tools/store-demo.js <klasör> [tr|en]
const fs = require("fs");
const path = require("path");
globalThis.katex = require("../vendor/katex.min.js");
require("./../src/zip.js");
require("./../src/markdown.js");
const render = require("./../src/render.js");
const { tr, en } = require("./locales.js");
const lang = process.argv[3] === "en" ? "en" : "tr";
const m = lang === "en" ? en : tr;
const t = (k, s = []) => m[k].replace(/\{(\d)\}/g, (_, n) => s[n - 1] ?? "");
const text = (id, role, parts, parent, meta = {}) => ({ id, parent, message: { id, author: { role }, create_time: 1760000000 + Object.keys(meta).length, content: { content_type: "text", parts }, metadata: meta } });
const copy = lang === "en" ? {
  title: "Reverse a list in Python",
  q: "What is the cleanest way to reverse a list in Python?",
  a: "There are three common ways, depending on whether you want to **modify** the list or create a **new** one:\n\n| Method | Modifies original? |\n|---|---|\n| `list.reverse()` | yes |\n| `reversed(list)` | no (iterator) |\n| `list[::-1]` | no (copy) |\n\n```python\nnumbers = [1, 2, 3]\nnumbers.reverse()      # in place\nprint(numbers)         # [3, 2, 1]\n```\n\nFor most code, `reversed()` is the most readable choice. Reversing takes \\(O(n)\\) time:\n\n\\[ T(n) = \\sum_{i=1}^{n} 1 = n \\]"
} : {
  title: "Python'da listeyi ters çevirme",
  q: "Python'da bir listeyi ters çevirmenin en temiz yolu nedir?",
  a: "Listeyi **değiştirmek** ya da **yeni** bir liste üretmek istemene göre üç yaygın yol var:\n\n| Yöntem | Orijinali değiştirir mi? |\n|---|---|\n| `list.reverse()` | evet |\n| `reversed(list)` | hayır (yineleyici) |\n| `list[::-1]` | hayır (kopya) |\n\n```python\nsayilar = [1, 2, 3]\nsayilar.reverse()      # yerinde\nprint(sayilar)         # [3, 2, 1]\n```\n\nÇoğu kodda en okunaklı seçenek `reversed()` olur. Ters çevirme \\(O(n)\\) sürer:\n\n\\[ T(n) = \\sum_{i=1}^{n} 1 = n \\]"
};
const conversation = { title: copy.title, create_time: 1760000000, update_time: 1760000100, current_node: "a", mapping: {
  u: text("u", "user", [copy.q], null),
  a: text("a", "assistant", [copy.a], "u", { model_slug: "gpt-5" })
} };
const titles = lang === "en"
  ? [copy.title, "Weekly meal plan", "Draft a cover letter", "Explain Docker volumes", "Trip to Lisbon: 3 days", "Regex for email validation", "Birthday gift ideas", "Summarize meeting notes"]
  : [copy.title, "Haftalık yemek planı", "Ön yazı taslağı", "Docker volume nedir?", "Lizbon gezisi: 3 gün", "E-posta doğrulama regex'i", "Doğum günü hediye fikirleri", "Toplantı notlarını özetle"];
const doc = render.buildDocument(conversation, { t, report: { attachments: [] }, inlineText: new Map(), includeSteps: false });
const out = process.argv[2];
const chats = titles.map((title, i) => ({ t: title, h: `sohbetler/2025-10-0${i + 1}-demo-${i}/conversation.html`, d: `2025-10-0${i + 1}` }));
for (const dir of ["assets", path.dirname(chats[0].h)]) fs.mkdirSync(path.join(out, dir), { recursive: true });
fs.writeFileSync(path.join(out, "assets/chats.js"), render.chatsData(chats));
fs.writeFileSync(path.join(out, chats[0].h), render.toHtml(doc, { t, exportedAt: "", lang, layout: { mode: "multi", root: "../../", current: chats[0].h } }));
