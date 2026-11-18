// Edit & Sign: one page editor, two tool sets.
// Everything is drawn on top of the original pages and written into the PDF with
// pdf-lib when you download. Redacted pages are flattened to an image so the
// covered text is really gone, not just hidden behind a black box.
import {
  h, $, plural, baseName, isPdf, isImage, formatSize, safeFileName, download, pdfBlob, openPdf,
  renderPage, canvasToBlob, setupFileInput, dropZone, statusLine, busy, ICONS,
} from './lib.js';

const MODE = document.body.dataset.tool; // 'edit' | 'sign'
const root = $('#tool-root');
const status = statusLine();

// Handwriting fonts for typed signatures.
document.head.append(h('link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Caveat:wght@600&family=Dancing+Script:wght@600&family=Great+Vibes&display=swap' }));

const { drop, input } = dropZone({ title: 'Choose a PDF', sub: 'or drop it anywhere on this page' });
const editor = h('section', { class: 'panel editor', hidden: true });
root.append(drop, editor);
drop.after(status);

// ------------------------------------------------------------------ constants

const COLORS = ['#111111', '#17386b', '#1d6fd8', '#c0392b', '#1e7d4f', '#f08a24', '#7a5cc7', '#ffffff'];
const HIGHLIGHTS = ['#ffe14d', '#7ee081', '#ff9ccf', '#8fd3ff'];
const FONTS = {
  Helvetica: { css: 'Arial, Helvetica, sans-serif', std: 'Helvetica', base: 0.947, label: 'Sans' },
  Times: { css: '"Times New Roman", Times, serif', std: 'TimesRoman', base: 0.9375, label: 'Serif' },
  Courier: { css: '"Courier New", Courier, monospace', std: 'Courier', base: 0.8665, label: 'Mono' },
};
const SIG_FONTS = ['Dancing Script', 'Great Vibes', 'Caveat'];
const LINE_H = 1.2;

const EDIT_TOOLS = [
  ['select', 'Select', 'select'], ['text', 'Text', 'text'], ['draw', 'Draw', 'pen'], ['highlight', 'Highlight', 'highlight'],
  ['rect', 'Rectangle', 'rect'], ['ellipse', 'Ellipse', 'ellipse'], ['line', 'Line', 'line'], ['image', 'Image', 'image'],
  ['signature', 'Signature', 'sign'], ['redact', 'Redact', 'redact'], ['watermark', 'Watermark', 'watermark'], ['crop', 'Crop', 'crop'],
];
const SIGN_TOOLS = [
  ['select', 'Select', 'select'], ['signature', 'Signature', 'sign'], ['initials', 'Initials', 'sign'], ['text', 'Text', 'text'],
  ['date', 'Date', 'calendar'], ['check', 'Checkmark', 'check'], ['draw', 'Draw', 'pen'],
];
const TOOLS = MODE === 'sign' ? SIGN_TOOLS : EDIT_TOOLS;
const DRAG_TOOLS = new Set(['draw', 'highlight', 'rect', 'ellipse', 'line', 'redact', 'crop']);
const HINTS = {
  select: 'Click something to select it. Drag to move, drag the corner to resize, press Delete to remove. Double-click text to edit it.',
  text: 'Click on a page where the text should go, then type.',
  draw: 'Hold the mouse button and draw on the page.',
  highlight: 'Drag over the area you want to highlight.',
  rect: 'Drag to draw a rectangle.', ellipse: 'Drag to draw an ellipse.', line: 'Drag to draw a line.',
  image: 'Choose an image, then click on the page where it should go.',
  signature: 'Create your signature, then click on the page where it should go.',
  initials: 'Create your initials, then click on the page where they should go.',
  redact: 'Drag over anything that must be removed. Redacted pages are flattened when you download, so the covered text is permanently deleted.',
  watermark: 'The watermark is added to every page. Change the text and look below.',
  crop: 'Drag the area to keep. Everything outside it is hidden.',
  date: 'Click on the page to place today\'s date.',
  check: 'Click on the page to place a checkmark.',
};

// ------------------------------------------------------------------ state

let doc = null;
let pages = [];         // { W, H, vp, url }
let annots = [];
let watermark = null;   // { text, size, opacity, color }
let tool = 'select';
let selectedId = null;
let editingId = null;
let pending = null;     // image/signature waiting to be placed: { src, w, h, kind }
let zoom = 1;
let nextId = 1;
let undoStack = [], redoStack = [];
const style = { color: '#111111', hl: '#ffe14d', width: 2, fontSize: 14, font: 'Helvetica' };
let savedSigs = loadSavedSigs();

// ------------------------------------------------------------------ loading

setupFileInput({
  drop, input, accept: isPdf,
  onFiles: (files) => load(files[0]),
  onRejected: () => status.set('Please choose a PDF file.', 'err'),
});

async function load(file) {
  if (doc && annots.length && !confirm('Open a different file? Changes to the current one will be lost.')) return;
  status.set(`Opening ${file.name}…`);
  try {
    const d = await openPdf(file);
    if (!d.pdfjs) throw new Error(`${file.name} couldn't be displayed.`);
    pages.forEach((p) => p.url && URL.revokeObjectURL(p.url));
    doc = d;
    pages = [];
    for (let i = 0; i < d.pageCount; i++) {
      const vp = (await d.pdfjs.getPage(i + 1)).getViewport({ scale: 1 });
      pages.push({ W: vp.width, H: vp.height, vp, url: null });
    }
    annots = []; watermark = null; selectedId = null; editingId = null; pending = null;
    undoStack = []; redoStack = []; tool = 'select'; zoom = 1;
    drop.hidden = true; editor.hidden = false; status.set('');
    buildEditor();
  } catch (e) {
    status.set(e.message, 'err');
  }
}

// ------------------------------------------------------------------ editor shell

let els = {};

function buildEditor() {
  els.toolbar = h('div', { class: 'ed-tools', role: 'toolbar', 'aria-label': 'Tools' });
  els.props = h('div', { class: 'ed-props' });
  els.hint = h('p', { class: 'ed-hint' });
  els.pages = h('div', { class: 'ed-pages' });
  els.scroll = h('div', { class: 'ed-scroll' }, els.pages);
  els.undo = h('button', { type: 'button', class: 'icon-btn', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', html: ICONS.undo, onclick: undo });
  els.redo = h('button', { type: 'button', class: 'icon-btn', title: 'Redo (Ctrl+Y)', 'aria-label': 'Redo', html: ICONS.redo, onclick: redo });
  els.zoomLabel = h('span', { class: 'zoom-label' });
  els.name = h('input', { type: 'text', value: `${baseName(doc.name)}-${MODE === 'sign' ? 'signed' : 'edited'}`, spellcheck: false, 'aria-label': 'File name' });
  els.save = h('button', { type: 'button', class: 'btn primary' }, h('span', { html: ICONS.download }), 'Download PDF');
  els.save.addEventListener('click', () => busy(els.save, 'Saving…', save));
  els.imgInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp', hidden: true, onchange: pickImage });

  editor.replaceChildren(
    h('div', { class: 'ed-top' },
      h('div', { class: 'filebar' },
        h('div', { class: 'file-icon', html: ICONS[MODE === 'sign' ? 'sign' : 'edit'] }),
        h('div', { class: 'meta' }, h('div', { class: 'fname' }, doc.name), h('div', { class: 'finfo' }, `${plural(doc.pageCount, 'page')} · ${formatSize(doc.size)}`)),
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => input.click() }, 'Choose another file')),
      h('div', { class: 'ed-actions' },
        els.undo, els.redo, h('span', { class: 'sep' }),
        h('button', { type: 'button', class: 'icon-btn', title: 'Zoom out', 'aria-label': 'Zoom out', html: ICONS.zoomOut, onclick: () => setZoom(zoom / 1.2) }),
        els.zoomLabel,
        h('button', { type: 'button', class: 'icon-btn', title: 'Zoom in', 'aria-label': 'Zoom in', html: ICONS.zoomIn, onclick: () => setZoom(zoom * 1.2) }),
        h('span', { class: 'sep' }), els.name, els.save)),
    els.toolbar, els.props, els.hint, els.scroll, status, els.imgInput,
  );

  els.pageEls = pages.map((p, i) => {
    const img = h('img', { class: 'ed-img', alt: `Page ${i + 1}`, draggable: false });
    const layer = h('div', { class: 'ed-layer', 'data-page': i });
    const el = h('div', { class: 'ed-page', 'data-page': i, style: `aspect-ratio:${p.W}/${p.H}` },
      h('div', { class: 'ed-paper loading' }, img), layer, h('span', { class: 'ed-pnum' }, `${i + 1} / ${pages.length}`));
    els.pages.append(el);
    return { el, img, layer };
  });

  // Render page images as they scroll into view.
  const io = new IntersectionObserver((entries) => entries.forEach((en) => {
    if (en.isIntersecting) { io.unobserve(en.target); queuePageRender(Number(en.target.dataset.page)); }
  }), { root: els.scroll, rootMargin: '600px' });
  els.pageEls.forEach(({ el }) => io.observe(el));

  window.removeEventListener('resize', layoutPages);
  window.addEventListener('resize', layoutPages);
  layoutPages();
  renderToolbar();
  renderAll();
}

const renderQueue = [];
let rendering = false;
function queuePageRender(i) { renderQueue.push(i); pumpPages(); }
async function pumpPages() {
  if (rendering) return;
  rendering = true;
  const d = doc;
  while (renderQueue.length) {
    const i = renderQueue.shift();
    try {
      const canvas = await renderPage(d.pdfjs, i, { scale: 2 });
      const url = URL.createObjectURL(await canvasToBlob(canvas, 'image/jpeg', 0.9));
      canvas.width = canvas.height = 0;
      if (d !== doc) { URL.revokeObjectURL(url); break; }
      pages[i].url = url;
      els.pageEls[i].img.src = url;
      els.pageEls[i].img.parentElement.classList.remove('loading');
    } catch (e) { console.warn(e); }
  }
  rendering = false;
}

function layoutPages() {
  if (!doc) return;
  const avail = Math.max(280, els.scroll.clientWidth - 40);
  const maxW = Math.max(...pages.map((p) => p.W));
  const k = Math.min(avail, 980) / maxW * zoom;   // CSS px per PDF point
  els.pages.style.setProperty('--k', k);
  els.pageEls.forEach(({ el }, i) => { el.style.width = `${pages[i].W * k}px`; });
  els.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
}

function setZoom(z) { zoom = Math.max(0.4, Math.min(3, z)); layoutPages(); }

function renderToolbar() {
  els.toolbar.replaceChildren(...TOOLS.map(([id, label, icon]) => h('button', {
    type: 'button', class: 'ed-tool' + (tool === id ? ' active' : ''), 'aria-pressed': String(tool === id), title: label,
    onclick: () => chooseTool(id),
  }, h('span', { html: ICONS[icon] }), h('span', {}, label))));
  els.hint.textContent = pending ? `Click on a page to place the ${pending.kind}. Press Esc to cancel.` : HINTS[tool];
  renderProps();
  els.pages.dataset.tool = pending ? 'place' : tool;
}

function chooseTool(id) {
  finishEditing();
  pending = null;
  if (id === 'image') { tool = 'image'; els.imgInput.click(); }
  else if (id === 'signature' || id === 'initials') { tool = id; openSignatureDialog(id); }
  else if (id === 'watermark') {
    tool = 'watermark';
    if (!watermark) { pushHistory(); watermark = { text: 'CONFIDENTIAL', size: 60, opacity: 0.18, color: '#c0392b' }; }
  } else tool = id;
  if (DRAG_TOOLS.has(id) || id === 'text' || id === 'date' || id === 'check') selectedId = null;
  renderToolbar();
  renderAll();
}

// ------------------------------------------------------------------ properties bar

function swatches(list, current, onPick, label) {
  return h('div', { class: 'swatches', role: 'group', 'aria-label': label }, list.map((c) => h('button', {
    type: 'button', class: 'swatch' + (c === current ? ' on' : ''), style: `--sw:${c}`, title: c, 'aria-label': c,
    onclick: () => onPick(c),
  })));
}

function renderProps() {
  const sel = annots.find((a) => a.id === selectedId);
  const kind = sel ? sel.type : tool;
  const parts = [];
  const update = (patch) => {
    Object.assign(style, patch.style || {});
    if (sel) { pushHistory(); Object.assign(sel, patch.annot || {}); renderAll(); }
    renderProps();
  };

  if (['text', 'date'].includes(kind)) {
    parts.push(h('span', { class: 'ctl' }, h('span', { class: 'ctl-label' }, 'Font'),
      h('select', { onchange: (e) => update({ style: { font: e.target.value }, annot: { font: e.target.value } }) },
        Object.entries(FONTS).map(([k, f]) => h('option', { value: k, selected: (sel?.font ?? style.font) === k }, f.label)))));
    parts.push(h('span', { class: 'ctl' }, h('span', { class: 'ctl-label' }, 'Size'),
      h('input', { type: 'number', min: 6, max: 96, value: sel?.fontSize ?? style.fontSize,
        onchange: (e) => { const v = Math.max(6, Math.min(96, Number(e.target.value) || 12)); update({ style: { fontSize: v }, annot: { fontSize: v } }); } })));
  }
  if (['text', 'date', 'draw', 'ink', 'rect', 'ellipse', 'line', 'check'].includes(kind)) {
    parts.push(h('span', { class: 'ctl' }, h('span', { class: 'ctl-label' }, 'Color'),
      swatches(COLORS, sel?.color ?? style.color, (c) => update({ style: { color: c }, annot: { color: c } }), 'Color')));
  }
  if (['draw', 'ink', 'rect', 'ellipse', 'line', 'check'].includes(kind)) {
    parts.push(h('span', { class: 'ctl' }, h('span', { class: 'ctl-label' }, 'Thickness'),
      h('select', { onchange: (e) => update({ style: { width: Number(e.target.value) }, annot: { width: Number(e.target.value) } }) },
        [1, 2, 3, 5, 8, 12].map((w) => h('option', { value: w, selected: (sel?.width ?? style.width) === w }, `${w} pt`)))));
  }
  if (kind === 'highlight') {
    parts.push(h('span', { class: 'ctl' }, h('span', { class: 'ctl-label' }, 'Color'),
      swatches(HIGHLIGHTS, sel?.color ?? style.hl, (c) => update({ style: { hl: c }, annot: { color: c } }), 'Highlight color')));
  }
  if (kind === 'crop') {
    const crop = sel || annots.find((a) => a.type === 'crop');
    if (crop) {
      parts.push(h('label', { class: 'inline' },
        h('input', { type: 'checkbox', checked: !!crop.all, onchange: (e) => { pushHistory(); crop.all = e.target.checked; renderAll(); } }),
        'Use the same crop on every page'));
    }
  }
  if (tool === 'watermark' && watermark && !sel) {
    const w = watermark;
    const set = (patch) => { pushHistory(); Object.assign(w, patch); renderAll(); };
    parts.push(
      h('span', { class: 'ctl' }, h('span', { class: 'ctl-label' }, 'Text'),
        h('input', { type: 'text', value: w.text, style: 'width:200px', oninput: (e) => { w.text = e.target.value; renderAll(); }, onchange: () => pushHistory() })),
      h('span', { class: 'ctl' }, h('span', { class: 'ctl-label' }, 'Size'),
        h('input', { type: 'number', min: 12, max: 200, value: w.size, onchange: (e) => set({ size: Math.max(12, Math.min(200, Number(e.target.value) || 60)) }) })),
      h('span', { class: 'ctl' }, h('span', { class: 'ctl-label' }, 'Opacity'),
        h('input', { type: 'range', min: 5, max: 60, value: Math.round(w.opacity * 100), oninput: (e) => { w.opacity = Number(e.target.value) / 100; renderAll(); }, onchange: () => pushHistory() })),
      h('span', { class: 'ctl' }, h('span', { class: 'ctl-label' }, 'Color'), swatches(COLORS.slice(0, 7), w.color, (c) => set({ color: c }), 'Watermark color')),
      h('button', { type: 'button', class: 'btn ghost small', onclick: () => { pushHistory(); watermark = null; tool = 'select'; renderToolbar(); renderAll(); } }, 'Remove watermark'),
    );
  }
  if ((tool === 'signature' || tool === 'initials') && !sel) {
    const kindSigs = savedSigs.filter((s) => s.kind === tool);
    parts.push(h('button', { type: 'button', class: 'btn outline small', onclick: () => openSignatureDialog(tool) }, `+ New ${tool === 'initials' ? 'initials' : 'signature'}`));
    kindSigs.forEach((s) => parts.push(h('button', {
      type: 'button', class: 'sig-pick', title: 'Use this one', onclick: () => { pending = { src: s.src, w: s.w, h: s.h, kind: tool }; renderToolbar(); },
    }, h('img', { src: s.src, alt: 'Saved signature' }),
    h('span', { class: 'sig-del', title: 'Forget', role: 'button', 'aria-label': 'Forget this signature', onclick: (e) => { e.stopPropagation(); savedSigs = savedSigs.filter((x) => x !== s); persistSigs(); renderProps(); } }, '×'))));
  }
  if (sel) {
    parts.push(h('span', { class: 'grow' }), h('button', { type: 'button', class: 'btn ghost small', onclick: deleteSelected }, h('span', { html: ICONS.trash }), 'Delete'));
  }
  if (!parts.length) parts.push(h('span', { class: 'ctl-label' }, sel ? '' : 'Pick a tool above to start.'));
  els.props.replaceChildren(...parts);
}

// ------------------------------------------------------------------ geometry helpers

function bbox(a) {
  if (a.points) {
    const xs = a.points.map((p) => p[0]), ys = a.points.map((p) => p[1]);
    const pad = (a.width || 2) / 2;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + 2 * pad, h: Math.max(...ys) - Math.min(...ys) + 2 * pad };
  }
  if (a.type === 'text') return { x: a.x, y: a.y, w: a.w || 10, h: a.h || a.fontSize * LINE_H };
  return { x: a.x, y: a.y, w: a.w, h: a.h };
}

function pagePoint(e, i) {
  const r = els.pageEls[i].layer.getBoundingClientRect();
  const p = pages[i];
  return [
    Math.max(0, Math.min(p.W, (e.clientX - r.left) / r.width * p.W)),
    Math.max(0, Math.min(p.H, (e.clientY - r.top) / r.height * p.H)),
  ];
}

const pct = (v, total) => `${(v / total) * 100}%`;

function ellipsePath(x, y, w, hh) {
  const k = 0.5523, rx = w / 2, ry = hh / 2, cx = x + rx, cy = y + ry;
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry],
    ['C', cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy],
    ['C', cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry],
    ['C', cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy],
    ['Z'],
  ];
}

/** Vector shapes as path commands in page points (y down). */
function shapePath(a) {
  if (a.type === 'ink' || a.type === 'line') return a.points.map((p, i) => [i ? 'L' : 'M', p[0], p[1]]);
  if (a.type === 'rect' || a.type === 'highlight' || a.type === 'redact' || a.type === 'crop') {
    return [['M', a.x, a.y], ['L', a.x + a.w, a.y], ['L', a.x + a.w, a.y + a.h], ['L', a.x, a.y + a.h], ['Z']];
  }
  if (a.type === 'ellipse') return ellipsePath(a.x, a.y, a.w, a.h);
  if (a.type === 'check') {
    const P = (u, v) => [a.x + u * a.w, a.y + v * a.h];
    return [['M', ...P(0.12, 0.55)], ['L', ...P(0.4, 0.82)], ['L', ...P(0.9, 0.16)]];
  }
  return [];
}

const pathString = (cmds, map = (x, y) => [x, y]) => cmds.map(([c, ...n]) => {
  const out = [];
  for (let i = 0; i < n.length; i += 2) out.push(...map(n[i], n[i + 1]));
  return c + out.map((v) => +v.toFixed(2)).join(' ');
}).join(' ');

// ------------------------------------------------------------------ rendering annotations

function renderAll() {
  if (!doc) return;
  pages.forEach((_, i) => renderLayer(i));
  els.undo.disabled = !undoStack.length;
  els.redo.disabled = !redoStack.length;
}

function renderLayer(i) {
  const { layer } = els.pageEls[i];
  const p = pages[i];
  const list = annots.filter((a) => a.page === i || (a.type === 'crop' && a.all));
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${p.W} ${p.H}`);
  svg.setAttribute('class', 'ed-svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  const kids = [svg];

  for (const a of list) {
    if (['ink', 'line', 'rect', 'ellipse', 'highlight', 'redact', 'check'].includes(a.type)) {
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', pathString(shapePath(a)));
      if (a.type === 'highlight') { path.setAttribute('fill', a.color); path.setAttribute('class', 'hl'); }
      else if (a.type === 'redact') path.setAttribute('fill', '#000');
      else {
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', a.color);
        path.setAttribute('stroke-width', a.width);
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
      }
      svg.append(path);
    } else if (a.type === 'crop') {
      // Shade everything outside the crop area.
      const shade = document.createElementNS(svgNS, 'path');
      shade.setAttribute('d', `M0 0H${p.W}V${p.H}H0Z ` + pathString(shapePath(a)));
      shade.setAttribute('fill', 'rgba(11,33,71,.45)');
      shade.setAttribute('fill-rule', 'evenodd');
      const edge = document.createElementNS(svgNS, 'path');
      edge.setAttribute('d', pathString(shapePath(a)));
      edge.setAttribute('fill', 'none'); edge.setAttribute('stroke', '#f08a24'); edge.setAttribute('stroke-width', 1.5); edge.setAttribute('stroke-dasharray', '6 4');
      svg.append(shade, edge);
    } else if (a.type === 'text') {
      const f = FONTS[a.font] || FONTS.Helvetica;
      const t = h('div', {
        class: 'ed-text' + (a.id === editingId ? ' editing' : ''), 'data-id': a.id,
        style: `left:${pct(a.x, p.W)};top:${pct(a.y, p.H)};font-family:${f.css};font-size:calc(var(--k) * ${a.fontSize}px);color:${a.color};line-height:${LINE_H}`,
      });
      t.textContent = a.text;
      kids.push(t);
    } else if (a.type === 'image') {
      kids.push(h('img', {
        class: 'ed-image', 'data-id': a.id, src: a.src, alt: '', draggable: false,
        style: `left:${pct(a.x, p.W)};top:${pct(a.y, p.H)};width:${pct(a.w, p.W)};height:${pct(a.h, p.H)}`,
      }));
    }
  }

  if (watermark && watermark.text.trim()) {
    kids.push(h('div', {
      class: 'ed-watermark',
      style: `font-size:calc(var(--k) * ${watermark.size}px);color:${watermark.color};opacity:${watermark.opacity}`,
    }, watermark.text));
  }

  // Hit boxes for shapes (texts and images are their own hit targets).
  for (const a of list) {
    if (a.type === 'text' || a.type === 'image' || (a.type === 'crop' && a.page !== i)) continue;
    const b = bbox(a);
    kids.push(h('div', { class: 'ed-hit', 'data-id': a.id, style: `left:${pct(b.x, p.W)};top:${pct(b.y, p.H)};width:${pct(b.w, p.W)};height:${pct(b.h, p.H)}` }));
  }

  layer.replaceChildren(...kids);

  // Measure text so selection boxes fit.
  const scale = layer.clientWidth / p.W;   // CSS px per point
  if (scale > 0) {
    for (const t of layer.querySelectorAll('.ed-text')) {
      const a = annots.find((x) => x.id === Number(t.dataset.id));
      a.w = t.offsetWidth / scale;
      a.h = t.offsetHeight / scale;
    }
  }

  const sel = list.find((a) => a.id === selectedId && (a.page === i));
  if (sel && sel.id !== editingId) {
    const b = bbox(sel);
    const canResize = sel.type !== 'text';
    layer.append(h('div', { class: 'ed-sel', style: `left:${pct(b.x, p.W)};top:${pct(b.y, p.H)};width:${pct(b.w, p.W)};height:${pct(b.h, p.H)}` },
      canResize && h('span', { class: 'ed-handle', 'data-handle': sel.id, title: 'Drag to resize' }),
      h('button', { type: 'button', class: 'ed-del', title: 'Delete', 'aria-label': 'Delete', onclick: deleteSelected, html: ICONS.x })));
  }

  if (editingId) {
    const t = layer.querySelector(`.ed-text[data-id="${editingId}"]`);
    if (t) startTextEditing(t);
  }
}

// ------------------------------------------------------------------ history

function snapshot() { return JSON.stringify({ annots, watermark }); }
function pushHistory() { undoStack.push(snapshot()); if (undoStack.length > 100) undoStack.shift(); redoStack = []; }
function restore(s) { const o = JSON.parse(s); annots = o.annots; watermark = o.watermark; selectedId = null; editingId = null; renderToolbar(); renderAll(); }
function undo() { finishEditing(); if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }

function deleteSelected() {
  if (!selectedId) return;
  pushHistory();
  annots = annots.filter((a) => a.id !== selectedId);
  selectedId = null;
  renderProps();
  renderAll();
}

// ------------------------------------------------------------------ text editing

function startTextEditing(t) {
  if (t.isContentEditable) return;
  t.contentEditable = 'true';
  t.spellcheck = true;
  const a = annots.find((x) => x.id === Number(t.dataset.id));
  t.addEventListener('input', () => { a.text = t.innerText.replace(/\n$/, ''); });
  t.addEventListener('blur', () => finishEditing(), { once: true });
  t.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); t.blur(); } e.stopPropagation(); });
  // Focus right away (not on the next animation frame, which browsers may delay),
  // so the first keystrokes aren't lost.
  const focusEnd = () => {
    if (!t.isConnected) return;
    t.focus({ preventScroll: true });
    const r = document.createRange(); r.selectNodeContents(t); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  };
  focusEnd();
  setTimeout(() => { if (document.activeElement !== t) focusEnd(); }, 0);
}

function finishEditing() {
  if (!editingId) return;
  const a = annots.find((x) => x.id === editingId);
  editingId = null;
  if (a && !a.text.trim()) annots = annots.filter((x) => x !== a);
  else if (a) selectedId = a.id;
  renderAll();
  renderProps();
}

// ------------------------------------------------------------------ pointer interaction

let gesture = null;

editor.addEventListener('pointerdown', (e) => {
  const layer = e.target.closest('.ed-layer');
  if (!layer || e.button !== 0) return;
  if (e.target.closest('.ed-del')) return;
  const i = Number(layer.dataset.page);
  const pt = pagePoint(e, i);

  if (editingId && !e.target.closest('.ed-text.editing')) finishEditing();
  if (e.target.closest('.ed-text.editing')) return;

  // Place a pending image/signature.
  if (pending) {
    const w = pending.w, hh = pending.h;
    pushHistory();
    const a = { id: nextId++, page: i, type: 'image', src: pending.src, x: clampX(pt[0] - w / 2, w, i), y: clampY(pt[1] - hh / 2, hh, i), w, h: hh };
    annots.push(a);
    selectedId = a.id;
    pending = null;
    tool = 'select';
    renderToolbar(); renderAll();
    e.preventDefault();
    return;
  }

  // Resize handle.
  const handle = e.target.closest('.ed-handle');
  if (handle) {
    const a = annots.find((x) => x.id === Number(handle.dataset.handle));
    gesture = { kind: 'resize', a, i, start: pt, orig: JSON.parse(JSON.stringify(a)), box: bbox(a), moved: false };
    layer.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }

  // Grab an existing item (any tool that isn't a drawing tool).
  const hit = e.target.closest('[data-id]');
  if (hit && !DRAG_TOOLS.has(tool)) {
    const a = annots.find((x) => x.id === Number(hit.dataset.id));
    if (a) {
      const wasSelected = selectedId === a.id;
      if (!wasSelected) { selectedId = a.id; renderProps(); renderAll(); }
      gesture = { kind: 'move', a, i, start: pt, orig: JSON.parse(JSON.stringify(a)), moved: false, wasSelected };
      layer.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
  }

  if (tool === 'text' || tool === 'date') {
    pushHistory();
    const fs = style.fontSize;
    const a = {
      id: nextId++, page: i, type: 'text', x: pt[0], y: Math.max(0, pt[1] - fs * 0.6),
      text: tool === 'date' ? new Date().toLocaleDateString('en-US') : '', fontSize: fs, font: style.font, color: style.color,
    };
    annots.push(a);
    if (tool === 'text') editingId = a.id; else selectedId = a.id;
    tool = 'select';
    renderToolbar(); renderAll();
    e.preventDefault();
    return;
  }
  if (tool === 'check') {
    pushHistory();
    const s = 18;
    const a = { id: nextId++, page: i, type: 'check', x: pt[0] - s / 2, y: pt[1] - s / 2, w: s, h: s, color: style.color, width: 2.5 };
    annots.push(a);
    selectedId = a.id;
    renderAll(); renderProps();
    e.preventDefault();
    return;
  }

  if (DRAG_TOOLS.has(tool)) {
    const type = tool === 'draw' ? 'ink' : tool;
    const a = { id: nextId++, page: i, type };
    if (type === 'ink' || type === 'line') Object.assign(a, { points: [pt, pt], color: style.color, width: style.width });
    else Object.assign(a, { x: pt[0], y: pt[1], w: 0, h: 0 });
    if (type === 'rect' || type === 'ellipse') Object.assign(a, { color: style.color, width: style.width });
    if (type === 'highlight') a.color = style.hl;
    gesture = { kind: 'create', a, i, start: pt, history: snapshot() };
    layer.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }

  // Click on empty space: deselect.
  if (selectedId) { selectedId = null; renderProps(); renderAll(); }
});

editor.addEventListener('pointermove', (e) => {
  if (!gesture) return;
  const { a, i, start } = gesture;
  const pt = pagePoint(e, i);
  const dx = pt[0] - start[0], dy = pt[1] - start[1];

  if (gesture.kind === 'create') {
    if (a.type === 'ink') {
      const last = a.points[a.points.length - 1];
      if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) > 0.8) a.points.push(pt);
    } else if (a.type === 'line') a.points[1] = pt;
    else Object.assign(a, { x: Math.min(start[0], pt[0]), y: Math.min(start[1], pt[1]), w: Math.abs(dx), h: Math.abs(dy) });
    if (!annots.includes(a)) {
      if (a.type === 'crop') annots = annots.filter((x) => !(x.type === 'crop' && (x.page === i || x.all)));
      annots.push(a);
    }
    renderLayer(i);
    return;
  }

  if (Math.abs(dx) + Math.abs(dy) > 0.5 && !gesture.moved) { gesture.moved = true; undoStack.push(gesture.history || snapshot()); redoStack = []; }
  if (!gesture.moved) return;
  const o = gesture.orig;

  if (gesture.kind === 'move') {
    const b = bbox(o);
    const ddx = Math.max(-b.x, Math.min(pages[i].W - b.x - b.w, dx));
    const ddy = Math.max(-b.y, Math.min(pages[i].H - b.y - b.h, dy));
    if (o.points) a.points = o.points.map(([x, y]) => [x + ddx, y + ddy]);
    else { a.x = o.x + ddx; a.y = o.y + ddy; }
  } else if (gesture.kind === 'resize') {
    const b = gesture.box;
    let sx = Math.max(8, b.w + dx) / b.w;
    let sy = Math.max(8, b.h + dy) / b.h;
    if (a.type === 'image' || a.type === 'check') sx = sy = Math.max(sx, sy);   // keep proportions
    if (o.points) a.points = o.points.map(([x, y]) => [b.x + (x - b.x) * sx, b.y + (y - b.y) * sy]);
    else { a.w = o.w * sx; a.h = o.h * sy; }
  }
  renderLayer(i);
});

editor.addEventListener('pointerup', (e) => {
  if (!gesture) return;
  const g = gesture;
  gesture = null;
  if (g.kind === 'create') {
    const b = bbox(g.a);
    const tiny = g.a.type === 'ink' ? g.a.points.length < 2 : (b.w < 3 && b.h < 3);
    if (tiny || (g.a.type !== 'ink' && g.a.type !== 'line' && (b.w < 3 || b.h < 3))) {
      annots = annots.filter((x) => x !== g.a);
    } else {
      undoStack.push(g.history); redoStack = [];
      if (['rect', 'ellipse', 'line', 'crop'].includes(g.a.type)) selectedId = g.a.id;
    }
    renderAll(); renderProps();
    return;
  }
  if (!g.moved) {
    // A click (no drag) on text that is already selected starts editing.
    if (g.kind === 'move' && g.a.type === 'text' && g.wasSelected) { editingId = g.a.id; renderAll(); }
  }
  renderAll(); renderProps();
});

editor.addEventListener('dblclick', (e) => {
  const t = e.target.closest('.ed-text');
  if (!t) return;
  editingId = Number(t.dataset.id);
  selectedId = null;
  renderAll();
});

const clampX = (x, w, i) => Math.max(0, Math.min(pages[i].W - w, x));
const clampY = (y, hh, i) => Math.max(0, Math.min(pages[i].H - hh, y));

document.addEventListener('keydown', (e) => {
  if (!doc || editor.hidden) return;
  if (e.target.matches?.('input, textarea, select, [contenteditable="true"]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.key === 'Escape') { pending = null; selectedId = null; tool = 'select'; renderToolbar(); renderAll(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { e.preventDefault(); deleteSelected(); return; }
  const a = annots.find((x) => x.id === selectedId);
  const step = e.shiftKey ? 10 : 1;
  const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (a && nudge) {
    e.preventDefault();
    pushHistory();
    if (a.points) a.points = a.points.map(([x, y]) => [x + nudge[0], y + nudge[1]]);
    else { a.x += nudge[0]; a.y += nudge[1]; }
    renderLayer(a.page);
  }
});

// ------------------------------------------------------------------ images & signatures

async function pickImage() {
  const file = els.imgInput.files[0];
  els.imgInput.value = '';
  if (!file) { tool = 'select'; renderToolbar(); return; }
  if (!isImage(file)) { status.set('Please choose a JPG, PNG or WebP image.', 'err'); return; }
  try {
    const src = await imageToDataUrl(file, 2000);
    const { w, h: hh } = await fitSize(src, 220);
    pending = { src, w, h: hh, kind: 'image' };
    renderToolbar();
  } catch {
    status.set(`${file.name} couldn't be read as an image.`, 'err');
  }
}

async function imageToDataUrl(file, maxSide) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = h('canvas', { width: Math.round(bmp.width * s), height: Math.round(bmp.height * s) });
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const png = /png|webp|gif/i.test(file.type);
  return c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.9);
}

function fitSize(src, maxPts) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => { const s = maxPts / Math.max(im.width, im.height); resolve({ w: im.width * s, h: im.height * s }); };
    im.onerror = reject;
    im.src = src;
  });
}

function loadSavedSigs() {
  try { return JSON.parse(localStorage.getItem('star-pdf-signatures') || '[]'); } catch { return []; }
}
function persistSigs() {
  try { localStorage.setItem('star-pdf-signatures', JSON.stringify(savedSigs.filter((s) => s.remember))); } catch { /* storage unavailable */ }
}

function openSignatureDialog(kind = 'signature') {
  const isInit = kind === 'initials';
  let tab = 'draw';
  let color = '#111111';
  let typed = '';
  let sigFont = SIG_FONTS[0];
  let uploaded = null;
  let removeBg = true;
  let remember = false;
  let strokes = [];

  const dlg = h('dialog', { class: 'sig-dialog', 'aria-label': `Create ${kind}` });
  const pad = h('canvas', { class: 'sig-pad', width: 900, height: 300 });
  const body = h('div', { class: 'sig-body' });
  const createBtn = h('button', { type: 'button', class: 'btn primary' }, 'Create');

  function drawPad() {
    const c = pad.getContext('2d');
    c.clearRect(0, 0, pad.width, pad.height);
    c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = 5; c.strokeStyle = color;
    for (const s of strokes) { c.beginPath(); s.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y))); if (s.length === 1) c.lineTo(s[0][0] + 0.1, s[0][1]); c.stroke(); }
  }
  let drawing = null;
  pad.addEventListener('pointerdown', (e) => { pad.setPointerCapture(e.pointerId); drawing = []; strokes.push(drawing); addPt(e); });
  pad.addEventListener('pointermove', (e) => { if (drawing) addPt(e); });
  pad.addEventListener('pointerup', () => { drawing = null; refresh(); });
  function addPt(e) {
    const r = pad.getBoundingClientRect();
    drawing.push([(e.clientX - r.left) / r.width * pad.width, (e.clientY - r.top) / r.height * pad.height]);
    drawPad();
  }

  function ready() {
    if (tab === 'draw') return strokes.some((s) => s.length);
    if (tab === 'type') return typed.trim().length > 0;
    return !!uploaded;
  }

  function refresh() {
    const tabs = h('div', { class: 'seg', role: 'tablist' }, [['draw', 'Draw'], ['type', 'Type'], ['upload', 'Upload']].map(([v, l]) =>
      h('button', { type: 'button', role: 'tab', 'aria-pressed': String(tab === v), onclick: () => { tab = v; refresh(); } }, l)));
    const colorPick = h('div', { class: 'swatches' }, ['#111111', '#1d4ed8', '#c0392b'].map((c) => h('button', {
      type: 'button', class: 'swatch' + (c === color ? ' on' : ''), style: `--sw:${c}`, 'aria-label': c,
      onclick: () => { color = c; drawPad(); refresh(); },
    })));
    let content;
    if (tab === 'draw') {
      content = h('div', {}, h('div', { class: 'sig-pad-wrap' }, pad, h('span', { class: 'sig-line' }), h('span', { class: 'sig-here' }, isInit ? 'Draw your initials here' : 'Draw your signature here')),
        h('button', { type: 'button', class: 'link-btn', onclick: () => { strokes = []; drawPad(); refresh(); } }, 'Clear'));
    } else if (tab === 'type') {
      const field = h('input', { type: 'text', value: typed, placeholder: isInit ? 'Your initials' : 'Your full name', style: 'font-size:1.1rem', oninput: (e) => { typed = e.target.value; previews.querySelectorAll('.sig-font span').forEach((s) => { s.textContent = typed || (isInit ? 'J.D.' : 'Your Name'); }); createBtn.disabled = !ready(); } });
      const previews = h('div', { class: 'sig-fonts' }, SIG_FONTS.map((f) => h('button', {
        type: 'button', class: 'sig-font' + (f === sigFont ? ' on' : ''), onclick: () => { sigFont = f; refresh(); },
      }, h('span', { style: `font-family:'${f}',cursive;color:${color}` }, typed || (isInit ? 'J.D.' : 'Your Name')))));
      content = h('div', {}, field, previews);
      setTimeout(() => field.focus(), 0);
    } else {
      const up = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', onchange: async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try { uploaded = await imageToDataUrl(f, 1200); refresh(); } catch { status.set('That image couldn\'t be read.', 'err'); }
      } });
      content = h('div', {},
        h('label', { class: 'btn outline small' }, up, 'Choose image'),
        uploaded && h('div', { class: 'sig-upload-preview' }, h('img', { src: uploaded, alt: 'Uploaded signature' })),
        h('label', { class: 'inline', style: 'margin-top:10px' }, h('input', { type: 'checkbox', checked: removeBg, onchange: (e) => { removeBg = e.target.checked; } }), 'Make the white background transparent'));
      up.hidden = true;
    }
    createBtn.disabled = !ready();
    body.replaceChildren(
      h('div', { class: 'sig-row' }, tabs, tab !== 'upload' && colorPick),
      content,
      h('label', { class: 'inline', style: 'margin-top:12px' },
        h('input', { type: 'checkbox', checked: remember, onchange: (e) => { remember = e.target.checked; } }),
        'Remember on this computer (saved only in this browser)'),
    );
  }

  createBtn.addEventListener('click', async () => {
    let src;
    if (tab === 'draw') src = trimCanvas(pad);
    else if (tab === 'type') {
      await document.fonts.load(`80px "${sigFont}"`).catch(() => {});
      const c = h('canvas', { width: 1400, height: 300 });
      const x = c.getContext('2d');
      x.font = `110px "${sigFont}", cursive`;
      x.fillStyle = color;
      x.textBaseline = 'middle';
      x.fillText(typed.trim(), 30, 150);
      src = trimCanvas(c);
    } else {
      src = removeBg ? await whiteToTransparent(uploaded) : uploaded;
    }
    if (!src) return;
    const { w, h: hh } = await fitSize(src, isInit ? 70 : 170);
    const sig = { kind, src, w, h: hh, remember };
    savedSigs.push(sig);
    persistSigs();
    pending = { src, w, h: hh, kind };
    tool = kind;
    dlg.close();
    renderToolbar();
  });

  dlg.append(
    h('div', { class: 'sig-head' }, h('h2', {}, isInit ? 'Create initials' : 'Create signature'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', html: ICONS.x, onclick: () => dlg.close() })),
    body,
    h('div', { class: 'sig-foot' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close() }, 'Cancel'), createBtn),
  );
  dlg.addEventListener('close', () => { dlg.remove(); if (!pending) { tool = 'select'; renderToolbar(); } });
  document.body.append(dlg);
  refresh();
  drawPad();
  dlg.showModal();
}

/** Crop a canvas to its non-transparent pixels and return a PNG data URL. */
function trimCanvas(c) {
  const x = c.getContext('2d');
  const { data, width, height } = x.getImageData(0, 0, c.width, c.height);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let xx = 0; xx < width; xx++) {
    if (data[(y * width + xx) * 4 + 3] > 10) { if (xx < minX) minX = xx; if (xx > maxX) maxX = xx; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (maxX < 0) return null;
  const pad = 6;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
  const out = h('canvas', { width: maxX - minX + 1, height: maxY - minY + 1 });
  out.getContext('2d').drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

function whiteToTransparent(src) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const c = h('canvas', { width: im.width, height: im.height });
      const x = c.getContext('2d');
      x.drawImage(im, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height);
      for (let k = 0; k < d.data.length; k += 4) {
        const lum = (d.data[k] + d.data[k + 1] + d.data[k + 2]) / 3;
        if (lum > 225) d.data[k + 3] = 0;
        else if (lum > 180) d.data[k + 3] = Math.round(255 * (225 - lum) / 45);
      }
      x.putImageData(d, 0, 0);
      resolve(trimCanvas(c) || src);
    };
    im.src = src;
  });
}

// ------------------------------------------------------------------ saving

const hex = (c) => PDFLib.rgb(parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255);

function encodable(text, font) {
  let out = '';
  for (const ch of text) { try { font.encodeText(ch); out += ch; } catch { out += '?'; } }
  return out;
}

async function save() {
  finishEditing();
  try {
    const { PDFDocument, StandardFonts, degrees, BlendMode, LineCapStyle } = PDFLib;
    const out = await PDFDocument.load(doc.bytes);
    const fontCache = {};
    const font = async (name) => (fontCache[name] ||= await out.embedFont(StandardFonts[name]));
    const imgCache = new Map();
    const embedImg = async (src) => {
      if (!imgCache.has(src)) {
        const bytes = Uint8Array.from(atob(src.split(',')[1]), (c) => c.charCodeAt(0));
        imgCache.set(src, src.startsWith('data:image/png') ? await out.embedPng(bytes) : await out.embedJpg(bytes));
      }
      return imgCache.get(src);
    };
    const globalCrop = annots.find((a) => a.type === 'crop' && a.all);
    let redactedPages = 0;

    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const mine = annots.filter((a) => a.page === i);
      const redactions = mine.filter((a) => a.type === 'redact');
      let page = out.getPage(i);
      let map, angle;

      if (redactions.length) {
        // Flatten the page to a picture with the black boxes burned in, so the
        // redacted text and images no longer exist in the file.
        status.set(`Redacting page ${i + 1}…`);
        const S = 2.5;
        const canvas = await renderPage(doc.pdfjs, i, { scale: S });
        const c = canvas.getContext('2d');
        c.fillStyle = '#000';
        for (const r of redactions) c.fillRect(r.x * S, r.y * S, r.w * S, r.h * S);
        const jpg = await out.embedJpg(new Uint8Array(await (await canvasToBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer()));
        canvas.width = canvas.height = 0;
        const fresh = out.insertPage(i, [p.W, p.H]);
        out.removePage(i + 1);
        fresh.drawImage(jpg, { x: 0, y: 0, width: p.W, height: p.H });
        page = fresh;
        map = (x, y) => [x, p.H - y];
        angle = 0;
        redactedPages++;
      } else {
        map = (x, y) => p.vp.convertToPdfPoint(x, y);
        const [ox, oy] = map(0, 0), [ux, uy] = map(1, 0);
        angle = Math.atan2(uy - oy, ux - ox) * 180 / Math.PI;
      }
      const rot = degrees(angle);
      const svgPath = (cmds) => pathString(cmds, (x, y) => { const [X, Y] = map(x, y); return [X, -Y]; });

      for (const a of mine) {
        if (a.type === 'redact' || a.type === 'crop') continue;
        if (a.type === 'text') {
          const f = FONTS[a.font] || FONTS.Helvetica;
          const pf = await font(f.std);
          a.text.split('\n').forEach((line, k) => {
            if (!line) return;
            const [X, Y] = map(a.x, a.y + a.fontSize * (f.base + k * LINE_H));
            page.drawText(encodable(line, pf), { x: X, y: Y, size: a.fontSize, font: pf, color: hex(a.color), rotate: rot });
          });
        } else if (a.type === 'image') {
          const img = await embedImg(a.src);
          const [X, Y] = map(a.x, a.y + a.h);
          page.drawImage(img, { x: X, y: Y, width: a.w, height: a.h, rotate: rot });
        } else if (a.type === 'highlight') {
          page.drawSvgPath(svgPath(shapePath(a)), { x: 0, y: 0, color: hex(a.color), opacity: 0.4, blendMode: BlendMode.Multiply });
        } else {
          page.drawSvgPath(svgPath(shapePath(a)), {
            x: 0, y: 0, borderColor: hex(a.color), borderWidth: a.width, borderLineCap: LineCapStyle.Round,
          });
        }
      }

      if (watermark && watermark.text.trim()) {
        const wf = await font('HelveticaBold');
        const text = encodable(watermark.text.trim(), wf);
        const size = watermark.size;
        const tw = wf.widthOfTextAtSize(text, size);
        const capH = size * 0.7;
        const phi = (angle + 45) * Math.PI / 180;
        const [cx, cy] = map(p.W / 2, p.H / 2);
        const x = cx - (Math.cos(phi) * tw / 2 - Math.sin(phi) * capH / 2);
        const y = cy - (Math.sin(phi) * tw / 2 + Math.cos(phi) * capH / 2);
        page.drawText(text, { x, y, size, font: wf, color: hex(watermark.color), opacity: watermark.opacity, rotate: degrees(angle + 45) });
      }

      const crop = mine.find((a) => a.type === 'crop') || globalCrop;
      if (crop) {
        const [x1, y1] = map(crop.x, crop.y);
        const [x2, y2] = map(crop.x + crop.w, crop.y + crop.h);
        page.setCropBox(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      }
    }

    status.set('Saving…');
    const bytes = await out.save();
    const name = safeFileName(els.name.value || `${baseName(doc.name)}-edited`);
    download(pdfBlob(bytes), name);
    status.set(`Done! Downloaded ${name} (${formatSize(bytes.length)}).` +
      (redactedPages ? ` ${plural(redactedPages, 'redacted page')} ${redactedPages === 1 ? 'was' : 'were'} flattened so the hidden content is permanently removed.` : ''), 'ok');
  } catch (e) {
    console.error(e);
    status.set(`Something went wrong while saving: ${e.message || e}`, 'err');
  }
}

window.addEventListener('beforeunload', (e) => { if (doc && annots.length) e.preventDefault(); });
