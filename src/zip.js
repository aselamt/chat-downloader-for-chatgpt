// Bağımlılıksız ZIP üreticisi: metin dosyalarını deflate ile sıkıştırır, ekleri olduğu gibi saklar.
// ZIP32 kullanır; 4 GB / 65535 dosya sınırı aşılırsa açık bir hata verir.
(() => {
  const encoder = new TextEncoder();
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const ALREADY_COMPRESSED = /\.(zip|gz|7z|rar|png|jpe?g|webp|gif|heic|mp3|m4a|mp4|webm|ogg|pdf|docx|xlsx|pptx)$/i;
  const LIMIT = 0xffffffff;

  function crc32(data) {
    let crc = -1;
    for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 255] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  }

  async function deflate(data) {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function dosStamp(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  // items: [{ name, data: Uint8Array, date?: Date }] → Blob
  async function createZip(items, { signal, onProgress } = {}) {
    if (items.length >= 65535) throw new Error("ZIP32 file count limit exceeded");
    const chunks = [], central = [];
    let offset = 0, done = 0;
    for (const item of items) {
      signal?.throwIfAborted();
      const name = encoder.encode(item.name);
      const size = item.data.length;
      const crc = crc32(item.data);
      let method = 0, body = item.data;
      if (size > 256 && !ALREADY_COMPRESSED.test(item.name)) {
        const packed = await deflate(item.data);
        if (packed.length < size) { method = 8; body = packed; }
      }
      if (offset + body.length + name.length + 30 >= LIMIT) throw new Error("ZIP32 size limit exceeded");
      const { time, date } = dosStamp(item.date || new Date());
      const local = new Uint8Array(30), lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x800, true);
      lv.setUint16(8, method, true); lv.setUint16(10, time, true); lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, body.length, true); lv.setUint32(22, size, true);
      lv.setUint16(26, name.length, true);
      const header = new Uint8Array(46), cv = new DataView(header.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x800, true); cv.setUint16(10, method, true); cv.setUint16(12, time, true);
      cv.setUint16(14, date, true); cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true);
      cv.setUint32(24, size, true); cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
      chunks.push(local, name, body);
      central.push(header, name);
      offset += local.length + name.length + body.length;
      onProgress?.(++done, items.length);
    }
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    if (offset + centralSize + 22 >= LIMIT) throw new Error("ZIP32 size limit exceeded");
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, items.length, true); ev.setUint16(10, items.length, true);
    ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, end], { type: "application/zip" });
  }

  const api = { createZip, crc32 };
  (globalThis.__csi ||= {}).zip = api;
  if (typeof module !== "undefined") module.exports = api;
})();
