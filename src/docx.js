// Dependency-free Word (.docx) writer: turns the render.js document model and the markdown.js syntax tree into OOXML.
// Packaged with zip.js. Supports headings, paragraphs, bold/italic/strikethrough/code, links,
// (nested) lists, tables, code blocks, quotes, horizontal rules, footnote markers, math (as LaTeX text) and PNG/JPEG/GIF images.
(() => {
  const ns = globalThis.__csi ||= {};
  const encoder = new TextEncoder();
  const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const MAX_WIDTH_EMU = 5486400; // 6 inches

  // Characters that are invalid in XML 1.0 are removed.
  const xml = s => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function imageSize(data) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length > 24 && data[0] === 0x89 && data[1] === 0x50) return { ext: "png", w: view.getUint32(16), h: view.getUint32(20) };
    if (data.length > 10 && data[0] === 0x47 && data[1] === 0x49) return { ext: "gif", w: view.getUint16(6, true), h: view.getUint16(8, true) };
    if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
      for (let i = 2; i + 9 < data.length;) {
        if (data[i] !== 0xff) { i++; continue; }
        const marker = data[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { ext: "jpeg", w: view.getUint16(i + 7), h: view.getUint16(i + 5) };
        i += 2 + view.getUint16(i + 2);
      }
    }
    return null;
  }

  // Builds a Word package for one or more documents.
  // items: [{ doc, images: Map(archive path → Uint8Array) }]
  async function build(items, { t }) {
    const rels = [];
    const media = [];
    let drawingId = 0;
    const rel = (type, target, external) => {
      const id = `rId${rels.length + 10}`;
      rels.push(`<Relationship Id="${id}" Type="${type}" Target="${xml(target)}"${external ? ' TargetMode="External"' : ""}/>`);
      return id;
    };
    const linkRel = url => rel("http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", url, true);

    function textRuns(text, props = "") {
      const parts = String(text).split(/(\n|\t)/);
      const inner = parts.map(part => part === "\n" ? "<w:br/>" : part === "\t" ? "<w:tab/>" : part ? `<w:t xml:space="preserve">${xml(part)}</w:t>` : "").join("");
      return inner ? `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${inner}</w:r>` : "";
    }

    function picture(data, alt) {
      const size = data && imageSize(data);
      if (!size || !size.w || !size.h) return null;
      const index = media.length + 1;
      const name = `image${index}.${size.ext === "jpeg" ? "jpg" : size.ext}`;
      media.push({ name: `word/media/${name}`, data });
      const id = rel("http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", `media/${name}`);
      let cx = size.w * 9525, cy = size.h * 9525;
      if (cx > MAX_WIDTH_EMU) { cy = Math.round(cy * MAX_WIDTH_EMU / cx); cx = MAX_WIDTH_EMU; }
      const n = ++drawingId;
      return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}" descr="${xml(alt || "")}"/>`
        + `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
        + `<pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
        + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    }

    // ctx: { math, images, prefixPath }
    function inlineRuns(nodes, ctx, props = "") {
      const { SAFE_LINK, LOCAL_IMAGE, plain } = ns.markdown;
      return nodes.map(n => {
        switch (n.t) {
          case "text": return textRuns(n.v, props);
          case "code": return textRuns(n.v, `${props}<w:rStyle w:val="InlineCode"/>`);
          case "strong": return inlineRuns(n.c, ctx, `${props}<w:b/>`);
          case "em": return inlineRuns(n.c, ctx, `${props}<w:i/>`);
          case "del": return inlineRuns(n.c, ctx, `${props}<w:strike/>`);
          case "math": { const m = ctx.math[n.i]; return m ? textRuns(m.tex, `${props}<w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/><w:i/>`) : ""; }
          case "fn": return textRuns(`[${n.n}]`, `${props}<w:vertAlign w:val="superscript"/><w:color w:val="6B6B6B"/>`);
          case "link":
            if (/^(https?:|mailto:)/i.test(n.href)) return `<w:hyperlink r:id="${linkRel(n.href)}" w:history="1">${inlineRuns(n.c, ctx, `${props}<w:rStyle w:val="Hyperlink"/>`)}</w:hyperlink>`;
            return SAFE_LINK.test(n.href) ? inlineRuns(n.c, ctx, props) : textRuns(n.raw, props);
          case "img": {
            const data = LOCAL_IMAGE.test(n.src) ? ctx.images.get(decodeURIComponent(n.src)) : null;
            return picture(data, n.alt) || textRuns(n.alt || plain([n]) || n.src, props);
          }
          default: return "";
        }
      }).join("");
    }

    const para = (runs, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs}</w:p>`;
    const indent = depth => depth ? `<w:ind w:left="${360 * depth + 360}" w:hanging="360"/>` : "";

    function codeParagraph(text, lang) {
      const label = lang ? para(textRuns(lang, '<w:color w:val="6B6B6B"/><w:sz w:val="16"/>'), '<w:pStyle w:val="CodeLabel"/>') : "";
      return label + para(textRuns(text), '<w:pStyle w:val="Code"/>');
    }

    function blocksXml(blocks, ctx, depth = 0, quote = false) {
      const { parseInline } = ns.markdown;
      const style = quote ? '<w:pStyle w:val="Quote"/>' : "";
      return blocks.map(block => {
        switch (block.type) {
          case "para": return para(inlineRuns(parseInline(block.text), ctx), style + (depth ? `<w:ind w:left="${360 * depth + 360}"/>` : ""));
          case "heading": return para(inlineRuns(parseInline(block.text), ctx), `<w:pStyle w:val="Heading${Math.min(block.level, 3)}"/>`);
          case "code": return codeParagraph(block.text, block.lang);
          case "hr": return para("", '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="E5E5E5"/></w:pBdr>');
          case "quote": return blocksXml(block.children, ctx, depth, true);
          case "table": {
            const cell = (text, head) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${para(inlineRuns(parseInline(text), ctx, head ? "<w:b/>" : ""))}</w:tc>`;
            const row = (cells, head) => `<w:tr>${head ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells.map(c => cell(c, head)).join("")}</w:tr>`;
            const columns = Math.max(block.head.length, ...block.rows.map(r => r.length));
            const pad = cells => [...cells, ...Array(Math.max(0, columns - cells.length)).fill("")];
            return `<w:tbl><w:tblPr><w:tblStyle w:val="ChatTable"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${"<w:gridCol/>".repeat(columns)}</w:tblGrid>${
              row(pad(block.head), true)}${block.rows.map(r => row(pad(r), false)).join("")}</w:tbl>${para("")}`;
          }
          case "list": return block.items.map((item, index) => {
            const marker = block.ordered ? `${block.start + index}.` : "•";
            const [first, ...rest] = item;
            const head = first?.type === "para"
              ? para(textRuns(`${marker}\t`) + inlineRuns(parseInline(first.text), ctx), `${style}${indent(depth + 1)}<w:spacing w:after="40"/>`)
              : para(textRuns(`${marker}\t`), `${style}${indent(depth + 1)}`) + (first ? blocksXml([first], ctx, depth + 1, quote) : "");
            return head + blocksXml(rest, ctx, depth + 1, quote);
          }).join("");
          default: return "";
        }
      }).join("");
    }

    function markdownXml(source, ctx, quote = false) {
      const { blocks, math } = ns.markdown.parse(source);
      return blocksXml(blocks, { ...ctx, math }, 0, quote);
    }

    const bodyParts = [];
    items.forEach(({ doc, images = new Map() }, docIndex) => {
      const ctx = { images };
      const meta = [doc.created && `${t("renderCreated")}: ${doc.created}`, doc.updated && `${t("renderUpdated")}: ${doc.updated}`].filter(Boolean).join(" · ");
      bodyParts.push(para(textRuns(doc.title), `<w:pStyle w:val="Title"/>${docIndex ? '<w:pageBreakBefore/>' : ""}`));
      if (meta) bodyParts.push(para(textRuns(meta), '<w:pStyle w:val="Muted"/>'));
      for (const message of doc.messages) {
        const extra = [message.time, message.model].filter(Boolean).join(" · ");
        const speaker = message.role === "user" ? "SpeakerUser" : message.role === "step" ? "SpeakerStep" : "Speaker";
        bodyParts.push(para(textRuns(message.label) + (extra ? textRuns(`  ${extra}`, '<w:b w:val="0"/><w:color w:val="8A8A8A"/><w:sz w:val="16"/>') : ""), `<w:pStyle w:val="${speaker}"/>`));
        for (const block of message.blocks) {
          if (block.type === "text") bodyParts.push(markdownXml(block.text, ctx));
          else if (block.type === "code") bodyParts.push(codeParagraph(block.text, block.lang));
          else if (block.type === "thought") bodyParts.push(markdownXml(block.text, ctx, true));
          else if (block.type === "canvas") {
            bodyParts.push(para(textRuns(`Canvas — ${block.name}${block.updated ? ` (${t("renderCanvasUpdated")})` : ""}`), '<w:pStyle w:val="Heading3"/>'));
            bodyParts.push(block.kind.startsWith("code") ? codeParagraph(block.content, block.kind.slice(5)) : markdownXml(block.content, ctx));
          } else if (block.type === "image") {
            bodyParts.push(para(picture(block.src && images.get(block.src), block.src) || textRuns(`[${t("renderImage")}]`, '<w:color w:val="6B6B6B"/>')));
          } else if (block.type === "footnotes") {
            for (const note of block.items) {
              bodyParts.push(para(textRuns(`[${note.n}] `) + `<w:hyperlink r:id="${linkRel(note.url)}" w:history="1">${textRuns(note.title, '<w:rStyle w:val="Hyperlink"/>')}</w:hyperlink>`, '<w:pStyle w:val="Small"/>'));
            }
          } else if (block.type === "sources") {
            bodyParts.push(para(textRuns(`${t("renderSources")}:`, "<w:b/>"), '<w:pStyle w:val="Small"/>'));
            for (const s of block.items) bodyParts.push(para(textRuns("•\t") + `<w:hyperlink r:id="${linkRel(s.url)}" w:history="1">${textRuns(s.title, '<w:rStyle w:val="Hyperlink"/>')}</w:hyperlink>`, `<w:pStyle w:val="Small"/>${indent(1)}`));
          } else if (block.type === "files") {
            bodyParts.push(para(textRuns(`${t("renderAttachments")}:`, "<w:b/>"), '<w:pStyle w:val="Small"/>'));
            for (const item of block.items) {
              const label = item.skipped ? `${item.label} — ${t("renderSkipped")}` : item.href ? item.label : `${item.label} — ${t("renderFailed")}: ${item.error}`;
              bodyParts.push(para(textRuns(`•\t${label}`), `<w:pStyle w:val="Small"/>${indent(1)}`));
              if (item.text !== undefined) bodyParts.push(codeParagraph(item.text, ""));
            }
          }
        }
      }
    });

    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${bodyParts.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;

    const font = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>';
    const mono = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/>';
    const style = (id, name, pPr, rPr, type = "paragraph") => `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${name}"/>${type === "paragraph" ? '<w:basedOn w:val="Normal"/>' : ""}<w:qFormat/>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}</w:style>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${NS_W}"><w:docDefaults><w:rPrDefault><w:rPr>${font}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="tr-TR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${style("Title", "Title", '<w:spacing w:after="60"/>', "<w:b/><w:sz w:val=\"40\"/>")}
${style("Heading1", "heading 1", '<w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="0"/>', '<w:b/><w:sz w:val="32"/>')}
${style("Heading2", "heading 2", '<w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/>', '<w:b/><w:sz w:val="28"/>')}
${style("Heading3", "heading 3", '<w:keepNext/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="2"/>', '<w:b/><w:sz w:val="24"/>')}
${style("Speaker", "Speaker", '<w:keepNext/><w:spacing w:before="280" w:after="60"/><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="E5E5E5"/></w:pBdr>', '<w:b/><w:color w:val="0D0D0D"/>')}
${style("SpeakerUser", "Speaker (user)", '<w:keepNext/><w:spacing w:before="280" w:after="60"/><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="E5E5E5"/></w:pBdr>', '<w:b/><w:color w:val="10A37F"/>')}
${style("SpeakerStep", "Speaker (step)", '<w:keepNext/><w:spacing w:before="160" w:after="40"/>', '<w:i/><w:color w:val="6B6B6B"/><w:sz w:val="18"/>')}
${style("Code", "Code", '<w:spacing w:after="160" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F4F4F4"/><w:ind w:left="120" w:right="120"/>', `${mono}<w:sz w:val="18"/>`)}
${style("CodeLabel", "Code label", '<w:keepNext/><w:spacing w:after="0"/><w:shd w:val="clear" w:color="auto" w:fill="ECECEC"/><w:ind w:left="120" w:right="120"/>', "")}
${style("Quote", "Quote", '<w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="DDDDDD"/></w:pBdr>', '<w:i/><w:color w:val="555555"/>')}
${style("Muted", "Muted", '<w:spacing w:after="240"/>', '<w:color w:val="6B6B6B"/><w:sz w:val="18"/>')}
${style("Small", "Small", '<w:spacing w:after="40"/>', '<w:sz w:val="18"/><w:color w:val="444444"/>')}
${style("Hyperlink", "Hyperlink", "", '<w:color w:val="2564C8"/><w:u w:val="single"/>', "character")}
${style("InlineCode", "Inline code", "", `${mono}<w:sz w:val="19"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>`, "character")}
<w:style w:type="table" w:styleId="ChatTable"><w:name w:val="Chat table"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="E5E5E5"/><w:bottom w:val="single" w:sz="4" w:color="E5E5E5"/><w:insideH w:val="single" w:sz="4" w:color="E5E5E5"/></w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

    const title = items.length === 1 ? items[0].doc.title : t("bulkIndexTitle");
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>ChatGPT</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
    const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${rels.join("")}</Relationships>`;

    const text = (name, value) => ({ name, data: encoder.encode(value) });
    const blob = await ns.zip.createZip([
      text("[Content_Types].xml", contentTypes), text("_rels/.rels", rootRels), text("docProps/core.xml", core),
      text("word/document.xml", document), text("word/styles.xml", styles), text("word/_rels/document.xml.rels", documentRels), ...media
    ]);
    return new Uint8Array(await blob.arrayBuffer());
  }

  const api = { build, imageSize };
  ns.docx = api;
  if (typeof module !== "undefined") module.exports = api;
})();
