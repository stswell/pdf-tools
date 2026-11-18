// Compress PDFs in the browser.
//  basic       – lossless re-save (object streams, drops unused objects)
//  recommended – re-encode large embedded images as smaller JPEGs; text stays as text
//  strong      – re-draw every page as a JPEG (smallest, but text is no longer selectable)
import {
  h, $, plural, baseName, isPdf, formatSize, safeFileName, download, pdfBlob, renderPage, pdfjsOpen,
  canvasToBlob, setupFileInput, dropZone, statusLine, ICONS,
} from './lib.js';

const root = $('#tool-root');
const status = statusLine();
const { drop, input } = dropZone({
  title: 'Choose PDFs', sub: 'or drop them anywhere on this page', multiple: true,
  note: 'Works best on scanned documents and PDFs with photos. Text-only PDFs are usually small already.',
});

const LEVELS = [
  { id: 'basic', name: 'Basic', desc: 'Lossless clean-up. Nothing changes visually; small savings.' },
  { id: 'recommended', name: 'Recommended', desc: 'Shrinks photos and scans inside the PDF. Text stays sharp and selectable.' },
  { id: 'strong', name: 'Strong', desc: 'Smallest file. Pages become images, so text can no longer be selected or searched.' },
];
let level = 'recommended';
let files = [];   // { file, result: {blob,name}|null, state, note }

const panel = h('section', { class: 'panel', hidden: true });
root.append(drop, panel);
drop.after(status);

setupFileInput({
  drop, input, accept: isPdf,
  onFiles: (fs) => { files.push(...fs.map((file) => ({ file, result: null, state: 'ready' }))); render(); },
  onRejected: (n) => status.set(`Ignored ${plural(n, 'file')} that ${n === 1 ? "isn't a PDF" : "aren't PDFs"}.`, 'err'),
});

function render() {
  drop.hidden = files.length > 0;
  panel.hidden = files.length === 0;
  const running = files.some((f) => f.state === 'working');

  const options = h('div', { class: 'options', role: 'radiogroup', 'aria-label': 'Compression level' },
    LEVELS.map((l) => h('label', { class: 'option' },
      h('input', {
        type: 'radio', name: 'level', value: l.id, checked: l.id === level, disabled: running,
        onchange: () => { level = l.id; files.forEach((f) => { f.result = null; f.state = 'ready'; f.note = ''; }); render(); },
      }),
      h('span', {}, h('b', {}, l.name), h('small', {}, l.desc)))));

  const rows = h('div', { class: 'results' }, files.map((f, idx) => {
    const r = f.result;
    let info = formatSize(f.file.size);
    if (r) {
      const saved = 1 - r.blob.size / f.file.size;
      info = h('span', {}, `${formatSize(f.file.size)} → ${formatSize(r.blob.size)} `,
        saved > 0.005 ? h('span', { class: 'saving' }, `(${Math.round(saved * 100)}% smaller)`) : h('span', {}, '(already as small as it gets)'));
    } else if (f.state === 'working') info = `${formatSize(f.file.size)} · ${f.note || 'Working…'}`;
    else if (f.state === 'error') info = h('span', { class: 'err-text' }, f.note);

    return h('div', { class: 'result' },
      h('div', { class: 'file-icon', html: ICONS.compress }),
      h('div', { class: 'meta' },
        h('div', { class: 'fname', title: f.file.name }, f.file.name),
        h('div', { class: 'finfo' }, info),
        f.state === 'working' && h('div', { class: 'progress' }, h('div', { style: `width:${Math.round((f.progress || 0) * 100)}%` }))),
      r && h('button', { type: 'button', class: 'btn primary small', onclick: () => download(r.blob, r.name) }, h('span', { html: ICONS.download }), 'Download'),
      !running && h('button', {
        type: 'button', class: 'icon-btn danger', title: 'Remove', 'aria-label': `Remove ${f.file.name}`, html: ICONS.x,
        onclick: () => { files.splice(idx, 1); render(); },
      }),
    );
  }));

  const done = files.filter((f) => f.result);
  const go = h('button', { type: 'button', class: 'btn primary', disabled: running || files.every((f) => f.result) },
    running ? 'Compressing…' : `Compress ${plural(files.length, 'file')}`);
  go.addEventListener('click', compressAll);

  panel.replaceChildren(
    h('div', { class: 'panel-head' },
      h('h2', {}, 'Compression level'),
      h('div', { class: 'head-actions' },
        h('button', { type: 'button', class: 'btn ghost small', disabled: running, onclick: () => { files = []; render(); status.set(''); } }, 'Clear all'),
        h('button', { type: 'button', class: 'btn outline small', disabled: running, onclick: () => input.click() }, '+ Add PDFs'))),
    options,
    level === 'strong' && h('div', { class: 'summary-box warn' }, h('b', {}, 'Heads up: '), 'Strong compression turns every page into a picture. Use it for scans and photos, not for documents people need to search or copy text from.'),
    rows,
    h('div', { class: 'actionbar' },
      h('div', { class: 'grow' }),
      done.length > 1 && h('button', { type: 'button', class: 'btn outline', onclick: downloadAll }, 'Download all (ZIP)'),
      go),
    status,
  );
}

async function downloadAll() {
  const zip = new JSZip();
  for (const f of files) if (f.result) zip.file(f.result.name, f.result.blob);
  download(await zip.generateAsync({ type: 'blob' }), 'compressed-pdfs.zip');
}

async function compressAll() {
  status.set('');
  for (const f of files) {
    if (f.result) continue;
    f.state = 'working'; f.progress = 0; f.note = 'Reading…';
    render();
    try {
      const bytes = new Uint8Array(await f.file.arrayBuffer());
      const onProgress = (p, note) => { f.progress = p; if (note) f.note = note; render(); };
      let out = level === 'strong' ? await rasterize(bytes, onProgress) : await recompress(bytes, level === 'recommended', onProgress);
      // Never hand back something bigger than what came in.
      const blob = out.length < f.file.size ? pdfBlob(out) : f.file;
      f.result = { blob, name: safeFileName(`${baseName(f.file.name)}-compressed`) };
      f.state = 'done';
    } catch (e) {
      console.error(e);
      f.state = 'error';
      f.note = /encrypt/i.test(e.message) ? 'Password-protected. Remove the password and try again.' : `Couldn't compress: ${e.message}`;
    }
    render();
  }
  const total = files.reduce((n, f) => n + f.file.size, 0);
  const after = files.reduce((n, f) => n + (f.result?.blob.size ?? f.file.size), 0);
  if (files.some((f) => f.result)) status.set(`Done. ${formatSize(total)} → ${formatSize(after)} in total.`, 'ok');
}

// ------------------------------------------------------------ strong

async function rasterize(bytes, onProgress) {
  const pdf = await pdfjsOpen(bytes.slice());
  const out = await PDFLib.PDFDocument.create();
  for (let i = 0; i < pdf.numPages; i++) {
    onProgress(i / pdf.numPages, `Page ${i + 1} of ${pdf.numPages}…`);
    const page = await pdf.getPage(i + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const canvas = await renderPage(pdf, i, { scale: 1.5 }); // ≈108 dpi
    const jpg = await out.embedJpg(new Uint8Array(await (await canvasToBlob(canvas, 'image/jpeg', 0.6)).arrayBuffer()));
    const p = out.addPage([vp1.width, vp1.height]);
    p.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    canvas.width = canvas.height = 0;
  }
  pdf.destroy();
  return out.save();
}

// ------------------------------------------------------------ basic / recommended

async function recompress(bytes, images, onProgress) {
  const { PDFDocument, PDFName, PDFRawStream, PDFNumber, PDFArray, PDFDict } = PDFLib;
  const doc = await PDFDocument.load(bytes);
  if (images) {
    const ctx = doc.context;
    const imgs = ctx.enumerateIndirectObjects().filter(([, obj]) =>
      obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
    let k = 0;
    for (const [ref, obj] of imgs) {
      onProgress(k++ / Math.max(1, imgs.length), `Image ${k} of ${imgs.length}…`);
      try {
        const smaller = await shrinkImage(obj, ctx, { PDFName, PDFNumber, PDFArray, PDFDict });
        if (smaller) ctx.assign(ref, PDFRawStream.of(smaller.dict, smaller.bytes));
      } catch (e) {
        console.warn('Skipped an image:', e);
      }
    }
  }
  onProgress(1, 'Saving…');
  return doc.save({ useObjectStreams: true });
}

const MAX_SIDE = 1700;   // px; ~150 dpi for a full letter page
const QUALITY = 0.7;

async function shrinkImage(stream, ctx, { PDFName, PDFNumber, PDFArray, PDFDict }) {
  const d = stream.dict;
  const num = (k) => d.lookup(PDFName.of(k))?.asNumber?.();
  const w = num('Width'), hgt = num('Height'), bpc = num('BitsPerComponent');
  if (!w || !hgt || stream.contents.length < 30 * 1024) return null;            // small already
  if (d.has(PDFName.of('ImageMask')) || d.has(PDFName.of('Decode')) || d.has(PDFName.of('Mask'))) return null;

  // Colour space -> number of components (only plain gray/RGB are handled).
  let cs = d.lookup(PDFName.of('ColorSpace'));
  let comps = null;
  if (cs === PDFName.of('DeviceRGB')) comps = 3;
  else if (cs === PDFName.of('DeviceGray')) comps = 1;
  else if (cs instanceof PDFArray && cs.lookup(0) === PDFName.of('ICCBased')) {
    const n = cs.lookup(1)?.dict?.lookup(PDFName.of('N'))?.asNumber?.();
    if (n === 1 || n === 3) comps = n;
  }
  if (!comps) return null;

  let filter = d.lookup(PDFName.of('Filter'));
  if (filter instanceof PDFArray) filter = filter.size() === 1 ? filter.lookup(0) : null;

  let bitmap;
  if (filter === PDFName.of('DCTDecode')) {
    bitmap = await createImageBitmap(new Blob([stream.contents], { type: 'image/jpeg' }));
  } else if (filter === PDFName.of('FlateDecode') && bpc === 8) {
    let raw = await inflate(stream.contents);
    const parms = d.lookup(PDFName.of('DecodeParms'));
    const predictor = parms instanceof PDFDict ? parms.lookup(PDFName.of('Predictor'))?.asNumber?.() : 1;
    if (predictor >= 10) raw = unPredictPng(raw, comps, w);
    else if (predictor > 1) return null;
    if (raw.length < w * hgt * comps) return null;
    const rgba = new Uint8ClampedArray(w * hgt * 4);
    for (let p = 0, q = 0; p < w * hgt; p++, q += comps) {
      rgba[p * 4] = raw[q];
      rgba[p * 4 + 1] = comps === 3 ? raw[q + 1] : raw[q];
      rgba[p * 4 + 2] = comps === 3 ? raw[q + 2] : raw[q];
      rgba[p * 4 + 3] = 255;
    }
    bitmap = await createImageBitmap(new ImageData(rgba, w, hgt));
  } else {
    return null;
  }

  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const nw = Math.max(1, Math.round(bitmap.width * scale));
  const nh = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = nw; canvas.height = nh;
  const c2d = canvas.getContext('2d');
  c2d.fillStyle = '#fff';
  c2d.fillRect(0, 0, nw, nh);
  c2d.drawImage(bitmap, 0, 0, nw, nh);
  bitmap.close?.();
  const jpeg = new Uint8Array(await (await canvasToBlob(canvas, 'image/jpeg', QUALITY)).arrayBuffer());
  canvas.width = canvas.height = 0;
  if (jpeg.length > stream.contents.length * 0.9) return null;                 // not worth it

  const nd = d.clone(ctx);
  nd.set(PDFName.of('Width'), PDFNumber.of(nw));
  nd.set(PDFName.of('Height'), PDFNumber.of(nh));
  nd.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
  nd.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
  nd.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
  nd.delete(PDFName.of('DecodeParms'));
  nd.set(PDFName.of('Length'), PDFNumber.of(jpeg.length));
  return { dict: nd, bytes: jpeg };
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Undo PNG row filters (PDF Predictor >= 10) for 8-bit samples. */
function unPredictPng(data, comps, columns) {
  const bpp = comps;
  const rowLen = columns * comps;
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = r * (rowLen + 1) + 1;
    const dst = r * rowLen;
    const prev = dst - rowLen;
    for (let i = 0; i < rowLen; i++) {
      const x = data[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = r > 0 ? out[prev + i] : 0;
      const c = r > 0 && i >= bpp ? out[prev + i - bpp] : 0;
      let v;
      switch (type) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('Unknown PNG filter');
      }
      out[dst + i] = v & 255;
    }
  }
  return out;
}
