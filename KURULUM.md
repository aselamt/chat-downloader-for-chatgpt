# ChatGPT için Sohbet İndir (v3.0.0)

ChatGPT sohbetlerini PDF, Word, Markdown, HTML, TXT ve JSON olarak, ekleriyle birlikte indirir. Tarayıcının yan panelinde çalışır; her şey yerelde olur. Manifest V3; izinler: `sidePanel`, `scripting`, `storage`, `contextMenus` ve yalnızca `https://chatgpt.com/*`.

## Kurulum (geliştirici modu)

1. `chrome://extensions` adresini açın, sağ üstten **Geliştirici modu**'nu açın.
2. **Paketlenmemiş öğe yükle** → içinde `manifest.json` bulunan bu klasörü seçin.

## Kullanım

1. chatgpt.com'da bir sohbet açın (adres `/c/…` veya bir paylaşım bağlantısı `/share/…`).
2. Eklenti simgesine tıklayın veya **Alt+Shift+D**; yan panel açılır ve açık kalır.
3. Kapsamı seçin:
   - **Açık sohbet** — istenirse **Yalnızca seçtiğim mesajlar** ile mesajları tek tek işaretleyin (Shift+tık aralık seçer; "Yalnızca cevaplar / Yalnızca sorularım" kısayolları var).
   - **Tüm sohbetler** — eksiz; galeri açıksa yalnızca görseller iner. Arşivlenmiş ve proje sohbetleri dahildir.
   - **Sohbet seç** — listeden arayın; proje / projesiz / arşivlenmiş / GPT ve tarih aralığı filtreleriyle süzüp işaretleyin.
4. Biçimleri ve seçenekleri belirleyip **İndir**'e basın. İlerleme yan panelde ve sayfanın sağ altında görünür; **İptal** ile durdurabilirsiniz.

Ayrıca: sohbet başlığındaki **Paylaş** düğmesinin yanında bir **İndir** düğmesi (son ayarlarla indirir; Gelişmiş'ten kapatılabilir) ve chatgpt.com'da sağ tık menüsü ("Bu sohbeti indir", "Açık sohbeti indir", "Paneli aç").

## Biçimler ve seçenekler

| Seçenek | Ne yapar |
|---|---|
| Markdown | Formüller `$…$` / `$$…$$` olarak, kaynaklar dipnot (`[^1]`) olarak yazılır. |
| HTML | ChatGPT görünümünde; formüller MathML ile çizilir, kod kopyalanabilir. Toplu dışa aktarmada `index.html` ve sol panelde tüm sohbetler + arama. |
| PDF | Yeni sekmede yazdırma penceresi açılır; hedef **PDF olarak kaydet**. Görseller gömülüdür. Sunucu ve sınır yok. Birden çok sohbet tek PDF'te, her biri yeni sayfada. |
| Word (.docx) | Başlıklar, listeler, tablolar, kod, bağlantılar ve görsellerle Word belgesi. Formüller LaTeX metni olarak. |
| TXT / JSON | Düz metin / sunucunun ham verisi (tüm dallar). |
| Ekleri de indir | Yüklenen dosyalar, görseller, ChatGPT'nin ürettiği dosyalar; `sandbox:` bağlantıları ZIP'teki dosyaya çevrilir. |
| Görsel galerisi | Tüm görselleri (üretilenler dahil) `galeri.html` sayfasında toplar. |
| Obsidian uyumlu Markdown | YAML frontmatter (başlık, kaynak bağlantısı, tarihler, model, etiket) ve başlık adlı not. |
| Araç ve akıl yürütme adımları | Kod çalıştırma, web araması ve düşünme özetleri. |
| Yalnızca değişen sohbetler | "Tüm/Seç" kapsamında son yedekten beri güncellenmeyen sohbetler atlanır. |
| Kaydetme yeri: Klasör | ZIP yerine seçtiğiniz klasöre (ör. Obsidian kasası) yazar; `assets/arsiv.json` ile önceki yedeklerle birleşir ve dizinleri günceller. Yan panel açık kalmalı. |

Canvas belgeleri, Deep Research/web kaynakları (dipnot) ve üretilen görseller her biçimde korunur. Paylaşım bağlantılarında API yanıt vermezse ekrandaki mesajlar okunur (yalnızca metin).

## Çıktı yapısı

- Tek sohbet, tek biçim, ek yok → tek dosya. Aksi hâlde ZIP: `conversation.*`, `ekler/`, `galeri.html`, `indirme-raporu.json`, `OKU.txt`.
- Toplu / klasör: `sohbetler/<tarih>-<başlık>-<id>/…`, `index.md`, `index.html`, `assets/chats.js`, `assets/arsiv.json` (klasör modu), `galeri.html`.

## Diller

Türkçe, English, Deutsch, Español, Français, Italiano, Português (Brasil), Русский, 日本語, 简体中文 — tarayıcı diline göre seçilir.

## Sınırlar

- ChatGPT'nin resmî olmayan dahili uç noktalarını kullanır; değişebilir. Projeler "snorlax" uç noktasından okunur; okunamazsa sessizce atlanır. Raporu sohbetle karşılaştırın.
- Sayfadaki "İndir" düğmesi ChatGPT'nin "Paylaş" düğmesine yerleşir; arayüz değişirse görünmeyebilir (sağ tık menüsü ve yan panel çalışmaya devam eder).
- Süresi dolmuş/silinmiş ekler indirilemez. ZIP32: toplam 4 GB ve tarayıcı belleği sınırı.

## Geliştirme

```bash
node tools/locales.js        # _locales/*/messages.json üret (TR/EN: tools/locales.js, diğerleri: tools/locales/*.js)
node tools/test.js           # birim/entegrasyon testleri (ağ gerekmez; macOS'ta Word çıktısını textutil ile doğrular)
tools/build.sh               # testler + Web Store ZIP'i: dist/
# gerçek eklentiyle uçtan uca (sahte chatgpt.com sunucusu + başsız Chrome):
#   python3 tools/e2e/server.py 8765 <klasör> <cert.pem> <key.pem> &
#   node tools/e2e/extension.js "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" <klasör>
```

Üçüncü taraf: `vendor/katex.min.js` — KaTeX 0.19.0, MIT lisansı (`vendor/KATEX-LICENSE.txt`).
Gizlilik politikası: `PRIVACY.md`. Store başvuru metinleri ve simge notu: `STORE_LISTING.md`.
