"""Store görselleri: python3 tools/make-store-assets.py <ham-görseller-klasörü>
Girdi (Chrome ekran görüntüleri; tools/e2e/extension.js ve tools/store-demo.js üretir):
  panel-current-light[-en].png, panel-choose-light[-en].png, demo-{tr,en}.png"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os, sys

src = sys.argv[1]
root = os.path.join(os.path.dirname(__file__), "..")
out = os.path.join(root, "store")
FONT = "/System/Library/Fonts/Helvetica.ttc"
def font(size, bold=False): return ImageFont.truetype(FONT, size, index=1 if bold else 0)

def background(w, h):
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        k = y / h
        d.line([(0, y), (w, y)], fill=(int(244 - 22 * k), int(244 - 22 * k), int(244 - 22 * k)))
    return img

def shadowed(base, layer, xy, radius=18):
    pad = 40
    shadow = Image.new("RGBA", (layer.width + pad * 2, layer.height + pad * 2), (0, 0, 0, 0))
    mask = Image.new("L", layer.size, 255)
    shadow.paste((10, 40, 30, 90), (pad, pad + 10), mask)
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    base.paste(shadow, (xy[0] - pad, xy[1] - pad), shadow)
    rounded = Image.new("L", layer.size, 0)
    ImageDraw.Draw(rounded).rounded_rectangle([0, 0, layer.width - 1, layer.height - 1], radius=radius, fill=255)
    base.paste(layer.convert("RGB"), xy, rounded)

def wrap(text, fnt, width, draw):
    lines, line = [], ""
    for word in text.split():
        trial = (line + " " + word).strip()
        if draw.textlength(trial, font=fnt) <= width: line = trial
        else: lines.append(line); line = word
    return lines + [line]

def caption(img, title, sub, x, y, width, size=54):
    d = ImageDraw.Draw(img)
    for line in wrap(title, font(size, True), width, d):
        d.text((x, y), line, font=font(size, True), fill=(13, 13, 13)); y += size + 12
    y += 14
    for line in wrap(sub, font(22), width, d):
        d.text((x, y), line, font=font(22), fill=(107, 107, 107)); y += 32

def icon(img, xy, size):
    ic = Image.open(os.path.join(root, "icons", "icon512.png")).resize((size, size), Image.LANCZOS)  # eklentinin kendi simgesi
    img.paste(ic, xy, ic)

texts = {
    "tr": [("Sohbetinin hemen yanında.", "Yan panelden açık sohbeti, tüm sohbetlerini ya da seçtiklerini PDF, Word, Markdown veya HTML olarak ekleriyle indir. Formüller ve kaynaklar korunur."),
           ("ChatGPT arayüzünde HTML.", "Sol panelde sohbetlerin, arama, kod blokları ve tablolar. Açık/koyu temaya uyar; internet gerekmez."),
           ("İndireceğin sohbetleri seç.", "Tüm sohbetlerinde ara, işaretle ve yalnızca seçtiklerini ekleriyle birlikte indir. İlerlemeyi panelden izle, istersen iptal et.")],
    "en": [("Right next to your chat.", "From the side panel, download the open chat, all chats or just the ones you pick as PDF, Word, Markdown or HTML with attachments. Math and sources are kept."),
           ("HTML in the ChatGPT look.", "Your chats in the sidebar, search, code blocks and tables. Follows light/dark theme; works offline."),
           ("Choose which chats to download.", "Search all your chats, tick the ones you want and download just those with attachments. Follow progress in the panel and cancel any time.")]
}

def panel_image(name, lang):
    img = Image.open(os.path.join(src, f"{name}{'' if lang == 'tr' else '-' + lang}.png")).convert("RGB")
    scale = 700 / img.height
    return img.resize((int(img.width * scale), 700), Image.LANCZOS)

for lang in ("tr", "en"):
    for number, panel_name in ((1, "panel-current-light"), (3, "panel-choose-light")):
        img = background(1280, 800)
        icon(img, (90, 110), 72)
        title, sub = texts[lang][number - 1]
        caption(img, title, sub, 90, 220, 560, 50)
        panel = panel_image(panel_name, lang)
        shadowed(img, panel, (1280 - panel.width - 150, 50), radius=16)
        img.save(os.path.join(out, f"screenshot-{number}-{lang}.png"))
    # 2) HTML arayüzü
    demo = Image.open(os.path.join(src, f"demo-{lang}.png")).convert("RGB")
    demo = demo.resize((840, int(demo.height * 840 / demo.width)), Image.LANCZOS)
    img = background(1280, 800)
    icon(img, (60, 90), 72)
    title, sub = texts[lang][1]
    caption(img, title, sub, 60, 200, 320, 40)
    shadowed(img, demo, (1280 - 840 - 40, (800 - demo.height) // 2), radius=14)
    img.save(os.path.join(out, f"screenshot-2-{lang}.png"))

# Küçük tanıtım kutusu 440x280 (dil bağımsız)
tile = background(440, 280)
icon(tile, (30, 30), 84)
d = ImageDraw.Draw(tile)
d.text((30, 140), "Chat Downloader", font=font(34, True), fill=(13, 13, 13))
d.text((30, 184), "for ChatGPT", font=font(34, True), fill=(0, 64, 245))
d.text((30, 234), "PDF · Word · Markdown · HTML · JSON", font=font(16), fill=(107, 107, 107))
tile.save(os.path.join(out, "promo-small-440x280.png"))
print("görseller yazıldı:", sorted(f for f in os.listdir(out) if f.endswith(".png")))
