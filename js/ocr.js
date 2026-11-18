// OCR: recognise text on scanned pages and add it to the PDF as an invisible,
// searchable layer on top of the original page (the page itself is untouched).
// Recognition runs locally with Tesseract (WebAssembly). Only the recognition
// model is downloaded from a public CDN; documents never leave the computer.
import {
  h, $, plural, baseName, isPdf, formatSize, safeFileName, download, pdfBlob, openPdf,
  renderPage, setupFileInput, dropZone, statusLine, ICONS,
} from './lib.js';

const root = $('#tool-root');
const status = statusLine();
const { drop, input } = dropZone({
  title: 'Choose a scanned PDF', sub: 'or drop it anywhere on this page',
  note: 'Text recognition runs on this computer. The first run downloads the recognition model (about 10–20 MB); your document is never uploaded.',
});
const work = h('section', { class: 'panel', hidden: true });
root.append(drop, work);
drop.after(status);

let doc = null;
let lang = 'eng';
let skipText = true;
let running = false;
let result = null;
let progress = { page: 0, pct: 0, text: '' };

setupFileInput({
  drop, input, accept: isPdf,
  onFiles: async (files) => {
    if (running) return;
    status.set(`Opening ${files[0].name}…`);
    try {
      doc = await openPdf(files[0]);
      result = null;
      drop.hidden = true; work.hidden = false; status.set('');
      render();
    } catch (e) { status.set(e.message, 'err'); }
  },
  onRejected: () => status.set('Please choose a PDF file.', 'err'),
});

function render() {
  const go = h('button', { type: 'button', class: 'btn primary', disabled: running }, running ? 'Recognizing…' : 'Make searchable');
  go.addEventListener('click', run);

  work.replaceChildren(
    h('div', { class: 'filebar' },
      h('div', { class: 'file-icon', html: ICONS.ocr }),
      h('div', { class: 'meta' }, h('div', { class: 'fname' }, doc.name), h('div', { class: 'finfo' }, `${plural(doc.pageCount, 'page')} · ${formatSize(doc.size)}`)),
      !running && h('button', { type: 'button', class: 'btn ghost small', onclick: () => input.click() }, 'Choose another file')),
    h('div', { class: 'controls' },
      h('label', { class: 'inline' }, 'Language',
        h('select', { disabled: running, onchange: (e) => { lang = e.target.value; } },
          [['eng', 'English'], ['spa', 'Spanish'], ['eng+spa', 'English + Spanish']].map(([v, l]) => h('option', { value: v, selected: v === lang }, l)))),
      h('span', { class: 'sep' }),
      h('label', { class: 'inline' },
        h('input', { type: 'checkbox', checked: skipText, disabled: running, onchange: (e) => { skipText = e.target.checked; } }),
        'Skip pages that already have text')),
    h('div', { class: 'summary-box' },
      'The pages will look exactly the same. Hidden text is added on top so you can search (Ctrl+F), select and copy. Takes a few seconds per page.'),
    running && h('div', {},
      h('div', { class: 'progress' }, h('div', { style: `width:${Math.round(progress.pct * 100)}%` })),
      h('p', { class: 'hint', style: 'margin-top:8px' }, progress.text)),
    result && h('div', { class: 'result' },
      h('div', { class: 'file-icon', html: ICONS.ocr }),
      h('div', { class: 'meta' }, h('div', { class: 'fname' }, result.name), h('div', { class: 'finfo' }, result.info)),
      h('button', { type: 'button', class: 'btn primary small', onclick: () => download(result.blob, result.name) }, h('span', { html: ICONS.download }), 'Download')),
    h('div', { class: 'actionbar' }, h('div', { class: 'grow' }), go),
    status,
  );
}

const setProgress = (pct, text) => { progress = { pct, text }; render(); };

async function run() {
  running = true; result = null; status.set('');
  setProgress(0, 'Loading the text recognizer…');
  let worker;
  try {
    worker = await Tesseract.createWorker(lang, 1, {
      logger: (m) => {
        if (m.status === 'loading language traineddata') setProgress(0, `Downloading the ${lang} recognition model (first time only)…`);
      },
    });
    const out = await PDFLib.PDFDocument.load(doc.bytes);
    const font = await out.embedFont(PDFLib.StandardFonts.Helvetica);
    const pages = out.getPages();
    let done = 0, skipped = 0, words = 0;

    for (let i = 0; i < doc.pageCount; i++) {
      const page = await doc.pdfjs.getPage(i + 1);
      if (skipText) {
        const tc = await page.getTextContent();
        if (tc.items.map((t) => t.str).join('').trim().length > 20) { skipped++; continue; }
      }
      setProgress(i / doc.pageCount, `Reading page ${i + 1} of ${doc.pageCount}…`);
      const SCALE = 3; // ≈216 dpi: good accuracy without being slow
      const canvas = await renderPage(doc.pdfjs, i, { scale: SCALE });
      const { data } = await worker.recognize(canvas);
      canvas.width = canvas.height = 0;
      const vp = page.getViewport({ scale: SCALE });
      words += addInvisibleText(pages[i], data.words || [], vp, font);
      done++;
    }

    const bytes = await out.save();
    const name = safeFileName(`${baseName(doc.name)}-searchable`);
    result = {
      name, blob: pdfBlob(bytes),
      info: `${plural(done, 'page')} recognized` + (skipped ? `, ${plural(skipped, 'page')} skipped (already had text)` : '') + ` · ${plural(words, 'word')} · ${formatSize(bytes.length)}`,
    };
    status.set(done ? 'Done! Download the searchable PDF below.' : 'Every page already had text, so nothing needed to be recognized.', done ? 'ok' : '');
  } catch (e) {
    console.error(e);
    status.set(/fetch|network|load/i.test(String(e?.message || e))
      ? 'Couldn\'t download the text recognizer. Check the internet connection and try again.'
      : `Something went wrong: ${e.message || e}`, 'err');
  } finally {
    await worker?.terminate();
    running = false;
    render();
  }
}

/** Place each recognized word, invisible, exactly over where it appears on the page. */
function addInvisibleText(pdfPage, words, viewport, font) {
  let n = 0;
  for (const w of words) {
    const text = clean(w.text, font);
    if (!text || w.confidence < 30) continue;
    const { x0, y0, x1, y1 } = w.bbox;
    // Baseline start and end of the word, converted from image pixels to PDF points.
    const [ax, ay] = viewport.convertToPdfPoint(x0, y1);
    const [bx, by] = viewport.convertToPdfPoint(x1, y1);
    const [cx, cy] = viewport.convertToPdfPoint(x0, y0);
    const width = Math.hypot(bx - ax, by - ay);
    const height = Math.hypot(cx - ax, cy - ay);
    if (width < 1 || height < 1) continue;
    const angle = Math.atan2(by - ay, bx - ax) * 180 / Math.PI;
    const size = Math.min(height * 1.15, width / Math.max(0.01, font.widthOfTextAtSize(text, 1)));
    pdfPage.drawText(text, { x: ax, y: ay, size, font, opacity: 0, rotate: PDFLib.degrees(angle) });
    n++;
  }
  return n;
}

/** Keep only characters the standard font can encode. */
function clean(s, font) {
  const out = [];
  for (const ch of String(s || '').trim()) {
    try { font.encodeText(ch); out.push(ch); } catch { /* skip characters Helvetica can't show */ }
  }
  return out.join('');
}
