// Images -> one PDF. Photos are drawn through a canvas first so phone pictures
// come out the right way up (the browser applies the EXIF orientation for us).
import { h, $, plural, isImage, formatSize, safeFileName, download, pdfBlob, canvasToBlob, setupFileInput, dropZone, statusLine, busy, ICONS } from './lib.js';

const root = $('#tool-root');
const status = statusLine();
const { drop, input } = dropZone({
  title: 'Choose images', sub: 'or drop them anywhere on this page', multiple: true,
  accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp,.png,.jpg,.jpeg,.webp,.gif,.bmp',
  note: 'JPG, PNG, WebP, GIF and BMP. Each image becomes one page.',
});
const work = h('section', { class: 'panel', hidden: true });
root.append(drop, work);
drop.after(status);

const SIZES = { fit: null, letter: [612, 792], a4: [595.28, 841.89], legal: [612, 1008] };
const MARGINS = { none: 0, small: 18, large: 48 };
let images = [];   // { id, file, url }
let size = 'letter', orient = 'auto', margin = 'small';
let nextId = 1;

setupFileInput({
  drop, input, accept: isImage,
  onFiles: (files) => {
    images.push(...files.map((file) => ({ id: nextId++, file, url: URL.createObjectURL(file) })));
    drop.hidden = true; work.hidden = false;
    render();
  },
  onRejected: (n) => status.set(`Ignored ${plural(n, 'file')} that ${n === 1 ? "isn't an image" : "aren't images"}.`, 'err'),
});

function render() {
  if (!images.length) { drop.hidden = false; work.hidden = true; return; }
  const seg = (opts, value, set) => h('div', { class: 'seg', role: 'group' }, opts.map(([v, l]) =>
    h('button', { type: 'button', 'aria-pressed': String(v === value), onclick: () => { set(v); render(); } }, l)));

  const grid = h('div', { class: 'grid pages-grid' }, images.map((im, i) =>
    h('div', { class: 'thumb', 'data-i': i },
      h('span', { class: 'pos' }, String(i + 1)),
      h('div', { class: 'ptools' },
        h('button', { type: 'button', class: 'icon-btn', title: 'Move earlier', 'aria-label': `Move ${im.file.name} earlier`, disabled: i === 0, onclick: () => move(i, i - 1) }, '←'),
        h('button', { type: 'button', class: 'icon-btn', title: 'Move later', 'aria-label': `Move ${im.file.name} later`, disabled: i === images.length - 1, onclick: () => move(i, i + 1) }, '→'),
        h('button', { type: 'button', class: 'icon-btn danger', title: 'Remove', 'aria-label': `Remove ${im.file.name}`, html: ICONS.x, onclick: () => { URL.revokeObjectURL(im.url); images.splice(i, 1); render(); } })),
      h('div', { class: 'paper' }, h('img', { src: im.url, alt: '', draggable: false })),
      h('span', { class: 'label', title: im.file.name }, im.file.name))));

  const name = h('input', { id: 'outname', type: 'text', value: work.querySelector('#outname')?.value || 'images.pdf', spellcheck: false });
  const go = h('button', { type: 'button', class: 'btn primary' }, h('span', { html: ICONS.download }), 'Download PDF');
  go.addEventListener('click', () => busy(go, 'Building…', () => build(name.value)));

  work.replaceChildren(
    h('div', { class: 'panel-head' },
      h('h2', {}, `${plural(images.length, 'image')}`),
      h('div', { class: 'head-actions' },
        h('button', { type: 'button', class: 'btn ghost small', onclick: () => { images.forEach((im) => URL.revokeObjectURL(im.url)); images = []; render(); status.set(''); } }, 'Clear all'),
        h('button', { type: 'button', class: 'btn outline small', onclick: () => input.click() }, '+ Add images'))),
    h('div', { class: 'controls' },
      h('span', { class: 'ctl' }, h('span', { class: 'ctl-label' }, 'Page size'), seg([['letter', 'Letter'], ['a4', 'A4'], ['legal', 'Legal'], ['fit', 'Same as image']], size, (v) => { size = v; })),
      size !== 'fit' && h('span', { class: 'ctl' }, h('span', { class: 'ctl-label' }, 'Orientation'),
        seg([['auto', 'Auto'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], orient, (v) => { orient = v; })),
      size !== 'fit' && h('span', { class: 'ctl' }, h('span', { class: 'ctl-label' }, 'Margin'), seg([['none', 'None'], ['small', 'Small'], ['large', 'Large']], margin, (v) => { margin = v; }))),
    h('div', { class: 'summary-box' }, 'Pages follow the order shown. Hover an image to move or remove it.'),
    grid,
    h('div', { class: 'actionbar' }, h('label', { class: 'field grow' }, h('span', {}, 'File name'), name), go),
    status,
  );
}

function move(from, to) {
  const [it] = images.splice(from, 1);
  images.splice(to, 0, it);
  render();
}

async function build(fileName) {
  try {
    const out = await PDFLib.PDFDocument.create();
    for (let k = 0; k < images.length; k++) {
      const im = images[k];
      status.set(`Adding image ${k + 1} of ${images.length}…`);
      const bitmap = await createImageBitmap(im.file).catch(() => { throw new Error(`${im.file.name} couldn't be read as an image.`); });
      // Keep large photos reasonable (max 3000 px on the long side).
      const scale = Math.min(1, 3000 / Math.max(bitmap.width, bitmap.height));
      const cw = Math.round(bitmap.width * scale), ch = Math.round(bitmap.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext('2d');
      const isPng = /png|gif|bmp/i.test(im.file.type) || /\.(png|gif|bmp)$/i.test(im.file.name);
      if (!isPng) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); }
      ctx.drawImage(bitmap, 0, 0, cw, ch);
      bitmap.close?.();
      const bytes = new Uint8Array(await (await canvasToBlob(canvas, isPng ? 'image/png' : 'image/jpeg', 0.9)).arrayBuffer());
      canvas.width = canvas.height = 0;
      const img = isPng ? await out.embedPng(bytes) : await out.embedJpg(bytes);

      // Page size: image size at 96 dpi, or a paper size in the chosen orientation.
      let pw, ph;
      if (size === 'fit') { pw = cw * 0.75; ph = ch * 0.75; }
      else {
        [pw, ph] = SIZES[size];
        const landscape = orient === 'landscape' || (orient === 'auto' && cw > ch);
        if (landscape) [pw, ph] = [ph, pw];
      }
      const m = size === 'fit' ? 0 : MARGINS[margin];
      const s = Math.min((pw - 2 * m) / img.width, (ph - 2 * m) / img.height, size === 'fit' ? 0.75 : Infinity);
      const w = img.width * s, hh = img.height * s;
      const page = out.addPage([pw, ph]);
      page.drawImage(img, { x: (pw - w) / 2, y: (ph - hh) / 2, width: w, height: hh });
    }
    const bytes = await out.save();
    const name = safeFileName(fileName || 'images');
    download(pdfBlob(bytes), name);
    status.set(`Done! ${name} has ${plural(images.length, 'page')} (${formatSize(bytes.length)}).`, 'ok');
  } catch (e) {
    console.error(e);
    status.set(e.message || String(e), 'err');
  }
}
