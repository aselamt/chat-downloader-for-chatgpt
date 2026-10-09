# Gizlilik Politikası / Privacy Policy

**Son güncelleme / Last updated:** 2026-10-04

## Türkçe

**ChatGPT için Sohbet İndir** ("Eklenti"), ChatGPT sohbetlerinizi kendi cihazınıza dosya olarak kaydetmenizi sağlar.

**Topladığımız veri:** Hiçbiri. Eklenti geliştiricisi olarak sizden veya kullanımınızdan hiçbir veri toplamayız, saklamayız, satmayız ya da paylaşmayız. Analitik, reklam, izleme veya uzak sunucu yoktur.

**Eklenti ne yapar:**
- Arayüzü tarayıcının yan panelinde açılır. Dışa aktarma kodu yalnızca siz bir işlem başlattığınızda (İndir düğmesi, sayfadaki "İndir" düğmesi, sağ tık menüsü veya listeyi açma) açık olan `chatgpt.com` sekmesinde çalışır.
- Sohbetinizi ve eklerini, zaten oturum açmış olduğunuz hesabınızla `chatgpt.com` sunucularından (ve ChatGPT'nin ek dosyaları için verdiği indirme adreslerinden) tarayıcınız üzerinden alır. Bu istekler doğrudan tarayıcınızdan ChatGPT'ye gider; bizim sunucumuzdan geçmez.
- Dosyaları (PDF, Word ve ZIP dahil) tarayıcınızın belleğinde oluşturur ve bilgisayarınıza indirir ya da yalnızca sizin seçtiğiniz klasöre yazar. PDF, eklentinin kendi sayfasında tarayıcının yazdırma özelliğiyle oluşturulur; hiçbir sunucuya gönderilmez.
- Oturum belirteci yalnızca `chatgpt.com` isteklerinde kullanılır; başka hiçbir adrese gönderilmez, kaydedilmez.

**Cihazınızda yerel olarak saklananlar:** (`chrome.storage` ve eklentinin IndexedDB'si; yalnızca tarayıcınızda)
- Seçtiğiniz biçim/seçenekler ve sayfa düğmesi tercihi.
- Artımlı yedek için: daha önce dışa aktarılan sohbetlerin kimlikleri ve son güncellenme zamanları (sohbet içeriği değil). Yan panelden "Yedek geçmişini sıfırla" ile silinebilir.
- "Klasöre kaydet" için seçtiğiniz klasörün tarayıcı tanıtıcısı. Eklenti bu klasöre yalnızca sizin izninizle yazar.

**İzinler:** `sidePanel` (yan panel arayüzü), `scripting` (dışa aktarma kodunu chatgpt.com sekmesinde çalıştırmak), `storage` (yukarıdaki yerel ayarlar), `contextMenus` (chatgpt.com'da sağ tık menüsü) ve yalnızca `https://chatgpt.com/*` için site erişimi; aynı sitede sohbet başlığına isteğe bağlı bir "İndir" düğmesi ekleyen küçük bir içerik betiği. Eklenti başka hiçbir siteye erişmez.

**Üçüncü taraf bileşenler:** Formül çizimi için pakete gömülü KaTeX (MIT lisansı) kullanılır; ağdan hiçbir şey yüklenmez.

**Üçüncü taraflar:** Veri paylaşımı yoktur. İndirdiğiniz dosyaların (sohbetlerinizin) sonraki kullanımı sizin sorumluluğunuzdadır.

**İlişki:** Eklenti OpenAI ile bağlantılı, onaylı veya desteklenen bir ürün değildir. "ChatGPT", OpenAI'nin ticari markasıdır. Eklenti ChatGPT'nin resmî olmayan dahili uç noktalarını kullanır; bunlar değişebilir.

**Değişiklikler:** Politika değişirse bu sayfa güncellenir.

**İletişim:** Soru ve sorunlar için: https://github.com/aselamt/chatgpt-sohbet-indir/issues

## English

**Chat Downloader for ChatGPT** (the "Extension") lets you save your ChatGPT conversations to your own device.

**Data we collect:** None. As the developer we do not collect, store, sell or share any data about you or your usage. There is no analytics, advertising, tracking or remote server.

**What the Extension does:**
- Its UI opens in the browser side panel. The export code runs in the open `chatgpt.com` tab only when you start an action (the Download button, the on-page "Download" button, the right-click menu, or opening a list).
- It fetches your conversation and attachments from `chatgpt.com` (and the download URLs ChatGPT provides for attachments) through your browser, using the account you are already signed in to. These requests go directly from your browser to ChatGPT; they do not pass through any server of ours.
- It builds the files (including PDF, Word and ZIP) in your browser's memory and downloads them to your computer, or writes them only to a folder you choose. PDFs are created on the Extension's own page with your browser's print feature; nothing is sent to a server.
- The session token is used only for `chatgpt.com` requests; it is never sent anywhere else and never stored.

**Stored locally on your device:** (`chrome.storage` and the Extension's IndexedDB; in your browser only)
- Your chosen formats/options and the on-page button preference.
- For incremental backups: the IDs and last-updated times of previously exported conversations (not their content). You can clear this with "Reset backup history" in the side panel.
- The browser handle of the folder you chose for "Save to a folder". The Extension writes to it only with your permission.

**Permissions:** `sidePanel` (side panel UI), `scripting` (run the export code in the chatgpt.com tab), `storage` (the local settings above), `contextMenus` (right-click menu on chatgpt.com) and site access to `https://chatgpt.com/*` only, including a small content script that adds an optional "Download" button to the chat header on that site. The Extension accesses no other site.

**Third-party components:** KaTeX (MIT license) is bundled in the package for rendering math; nothing is loaded from the network.

**Third parties:** No data is shared. What you do with the downloaded files (your conversations) is your responsibility.

**Affiliation:** The Extension is not affiliated with, endorsed by or sponsored by OpenAI. "ChatGPT" is a trademark of OpenAI. The Extension relies on ChatGPT's unofficial internal endpoints, which may change.

**Changes:** This page will be updated if the policy changes.

**Contact:** For questions and issues: https://github.com/aselamt/chatgpt-sohbet-indir/issues
