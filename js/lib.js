// Shared helpers for every tool. Everything here runs in the browser only.

const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
export const PDFJS_WORKER = PDFJS_CDN + 'pdf.worker.min.js';
if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

/** Open bytes with PDF.js, with the real standard fonts and CJK maps so pages render faithfully. */
export const pdfjsOpen = (data) => pdfjsLib.getDocument({
  data,
  // cdnjs doesn't carry these two folders; jsDelivr mirrors the full npm package.
  standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/',
  cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
  cMapPacked: true,
}).promise;

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'html') el.innerHTML = v; // only ever used with our own static markup
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'role' || k === 'for') el.setAttribute(k, v);
    else el[k] = v;
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;
export const baseName = (name) => name.replace(/\.[^.]+$/, '');
export const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
export const isImage = (f) => /^image\/(png|jpe?g|webp|gif|bmp)$/i.test(f.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);

export function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function safeFileName(name, ext = '.pdf') {
  let n = String(name).trim().replace(/[\\/:*?"<>|]+/g, '-') || 'document';
  if (!n.toLowerCase().endsWith(ext)) n += ext;
  return n;
}

/** "1-3, 5, 8-" -> zero-based indices. Empty -> []. Throws with a friendly message. */
export function parseRange(text, total) {
  const out = [];
  for (const raw of String(text).split(',')) {
    const part = raw.trim();
    if (!part) continue;
    let a, b;
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : total; }
    else if (/^\d+$/.test(part)) a = b = +part;
    else throw new Error(`"${part}" isn't a page number or range`);
    if (a < 1 || b > total) throw new Error(`"${part}" is outside pages 1–${total}`);
    if (a > b) throw new Error(`"${part}" goes backwards`);
    for (let i = a; i <= b; i++) out.push(i - 1);
  }
  return out;
}

/** Turn [0,1,2,4] into "1-3, 5". */
export function describePages(indices) {
  const s = [...new Set(indices)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(i === j ? `${s[i] + 1}` : `${s[i] + 1}-${s[j] + 1}`);
    i = j;
  }
  return parts.join(', ');
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

export const pdfBlob = (bytes) => new Blob([bytes], { type: 'application/pdf' });

/**
 * Open a PDF with both libraries: pdf-lib (to change/save) and PDF.js (to draw).
 * Throws an Error with a message that's safe to show the user.
 */
export async function openPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let lib;
  try {
    lib = await PDFLib.PDFDocument.load(bytes);
  } catch (e) {
    throw new Error(/encrypt/i.test(String(e?.message))
      ? `${file.name} is password-protected. Remove the password and try again.`
      : `${file.name} couldn't be read. It may be damaged or not really a PDF.`);
  }
  let pdfjs = null;
  try { pdfjs = await pdfjsOpen(bytes.slice()); } catch { /* previews unavailable */ }
  return { file, name: file.name, size: file.size, bytes, lib, pdfjs, pageCount: lib.getPageCount() };
}

/** Render one page to a canvas. `target` = longest side in CSS pixels. */
export async function renderPage(pdfjs, index, { target = 240, scale: fixedScale, background = '#fff' } = {}) {
  const page = await pdfjs.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  const scale = fixedScale ?? target / Math.max(base.width, base.height);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // 'print' intent renders in one go instead of waiting on animation frames,
  // which can stall for seconds when the browser throttles them.
  await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
  page.cleanup();
  return canvas;
}

export const canvasToBlob = (canvas, type = 'image/jpeg', quality = 0.85) =>
  new Promise((r) => canvas.toBlob(r, type, quality));

/** Thumbnails rendered one at a time in the background. */
export class ThumbQueue {
  constructor() { this.q = []; this.busy = false; this.cache = new Map(); this.waiting = new Map(); this.gen = 0; }
  get(doc, i, cb) {
    const key = `${doc.id ?? doc.name}-${i}`;
    if (this.cache.has(key)) { cb(this.cache.get(key)); return; }
    // Already queued (e.g. the page was redrawn): just wait for the same render.
    if (this.waiting.has(key)) { this.waiting.get(key).push(cb); return; }
    this.waiting.set(key, [cb]);
    this.q.push({ doc, i, key });
    this.pump();
  }
  clear() {
    this.gen++;
    this.q.length = 0;
    this.waiting.clear();
    for (const u of this.cache.values()) if (u) URL.revokeObjectURL(u);
    this.cache.clear();
  }
  async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.q.length) {
      const gen = this.gen;
      const { doc, i, key } = this.q.shift();
      let url = null;
      if (doc.pdfjs) {
        try { url = URL.createObjectURL(await canvasToBlob(await renderPage(doc.pdfjs, i))); } catch { url = null; }
      }
      if (gen !== this.gen) { if (url) URL.revokeObjectURL(url); continue; } // file was replaced meanwhile
      this.cache.set(key, url);
      const cbs = this.waiting.get(key) || [];
      this.waiting.delete(key);
      cbs.forEach((cb) => cb(url));
    }
    this.busy = false;
  }
}

/** A page preview box. Fills itself in when the thumbnail is ready. */
export function pagePaper(queue, doc, i, rot = 0) {
  const paper = h('div', { class: 'paper loading' });
  queue.get(doc, i, (url) => {
    paper.classList.remove('loading');
    paper.replaceChildren(url
      ? h('img', { src: url, alt: '', draggable: false, style: rot ? `transform: rotate(${rot}deg)` : '' })
      : h('span', { class: 'noprev' }, `Page ${i + 1}`));
  });
  return paper;
}

/**
 * Wire a drop zone + file input. Files dropped anywhere on the page also count.
 * `accept(file)` filters; `onFiles(files)` gets the accepted ones.
 */
export function setupFileInput({ drop, input, accept, onFiles, onRejected }) {
  const handle = (list) => {
    const files = Array.from(list);
    const ok = files.filter(accept);
    if (files.length > ok.length) onRejected?.(files.length - ok.length);
    if (ok.length) onFiles(ok);
  };
  input.addEventListener('change', () => { handle(input.files); input.value = ''; });

  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (depth++ === 0) document.body.classList.add('file-over');
    drop?.classList.add('over');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) { depth = 0; document.body.classList.remove('file-over'); drop?.classList.remove('over'); }
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('file-over');
    drop?.classList.remove('over');
    handle(e.dataTransfer.files);
  });
}

/** Big empty-state drop zone used by single-file tools. */
export function dropZone({ title = 'Choose a PDF', sub = 'or drop it here', accept = 'application/pdf,.pdf', multiple = false, note } = {}) {
  const input = h('input', { type: 'file', accept, multiple, hidden: true });
  const drop = h('label', { class: 'drop big' },
    input,
    h('span', { class: 'drop-icon-wrap', html: ICONS.upload }),
    h('span', { class: 'btn primary' }, title),
    h('span', { class: 'drop-sub' }, sub),
    note && h('span', { class: 'drop-note' }, note),
  );
  return { drop, input };
}

export function statusLine() {
  const el = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  el.set = (msg, kind = '') => { el.textContent = msg; el.className = 'status' + (kind ? ' ' + kind : ''); };
  return el;
}

/** Run an async job with a busy button label. */
export async function busy(button, label, fn) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try { return await fn(); } finally { button.textContent = old; button.disabled = false; }
}

export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// Simple line icons (24×24, stroke = currentColor).
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICONS = {
  home: svg('<path d="M3 11 12 4l9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>'),
  merge: svg('<rect x="3" y="3" width="8" height="10" rx="1.5"/><rect x="13" y="3" width="8" height="10" rx="1.5"/><path d="M7 13v3a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-3M12 18v3"/>'),
  split: svg('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 7.5 20 17M8 16.5 20 7"/>'),
  rotate: svg('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  extract: svg('<rect x="4" y="3" width="11" height="14" rx="1.5"/><path d="M13 13h8m0 0-3-3m3 3-3 3"/><path d="M8 21h9"/>'),
  compress: svg('<path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>'),
  toPdf: svg('<rect x="3" y="4" width="10" height="9" rx="1.5"/><path d="m3 11 3-3 4 4"/><path d="M15 6h6v14H9v-4"/>'),
  ocr: svg('<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 9h8M8 12h8M8 15h5"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13 7 4 4"/>'),
  sign: svg('<path d="M3 17c3-1 4-9 6-9s-1 9 2 9 3-5 5-5 1 4 3 4"/><path d="M3 21h18"/>'),
  upload: svg('<path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'),
  download: svg('<path d="M12 4v12m0 0-4-4m4 4 4-4M4 18v2h16v-2"/>'),
  rotL: svg('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v5h5"/>'),
  rotR: svg('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>'),
  scissors: svg('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 7.5 20 17M8 16.5 20 7"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  text: svg('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
  pen: svg('<path d="M3 21c3-6 6-9 9-9s1 5 4 5 3-3 5-3"/>'),
  highlight: svg('<path d="m9 15-4 4h5l2-2"/><path d="m9 15 8-8 3 3-8 8z"/><path d="M3 21h18"/>'),
  rect: svg('<rect x="4" y="5" width="16" height="14" rx="1.5"/>'),
  ellipse: svg('<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>'),
  line: svg('<path d="M5 19 19 5"/>'),
  redact: svg('<rect x="3" y="8" width="18" height="8" rx="1" fill="currentColor"/>'),
  watermark: svg('<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/>'),
  crop: svg('<path d="M6 2v16h16"/><path d="M2 6h16v16"/>'),
  select: svg('<path d="m5 3 14 8-6 2-2 6-6-16Z"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  check: svg('<path d="m4 12 5 5L20 6"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>'),
  zoomIn: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M11 8v6M8 11h6"/>'),
  shield: svg('<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Z"/><path d="m8.8 12 2.2 2.2 4.3-4.4"/>'),
  lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2.5"/>'),
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>'),
  chevron: svg('<path d="m6 9 6 6 6-6"/>'),
  zoomOut: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M8 11h6"/>'),
};
