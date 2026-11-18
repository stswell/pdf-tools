// Split, Rotate, Delete pages and Extract pages: one PDF in, page grid, download.
import {
  h, $, plural, baseName, isPdf, formatSize, safeFileName, parseRange, describePages,
  download, pdfBlob, openPdf, ThumbQueue, pagePaper, setupFileInput, dropZone, statusLine, busy, ICONS,
} from './lib.js';

const tool = document.body.dataset.tool;
const root = $('#tool-root');
const queue = new ThumbQueue();
const PART_COLORS = ['#17386b', '#f08a24', '#2a9d8f', '#c0508a', '#7a5cc7', '#d4a017', '#4c9a2a', '#d0453a'];

let doc = null;
let sel = new Set();     // extract: chosen pages · delete: pages to remove · rotate: pages to act on
let anchor = null;
let rot = [];            // rotate: extra degrees per page
let cuts = new Set();    // split: cut after page i
let splitMode = 'custom';
let everyN = 2;
let extractAs = 'one';   // 'one' | 'each'
let nameTouched = false;

const status = statusLine();
const { drop, input } = dropZone({ title: 'Choose a PDF', sub: 'or drop it anywhere on this page' });
const work = h('section', { class: 'panel', hidden: true });
root.append(drop, work);
drop.after(status);

setupFileInput({
  drop, input, accept: isPdf,
  onFiles: (files) => load(files[0]),
  onRejected: () => status.set('Please choose a PDF file.', 'err'),
});

async function load(file) {
  status.set(`Opening ${file.name}…`);
  try {
    const d = await openPdf(file);
    d.id = `${Date.now()}`;
    queue.clear();
    doc = d;
    sel = new Set(); anchor = null; cuts = new Set(); nameTouched = false;
    rot = new Array(d.pageCount).fill(0);
    drop.hidden = true;
    work.hidden = false;
    status.set('');
    render();
  } catch (e) {
    status.set(e.message, 'err');
  }
}

// ---------------------------------------------------------------- per tool

const CONFIG = {
  rotate: {
    selectable: true,
    defaultName: () => `${baseName(doc.name)}-rotated`,
    controls() {
      const n = sel.size;
      const target = n ? `${n} selected` : 'all pages';
      return [
        h('button', { type: 'button', class: 'btn outline small', onclick: () => rotateMany(-90) }, h('span', { html: ICONS.rotL }), `Rotate ${target} left`),
        h('button', { type: 'button', class: 'btn outline small', onclick: () => rotateMany(90) }, h('span', { html: ICONS.rotR }), `Rotate ${target} right`),
        h('span', { class: 'sep' }),
        selectButtons(),
        rot.some(Boolean) && h('button', { type: 'button', class: 'link-btn', onclick: () => { rot.fill(0); render(); } }, 'Undo all rotations'),
      ];
    },
    summary() {
      const changed = rot.filter(Boolean).length;
      return changed
        ? [h('b', {}, plural(changed, 'page')), ' will be rotated.']
        : ['Hover a page and click ', h('b', {}, '↺'), ' or ', h('b', {}, '↻'), ', or select pages and use the buttons above.'];
    },
    ready: () => rot.some(Boolean),
    async build() {
      const out = await PDFLib.PDFDocument.load(doc.bytes);
      out.getPages().forEach((p, i) => {
        if (rot[i]) p.setRotation(PDFLib.degrees((((p.getRotation().angle + rot[i]) % 360) + 360) % 360));
      });
      return { blob: pdfBlob(await out.save()), ext: '.pdf' };
    },
  },

  delete: {
    selectable: true,
    defaultName: () => `${baseName(doc.name)}-edited`,
    controls: () => [rangePicker('Remove pages'), h('span', { class: 'sep' }), selectButtons('Mark all', 'Clear marks')],
    summary() {
      if (!sel.size) return ['Click the pages you want to remove.'];
      const left = doc.pageCount - sel.size;
      if (!left) return [h('b', {}, 'You can\'t remove every page.'), ' Leave at least one.'];
      return ['Removing ', h('b', {}, `${plural(sel.size, 'page')} (${describePages([...sel])})`), `. ${plural(left, 'page')} will remain.`];
    },
    ready: () => sel.size > 0 && sel.size < doc.pageCount,
    async build() {
      const src = await PDFLib.PDFDocument.load(doc.bytes);
      const keep = [...Array(doc.pageCount).keys()].filter((i) => !sel.has(i));
      return { blob: pdfBlob(await copyInto(src, keep)), ext: '.pdf' };
    },
  },

  extract: {
    selectable: true,
    defaultName: () => `${baseName(doc.name)}-pages-${describePages([...sel]).replace(/, /g, '_') || 'selected'}`,
    controls: () => [
      rangePicker('Select pages'),
      h('span', { class: 'sep' }),
      selectButtons(),
      h('span', { class: 'sep' }),
      seg([['one', 'One PDF'], ['each', 'One PDF per page (ZIP)']], extractAs, (v) => { extractAs = v; render(); }),
    ],
    summary() {
      if (!sel.size) return ['Click the pages you want to keep in the new file.'];
      return ['Extracting ', h('b', {}, `${plural(sel.size, 'page')} (${describePages([...sel])})`),
        extractAs === 'each' ? ` as ${plural(sel.size, 'separate PDF')} in a ZIP file.` : ' into one PDF.'];
    },
    ready: () => sel.size > 0,
    async build() {
      const src = await PDFLib.PDFDocument.load(doc.bytes);
      const pages = [...sel].sort((a, b) => a - b);
      if (extractAs === 'one') return { blob: pdfBlob(await copyInto(src, pages)), ext: '.pdf' };
      const zip = new JSZip();
      for (const p of pages) zip.file(`${baseName(doc.name)}-page-${p + 1}.pdf`, await copyInto(src, [p]));
      return { blob: await zip.generateAsync({ type: 'blob' }), ext: '.zip' };
    },
  },

  split: {
    selectable: false,
    defaultName: () => `${baseName(doc.name)}-split`,
    controls: () => [
      seg([['custom', 'Choose where to cut'], ['every', 'Every page'], ['n', 'Every N pages']], splitMode, (v) => { splitMode = v; render(); }),
      splitMode === 'n' && h('label', { class: 'inline' }, 'Pages per file',
        h('input', {
          type: 'number', min: 1, max: doc.pageCount, value: everyN,
          onchange: (e) => { everyN = Math.max(1, Math.min(doc.pageCount, Number(e.target.value) || 1)); render(); },
        })),
      splitMode === 'custom' && cuts.size > 0 && h('button', { type: 'button', class: 'link-btn', onclick: () => { cuts.clear(); render(); } }, 'Remove all cuts'),
    ],
    summary() {
      const parts = splitParts();
      if (parts.length < 2) {
        return doc.pageCount < 2
          ? ['This PDF has only one page, so there\'s nothing to split.']
          : ['Click ', h('b', {}, '✂'), ' between two pages to cut there.'];
      }
      return ['Will create ', h('b', {}, plural(parts.length, 'PDF')), ': ',
        parts.map(([a, b]) => (a === b ? `page ${a + 1}` : `pages ${a + 1}-${b + 1}`)).join(' · '), '. They download together as a ZIP file.'];
    },
    ready: () => splitParts().length > 1,
    async build() {
      const src = await PDFLib.PDFDocument.load(doc.bytes);
      const zip = new JSZip();
      const parts = splitParts();
      for (let k = 0; k < parts.length; k++) {
        const [a, b] = parts[k];
        const range = a === b ? `page ${a + 1}` : `pages ${a + 1}-${b + 1}`;
        zip.file(`${baseName(doc.name)}-part-${k + 1} (${range}).pdf`, await copyInto(src, range2list(a, b)));
      }
      return { blob: await zip.generateAsync({ type: 'blob' }), ext: '.zip' };
    },
  },
};

const cfg = CONFIG[tool];

// ---------------------------------------------------------------- helpers

async function copyInto(src, indices) {
  const out = await PDFLib.PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

const range2list = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => a + k);

function splitParts() {
  const n = doc.pageCount;
  let after;
  if (splitMode === 'every') after = range2list(0, n - 2);
  else if (splitMode === 'n') after = range2list(0, n - 2).filter((i) => (i + 1) % everyN === 0);
  else after = [...cuts].sort((a, b) => a - b);
  const parts = [];
  let start = 0;
  for (const c of after) { parts.push([start, c]); start = c + 1; }
  parts.push([start, n - 1]);
  return parts;
}

function rotateMany(deg) {
  const targets = sel.size ? [...sel] : range2list(0, doc.pageCount - 1);
  targets.forEach((i) => { rot[i] = (rot[i] + deg + 360) % 360; });
  render();
}

function seg(options, value, onChange) {
  return h('div', { class: 'seg', role: 'group' }, options.map(([v, label]) =>
    h('button', { type: 'button', 'aria-pressed': String(v === value), onclick: () => onChange(v) }, label)));
}

function selectButtons(allLabel = 'Select all', noneLabel = 'Clear selection') {
  return h('span', { class: 'inline' },
    h('button', { type: 'button', class: 'link-btn', onclick: () => { sel = new Set(range2list(0, doc.pageCount - 1)); render(); } }, allLabel),
    sel.size > 0 && h('button', { type: 'button', class: 'link-btn', style: 'margin-left:10px', onclick: () => { sel.clear(); render(); } }, noneLabel));
}

function rangePicker(label) {
  const field = h('input', { type: 'text', placeholder: 'e.g. 1-3, 5', spellcheck: false, 'aria-label': label });
  const apply = () => {
    try {
      const list = parseRange(field.value, doc.pageCount);
      if (!list.length) return;
      sel = new Set(list);
      render();
      status.set('');
    } catch (e) { status.set(e.message, 'err'); field.focus(); }
  };
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  return h('label', { class: 'inline' }, label, field,
    h('button', { type: 'button', class: 'btn outline small', onclick: apply }, 'Apply'));
}

// ---------------------------------------------------------------- render

function render() {
  const focusI = document.activeElement?.closest?.('.thumb')?.dataset.i;
  const nameInput = work.querySelector('#outname');
  const typedName = nameTouched && nameInput ? nameInput.value : null;

  const filebar = h('div', { class: 'filebar' },
    h('div', { class: 'file-icon', html: ICONS[{ rotate: 'rotate', delete: 'trash', extract: 'extract', split: 'split' }[tool]] }),
    h('div', { class: 'meta' },
      h('div', { class: 'fname', title: doc.name }, doc.name),
      h('div', { class: 'finfo' }, `${plural(doc.pageCount, 'page')} · ${formatSize(doc.size)}`)),
    h('button', { type: 'button', class: 'btn ghost small', onclick: () => input.click() }, 'Choose another file'),
  );

  const parts = tool === 'split' ? splitParts() : null;
  const partOf = (i) => parts.findIndex(([a, b]) => i >= a && i <= b);

  const grid = h('div', { class: 'grid pages-grid' });
  for (let i = 0; i < doc.pageCount; i++) {
    const selected = sel.has(i);
    const cell = h('div', {
      class: 'thumb split-cell' + (cfg.selectable && selected ? (tool === 'delete' ? ' marked' : ' selected') : ''),
      tabIndex: cfg.selectable ? 0 : -1,
      'data-i': i,
      role: cfg.selectable ? 'checkbox' : null,
      'aria-checked': cfg.selectable ? String(selected) : null,
      'aria-label': `Page ${i + 1}`,
    });

    if (tool === 'split') {
      const p = partOf(i);
      cell.style.setProperty('--pc', PART_COLORS[p % PART_COLORS.length]);
      if (parts.length > 1 && parts[p][0] === i) cell.append(h('span', { class: 'part-tag' }, `Part ${p + 1}`));
    }

    cell.append(pagePaper(queue, doc, i, rot[i]));

    if (tool === 'rotate') {
      cell.append(h('div', { class: 'ptools' },
        h('button', { type: 'button', class: 'icon-btn', title: 'Rotate left', 'aria-label': `Rotate page ${i + 1} left`, html: ICONS.rotL, onclick: () => { rot[i] = (rot[i] + 270) % 360; render(); } }),
        h('button', { type: 'button', class: 'icon-btn', title: 'Rotate right', 'aria-label': `Rotate page ${i + 1} right`, html: ICONS.rotR, onclick: () => { rot[i] = (rot[i] + 90) % 360; render(); } }),
      ));
    }
    if (tool === 'delete' && selected) cell.append(h('span', { class: 'mark-x', html: ICONS.trash }));
    if (cfg.selectable && tool !== 'delete') cell.append(h('span', { class: 'check', 'aria-hidden': 'true' }, '✓'));

    if (tool === 'split' && i < doc.pageCount - 1) {
      const on = parts.some(([, b]) => b === i);
      cell.append(h('button', {
        type: 'button', class: 'cut' + (on ? ' on' : ''),
        title: on ? 'Remove this cut' : 'Cut here', 'aria-label': `${on ? 'Remove cut' : 'Cut'} after page ${i + 1}`,
        'aria-pressed': String(on), html: ICONS.scissors,
        onclick: () => {
          if (splitMode !== 'custom') { cuts = new Set(splitParts().slice(0, -1).map(([, b]) => b)); splitMode = 'custom'; }
          cuts.has(i) ? cuts.delete(i) : cuts.add(i);
          render();
        },
      }));
    }
    cell.append(h('span', { class: 'pnum' }, `Page ${i + 1}${rot[i] ? ` · ${rot[i]}°` : ''}`));
    grid.append(cell);
  }

  const nameField = h('input', {
    id: 'outname', type: 'text', spellcheck: false, autocomplete: 'off',
    value: typedName ?? cfg.defaultName(),
    oninput: () => { nameTouched = true; },
  });
  const ext = (tool === 'split' || (tool === 'extract' && extractAs === 'each')) ? '.zip' : '.pdf';
  const go = h('button', { type: 'button', class: 'btn primary', disabled: !cfg.ready() },
    h('span', { html: ICONS.download }), ext === '.zip' ? 'Download ZIP' : 'Download PDF');
  go.addEventListener('click', () => busy(go, 'Working…', async () => {
    try {
      const { blob, ext: e } = await cfg.build();
      const name = safeFileName(nameField.value, e);
      download(blob, name);
      status.set(`Done! Downloaded ${name} (${formatSize(blob.size)}).`, 'ok');
    } catch (err) {
      console.error(err);
      status.set(`Something went wrong: ${err.message || err}`, 'err');
    }
  }).then(() => { go.disabled = !cfg.ready(); }));

  work.replaceChildren(
    filebar,
    h('div', { class: 'controls' }, cfg.controls()),
    h('div', { class: 'summary-box' }, cfg.summary()),
    grid,
    h('div', { class: 'actionbar' },
      h('label', { class: 'field grow' }, h('span', {}, 'File name'), nameField),
      go),
    status,
  );

  if (focusI != null) grid.querySelector(`.thumb[data-i="${focusI}"]`)?.focus({ preventScroll: true });
}

// Click / Shift+click / keyboard selection on the page grid.
work.addEventListener('click', (e) => {
  if (!cfg?.selectable || e.target.closest('button')) return;
  const t = e.target.closest('.thumb');
  if (t) toggle(Number(t.dataset.i), e.shiftKey);
});
work.addEventListener('keydown', (e) => {
  const t = e.target.closest?.('.thumb');
  if (!t || !cfg.selectable || (e.key !== ' ' && e.key !== 'Enter')) return;
  e.preventDefault();
  toggle(Number(t.dataset.i), e.shiftKey);
});

function toggle(i, shift) {
  if (shift && anchor !== null) {
    for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) sel.add(k);
  } else {
    sel.has(i) ? sel.delete(i) : sel.add(i);
    anchor = i;
  }
  render();
}

if (!cfg) status.set('Unknown tool.', 'err');
