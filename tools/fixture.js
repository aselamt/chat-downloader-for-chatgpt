// Test verisi: hem Node testinde hem tarayıcı e2e sayfasında kullanılır.
(() => {
const ID = "11111111-1111-1111-1111-111111111111";
const FILE_TXT = "file-AAAA1111", FILE_IMG = "file-BBBB2222", FILE_BAD = "file-CCCC3333";
const msg = (id, role, content, extra = {}) => ({ id, author: { role, ...(extra.name ? { name: extra.name } : {}) }, create_time: 1760000000, content, metadata: extra.metadata || {}, recipient: extra.recipient || "all" });
const conversation = {
  title: "Test <b>sohbet</b>", create_time: 1760000000, update_time: 1760003600, current_node: "a2",
  mapping: {
    root: { id: "root", parent: null, children: ["sys"], message: null },
    sys: { id: "sys", parent: "root", children: ["u1"], message: msg("sys", "system", { content_type: "text", parts: ["gizli"] }) },
    u1: { id: "u1", parent: "sys", children: ["a1", "a1b"], message: Object.assign(msg("u1", "user", { content_type: "multimodal_text", parts: ["Merhaba `kod` **kalın**", { content_type: "image_asset_pointer", asset_pointer: `file-service://${FILE_IMG}` }] }),
      { metadata: { attachments: [{ id: FILE_TXT, name: "notlar.txt" }, { id: FILE_BAD, name: "yok.pdf" }] } }) },
    a1b: { id: "a1b", parent: "u1", children: [], message: msg("a1b", "assistant", { content_type: "text", parts: ["Eski dal"] }) },
    a1: { id: "a1", parent: "u1", children: ["t1"], message: msg("a1", "assistant", { content_type: "code", language: "python", text: "print('```x```')" }, { recipient: "python" }) },
    t1: { id: "t1", parent: "a1", children: ["th"], message: msg("t1", "tool", { content_type: "execution_output", text: "x" }, { name: "python" }) },
    th: { id: "th", parent: "t1", children: ["a2"], message: msg("th", "assistant", { content_type: "thoughts", thoughts: [{ summary: "Düşünüyorum", content: "ayrıntı" }] }, { recipient: "all" }) },
    a2: { id: "a2", parent: "th", children: [], message: msg("a2", "assistant", { content_type: "text", parts: [
      "# Başlık\n\nİşte citeturn0search0sonuç entity[\"city\",\"Paris\",\"başkent\"] ve [dosya](sandbox:/mnt/data/sonuc.csv).\n\n- bir\n- iki\n  - iç\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script> [x](javascript:alert(1)) ![y](https://evil/x.png)\n\n```js\nconst a = '<b>';\n```" ] },
      { metadata: { model_slug: "gpt-test", content_references: [{ items: [{ url: "https://example.com/a", title: "Örnek <kaynak>" }, { url: "javascript:alert(1)", title: "kötü" }] }] } }) }
  }
};
const files = {
  [FILE_TXT]: { name: "notlar.txt", type: "text/plain", body: new TextEncoder().encode("merhaba ```içerik``` \n") },
  sandbox: { name: "sonuc.csv", type: "text/csv", body: new TextEncoder().encode("a,b\n1,2\n") },
  [FILE_IMG]: { name: "g.png", type: "image/png", body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) }
};
// e2e sahte sohbet listesi için uydurma başlıklar (arayüz diline göre; tr dışı diller en kullanır).
const chatTitles = {
  tr: ["Haftalık yemek planı", "Ön yazı taslağı", "Lizbon gezisi: 3 gün"],
  en: ["Weekly meal plan", "Draft a cover letter", "Trip to Lisbon: 3 days"]
};
const fixture = { ID, FILE_TXT, FILE_IMG, FILE_BAD, conversation, files, chatTitles };
globalThis.__fixture = fixture;
if (typeof module !== "undefined") module.exports = fixture;
})();
