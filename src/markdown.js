// Küçük, güvenli Markdown ayrıştırıcısı: kaynak → blok/satır içi sözdizimi ağacı → HTML.
// Word (docx.js) aynı ağacı kullanır. Formüller (\( \), \[ \], $$ $$) kod dışında ayıklanır;
// KaTeX yüklüyse MathML'e çevrilir (yazı tipi gerekmez), değilse kod olarak gösterilir.
// Dipnot işaretleri (\u0002F<n>\u0002) render.js tarafından metne yerleştirilir.
(() => {
  const ns = globalThis.__csi ||= {};
  const MATH = /\u0001M(\d+)\u0001/;
  const escapeHtml = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  // Kod blokları ve satır içi kod dışında kalan formülleri bulur. replace(tex, display) dönüşünü yerine koyar.
  const SCAN = /(^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\3[`~]*[ \t]*(?=\n|$)|$)|(`+)[^`\n][\s\S]*?\4(?!`)|\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)/g;
  function mapMath(source, replace) {
    return String(source).replace(SCAN, (match, _a, _b, fence, tick, display1, display2, inline) => {
      if (fence || tick) return match;
      if (display1 !== undefined || display2 !== undefined) return replace((display1 ?? display2).trim(), true);
      return replace(inline.trim(), false);
    });
  }

  // Obsidian / GitHub / Typora uyumlu formül sözdizimi: \( x \) → $x$, \[ x \] → $$x$$
  const dollarMath = source => mapMath(source, (tex, display) => display ? `$$\n${tex}\n$$` : `$${tex}$`);

  function renderMath(tex, display) {
    const katex = globalThis.katex;
    if (katex?.renderToString) {
      try {
        const html = katex.renderToString(tex, { output: "mathml", displayMode: display, throwOnError: false, strict: "ignore", trust: false });
        return display ? `<div class="math-display">${html}</div>` : html;
      } catch {}
    }
    return `<code class="math">${escapeHtml(display ? `\\[${tex}\\]` : `\\(${tex}\\)`)}</code>`;
  }

  // ---- Blok ayrıştırma ----
  const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const splitRow = row => row.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
  const startsBlock = line => /^\s*(`{3,}|~{3,})/.test(line) || /^#{1,6}\s/.test(line) || /^\s*>/.test(line) || LIST_ITEM.test(line) || HR.test(line);

  function parseBlocks(source) {
    const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/);
      if (fence) {
        const marker = fence[1];
        const close = new RegExp(`^\\s*${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
        const body = [];
        for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
        i++;
        blocks.push({ type: "code", lang: fence[2] || "", text: body.join("\n") });
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (heading) { blocks.push({ type: "heading", level: heading[1].length, text: heading[2] }); i++; continue; }
      if (HR.test(line)) { blocks.push({ type: "hr" }); i++; continue; }
      if (/^\s*>/.test(line)) {
        const quote = [];
        for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ""));
        blocks.push({ type: "quote", children: parseBlocks(quote.join("\n")) });
        continue;
      }
      if (line.includes("|") && TABLE_RULE.test(lines[i + 1] || "")) {
        const head = splitRow(line);
        const rows = [];
        for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(splitRow(lines[i]));
        blocks.push({ type: "table", head, rows });
        continue;
      }
      const first = line.match(LIST_ITEM);
      if (first) {
        const base = first[1].length;
        const ordered = /\d/.test(first[2]);
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(LIST_ITEM);
          if (m && m[1].length === base) { items.push([m[3]]); i++; }
          else if (m && m[1].length > base && items.length) { items.at(-1).push(lines[i].slice(base + 2)); i++; }
          else if (lines[i].trim() && /^\s/.test(lines[i]) && items.length) { items.at(-1).push(lines[i].trim()); i++; }
          else break;
        }
        blocks.push({ type: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items: items.map(item => parseBlocks(item.join("\n"))) });
        continue;
      }
      const paragraph = [];
      for (; i < lines.length && lines[i].trim() && (paragraph.length === 0 || !startsBlock(lines[i])); i++) paragraph.push(lines[i]);
      blocks.push({ type: "para", text: paragraph.join("\n") });
    }
    return blocks;
  }

  // ---- Satır içi ayrıştırma ----
  const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([\s\S]+?)\*\*|~~([^~\n]+)~~|(?<![*\w])\*(?![\s*])([^*\n]+?)\*(?!\*)|\u0001M(\d+)\u0001|\u0002F(\d+)\u0002/g;
  function parseInline(text) {
    const nodes = [];
    const source = String(text);
    let last = 0;
    for (const m of source.matchAll(INLINE)) {
      if (m.index > last) nodes.push({ t: "text", v: source.slice(last, m.index) });
      last = m.index + m[0].length;
      if (m[1]) nodes.push({ t: "code", v: m[2].trim() });
      else if (m[4] !== undefined) nodes.push({ t: "img", alt: m[3], src: m[4], raw: m[0] });
      else if (m[6] !== undefined) nodes.push({ t: "link", href: m[6], c: parseInline(m[5]), raw: m[0] });
      else if (m[7] !== undefined) nodes.push({ t: "strong", c: parseInline(m[7]) });
      else if (m[8] !== undefined) nodes.push({ t: "del", c: parseInline(m[8]) });
      else if (m[9] !== undefined) nodes.push({ t: "em", c: parseInline(m[9]) });
      else if (m[10] !== undefined) nodes.push({ t: "math", i: Number(m[10]) });
      else if (m[11] !== undefined) nodes.push({ t: "fn", n: Number(m[11]) });
    }
    if (last < source.length) nodes.push({ t: "text", v: source.slice(last) });
    return nodes;
  }

  const SAFE_LINK = /^(?:https?:\/\/|mailto:|ekler\/|#)/i;
  const LOCAL_IMAGE = /^ekler\/[^:"]*$/;
  const plain = nodes => nodes.map(n => n.v ?? (n.c ? plain(n.c) : "")).join("");

  // ---- HTML ----
  // ctx: { math: [{tex, display}], img(src) → url|null, fn(n) → html, codeCard(lang, text) → html }
  function inlineHtml(nodes, ctx) {
    return nodes.map(n => {
      switch (n.t) {
        case "text": return escapeHtml(n.v);
        case "code": return `<code>${escapeHtml(n.v)}</code>`;
        case "strong": return `<strong>${inlineHtml(n.c, ctx)}</strong>`;
        case "em": return `<em>${inlineHtml(n.c, ctx)}</em>`;
        case "del": return `<del>${inlineHtml(n.c, ctx)}</del>`;
        case "math": { const m = ctx.math[n.i]; return m ? renderMath(m.tex, m.display) : ""; }
        case "fn": return ctx.fn ? ctx.fn(n.n) : "";
        case "link": return SAFE_LINK.test(n.href)
          ? `<a href="${escapeHtml(n.href)}" rel="noopener noreferrer" target="_blank">${inlineHtml(n.c, ctx)}</a>` : escapeHtml(n.raw);
        case "img": {
          const url = LOCAL_IMAGE.test(n.src) ? (ctx.img ? ctx.img(n.src) : n.src) : null;
          if (url) return `<img alt="${escapeHtml(n.alt)}" src="${escapeHtml(url)}">`;
          return SAFE_LINK.test(n.src) ? `!<a href="${escapeHtml(n.src)}" rel="noopener noreferrer" target="_blank">${escapeHtml(n.alt || n.src)}</a>` : escapeHtml(n.raw);
        }
        default: return "";
      }
    }).join("");
  }

  function blocksHtml(blocks, ctx) {
    return blocks.map(block => {
      switch (block.type) {
        case "code": return ctx.codeCard(block.lang, block.text);
        case "heading": return `<h${block.level}>${inlineHtml(parseInline(block.text), ctx)}</h${block.level}>`;
        case "hr": return "<hr>";
        case "quote": return `<blockquote>${blocksHtml(block.children, ctx)}</blockquote>`;
        case "table": return `<table><thead><tr>${block.head.map(c => `<th>${inlineHtml(parseInline(c), ctx)}</th>`).join("")}</tr></thead><tbody>${
          block.rows.map(r => `<tr>${r.map(c => `<td>${inlineHtml(parseInline(c), ctx)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
        case "list": {
          const tag = block.ordered ? "ol" : "ul";
          const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
          return `<${tag}${start}>${block.items.map(item => `<li>${blocksHtml(item, ctx)}</li>`).join("")}</${tag}>`;
        }
        case "para": {
          const nodes = parseInline(block.text);
          const only = nodes.filter(n => !(n.t === "text" && !n.v.trim()));
          if (only.length === 1 && only[0].t === "math" && ctx.math[only[0].i]?.display) return inlineHtml(only, ctx);
          return `<p>${inlineHtml(nodes, ctx)}</p>`;
        }
        default: return "";
      }
    }).join("\n");
  }

  // Kaynak metni ayrıştırır: { blocks, math } (formüller yer tutucuya çevrilmiş olarak).
  function parse(source) {
    const math = [];
    const text = mapMath(String(source).replace(/[\u0000\u0001]/g, ""), (tex, display) => {
      math.push({ tex, display });
      return `\u0001M${math.length - 1}\u0001`;
    });
    return { blocks: parseBlocks(text), math };
  }

  function toHtml(source, options = {}) {
    const { blocks, math } = parse(source);
    return blocksHtml(blocks, { math, codeCard: options.codeCard || ((lang, text) => `<pre><code>${escapeHtml(text)}</code></pre>`), img: options.img, fn: options.fn });
  }

  const api = { parse, parseInline, parseBlocks, toHtml, dollarMath, mapMath, renderMath, escapeHtml, plain, SAFE_LINK, LOCAL_IMAGE, MATH };
  ns.markdown = api;
  if (typeof module !== "undefined") module.exports = api;
})();
