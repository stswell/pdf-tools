// PDF -> JPG/PNG. One page downloads as an image; several download as a ZIP.
import {
  h, $, plural, baseName, isPdf, formatSize, parseRange, describePages, download, openPdf,
  ThumbQueue, pagePaper, renderPage, canvasToBlob, setupFileInput, dropZone, statusLine, busy, ICONS,
} from './lib.js';

const root = $('#tool-root');
const queue = new ThumbQueue();
const status = statusLine();
const { drop, input } = dropZone({ title: 'Choose a PDF', sub: 'or drop it anywhere on this page' });
const work = h('section', { class: 'panel', hidden: true });
root.append(drop, work);
drop.after(status);

const QUALITIES = [
  { id: 'screen', label: 'Screen (96 dpi)', scale: 96 / 72 },
  { id: 'standard', label: 'Standard (150 dpi)', scale: 150 / 72 },
  { id: 'print', label: 'High / print (300 dpi)', scale: 300 / 72 },
];

let doc = null;
let sel = new Set();
let anchor = null;
let format = 'jpg';
let quality = 'standard';

setupFileInput({
  drop, input, accept: isPdf,
  onFiles: async (files) => {
    status.set(`Opening ${files[0].name}…`);
    try {
      const d = await openPdf(files[0]);
      d.id = `${Date.now()}`;
      queue.clear();
      doc = d;
      sel = new Set(Array.from({ length: d.pageCount }, (_, i) => i)); // all pages by default
      drop.hidden = true; work.hidden = false; status.set('');
      render();
    } catch (e) { status.set(e.message, 'err'); }
  },
  onRejected: () => status.set('Please choose a PDF file.', 'err'),
});

function render() {
  const focusI = document.activeElement?.closest?.('.thumb')?.dataset.i;
  const seg = (opts, value, set) => h('div', { class: 'seg', role: 'group' }, opts.map(([v, l]) =>
    h('button', { type: 'button', 'aria-pressed': String(v === value), onclick: () => { set(v); render(); } }, l)));

  const rangeField = h('input', { type: 'text', placeholder: 'e.g. 1-3, 5', spellcheck: false, 'aria-label': 'Pages' });
  const applyRange = () => {
    try { const l = parseRange(rangeField.value, doc.pageCount); if (l.length) { sel = new Set(l); render(); } }
    catch (e) { status.set(e.message, 'err'); }
  };
  rangeField.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyRange(); });

  const grid = h('div', { class: 'grid pages-grid' });
  for (let i = 0; i < doc.pageCount; i++) {
    const s = sel.has(i);
    grid.append(h('div', { class: 'thumb' + (s ? ' selected' : ''), tabIndex: 0, role: 'checkbox', 'aria-checked': String(s), 'aria-label': `Page ${i + 1}`, 'data-i': i },
      pagePaper(queue, doc, i), h('span', { class: 'check', 'aria-hidden': 'true' }, '✓'), h('span', { class: 'pnum' }, `Page ${i + 1}`)));
  }

  const go = h('button', { type: 'button', class: 'btn primary', disabled: sel.size === 0 },
    h('span', { html: ICONS.download }), sel.size === 1 ? `Download ${format.toUpperCase()}` : `Download ${sel.size} images (ZIP)`);
  go.addEventListener('click', () => busy(go, 'Converting…', convert).then(() => { go.disabled = sel.size === 0; }));

  work.replaceChildren(
    h('div', { class: 'filebar' },
      h('div', { class: 'file-icon', html: ICONS.image }),
      h('div', { class: 'meta' }, h('div', { class: 'fname' }, doc.name), h('div', { class: 'finfo' }, `${plural(doc.pageCount, 'page')} · ${formatSize(doc.size)}`)),
      h('button', { type: 'button', class: 'btn ghost small', onclick: () => input.click() }, 'Choose another file')),
    h('div', { class: 'controls' },
      h('span', { class: 'ctl' }, h('span', { class: 'ctl-label' }, 'Format'), seg([['jpg', 'JPG'], ['png', 'PNG']], format, (v) => { format = v; })),
      h('span', { class: 'sep' }),
      h('label', { class: 'inline' }, 'Quality',
        h('select', { onchange: (e) => { quality = e.target.value; } }, QUALITIES.map((q) => h('option', { value: q.id, selected: q.id === quality }, q.label)))),
      h('span', { class: 'sep' }),
      h('label', { class: 'inline' }, 'Pages', rangeField, h('button', { type: 'button', class: 'btn outline small', onclick: applyRange }, 'Apply')),
      h('button', { type: 'button', class: 'link-btn', onclick: () => { sel = new Set(Array.from({ length: doc.pageCount }, (_, i) => i)); render(); } }, 'Select all'),
      sel.size > 0 && h('button', { type: 'button', class: 'link-btn', onclick: () => { sel.clear(); render(); } }, 'Clear')),
    h('div', { class: 'summary-box' }, sel.size
      ? ['Converting ', h('b', {}, `${plural(sel.size, 'page')} (${describePages([...sel])})`), ` to ${format.toUpperCase()}. Click pages to include or leave them out.`]
      : 'Click the pages you want to convert.'),
    grid,
    h('div', { class: 'actionbar' }, h('div', { class: 'grow' }), go),
    status,
  );
  if (focusI != null) grid.querySelector(`.thumb[data-i="${focusI}"]`)?.focus({ preventScroll: true });
}

async function convert() {
  const pages = [...sel].sort((a, b) => a - b);
  const q = QUALITIES.find((x) => x.id === quality);
  const type = format === 'png' ? 'image/png' : 'image/jpeg';
  const base = baseName(doc.name);
  const out = [];
  try {
    for (let k = 0; k < pages.length; k++) {
      status.set(`Converting page ${pages[k] + 1} (${k + 1} of ${pages.length})…`);
      const canvas = await renderPage(doc.pdfjs, pages[k], { scale: q.scale });
      out.push({ name: `${base}-page-${pages[k] + 1}.${format}`, blob: await canvasToBlob(canvas, type, 0.9) });
      canvas.width = canvas.height = 0;
    }
    if (out.length === 1) {
      download(out[0].blob, out[0].name);
      status.set(`Done! Downloaded ${out[0].name} (${formatSize(out[0].blob.size)}).`, 'ok');
    } else {
      const zip = new JSZip();
      out.forEach((o) => zip.file(o.name, o.blob));
      const blob = await zip.generateAsync({ type: 'blob' });
      download(blob, `${base}-images.zip`);
      status.set(`Done! Downloaded ${plural(out.length, 'image')} in ${base}-images.zip (${formatSize(blob.size)}).`, 'ok');
    }
  } catch (e) {
    console.error(e);
    status.set(`Something went wrong: ${e.message || e}`, 'err');
  }
}

work.addEventListener('click', (e) => {
  if (e.target.closest('button, input, select')) return;
  const t = e.target.closest('.thumb');
  if (!t) return;
  const i = Number(t.dataset.i);
  if (e.shiftKey && anchor !== null) for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) sel.add(k);
  else { sel.has(i) ? sel.delete(i) : sel.add(i); anchor = i; }
  render();
});
work.addEventListener('keydown', (e) => {
  const t = e.target.closest?.('.thumb');
  if (t && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); t.click(); }
});
