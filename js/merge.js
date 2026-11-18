(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    picker: $('picker'),
    picker2: $('picker2'),
    drop: $('drop'),
    srcHint: $('src-hint'),
    sources: $('sources'),
    outPanel: $('out-panel'),
    outScroll: $('out-scroll'),
    outEmpty: $('out-empty'),
    outGrid: $('out-grid'),
    outCount: $('out-count'),
    outClear: $('out-clear'),
    clearAll: $('clear-all'),
    outHint: $('out-hint'),
    addEverything: $('add-everything'),
    outname: $('outname'),
    merge: $('merge'),
    status: $('status'),
  };

  if (!window.PDFLib || !window.pdfjsLib) {
    setStatus('Could not load the PDF tools. Check your internet connection and reload the page.', 'err');
    els.drop.style.pointerEvents = 'none';
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const { PDFDocument, degrees } = PDFLib;

  // Colors used to tell source files apart (orange & navy first, from the brand).
  const COLORS = ['#f08a24', '#2f6fb5', '#2a9d8f', '#c0508a', '#7a5cc7', '#d4a017', '#4c9a2a', '#d0453a'];

  /**
   * @typedef {{id:number,name:string,size:number,color:string,lib:any,pdfjs:any,
   *   pageCount:number,thumbs:(string|null|'none')[],selected:Set<number>,anchor:number|null,
   *   collapsed:boolean,error:string|null}} Source
   * @typedef {{uid:number,srcId:number,page:number,rot:number}} OutPage
   */
  /** @type {Source[]} */ let sources = [];
  /** @type {OutPage[]} */ let output = [];
  const outSel = new Set();
  let outAnchor = null;
  let nextId = 1;
  let nextUid = 1;
  let colorIdx = 0;

  // ---------- small helpers ----------

  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'role') el.setAttribute(k, v);
      else el[k] = v;
    }
    el.append(...kids.flat().filter((k) => k != null && k !== false));
    return el;
  }

  function setStatus(msg, kind = '') {
    els.status.textContent = msg;
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const byId = (id) => sources.find((s) => s.id === id);
  const shortName = (name) => name.replace(/\.pdf$/i, '');

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

  // ---------- loading files ----------

  async function addFiles(fileList) {
    const files = Array.from(fileList);
    const pdfs = files.filter(isPdf);
    const skipped = files.length - pdfs.length;
    if (!pdfs.length) {
      if (skipped) setStatus('Only PDF files can be added.', 'err');
      return;
    }
    setStatus(`Reading ${plural(pdfs.length, 'file')}…`);

    let bad = 0;
    for (const file of pdfs) {
      /** @type {Source} */
      const src = {
        id: nextId++, name: file.name, size: file.size,
        color: COLORS[colorIdx++ % COLORS.length],
        lib: null, pdfjs: null, pageCount: 0, thumbs: [],
        selected: new Set(), anchor: null, collapsed: false, error: null,
      };
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        src.lib = await PDFDocument.load(bytes);
        src.pageCount = src.lib.getPageCount();
        src.thumbs = new Array(src.pageCount).fill(null);
        try {
          // pdf.js takes ownership of the buffer it gets, so give it a copy.
          src.pdfjs = await pdfjsLib.getDocument({
            data: bytes.slice(),
            standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/',
            cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
            cMapPacked: true,
          }).promise;
        } catch {
          src.thumbs.fill('none'); // still mergeable, just no previews
        }
      } catch (e) {
        bad++;
        src.error = /encrypt/i.test(String(e && e.message))
          ? 'This PDF is password-protected. Remove the password and add it again.'
          : "This file couldn't be read. It may be damaged or not really a PDF.";
      }
      sources.push(src);
      renderSources();
      if (src.pdfjs) for (let i = 0; i < src.pageCount; i++) queueThumb(src, i);
    }

    const ok = pdfs.length - bad;
    const notes = [];
    if (ok) notes.push(`Added ${plural(ok, 'file')}.`);
    if (bad) notes.push(`${plural(bad, 'file')} couldn't be opened.`);
    if (skipped) notes.push(`Ignored ${plural(skipped, 'non-PDF file')}.`);
    setStatus(notes.join(' '), bad || skipped ? 'err' : '');
    renderOutput();
  }

  for (const p of [els.picker, els.picker2]) {
    p.addEventListener('change', () => {
      addFiles(p.files);
      p.value = '';
    });
  }

  // ---------- thumbnails (rendered one at a time in the background) ----------

  const thumbQueue = [];
  let thumbBusy = false;

  function queueThumb(src, i) {
    thumbQueue.push([src, i]);
    pumpThumbs();
  }

  async function pumpThumbs() {
    if (thumbBusy) return;
    thumbBusy = true;
    while (thumbQueue.length) {
      const [src, i] = thumbQueue.shift();
      if (!sources.includes(src)) continue;
      try {
        const page = await src.pdfjs.getPage(i + 1);
        const base = page.getViewport({ scale: 1 });
        const scale = 240 / Math.max(base.width, base.height);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise; // no animation-frame stalls
        page.cleanup();
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
        if (!sources.includes(src)) continue;
        src.thumbs[i] = URL.createObjectURL(blob);
      } catch {
        src.thumbs[i] = 'none';
      }
      paintThumb(src, i);
    }
    thumbBusy = false;
  }

  /** Fill in a page preview wherever that page is currently on screen. */
  function paintThumb(src, i) {
    document.querySelectorAll(`.paper[data-key="${src.id}-${i}"]`).forEach((paper) => {
      // Keep the rotation of pages in the new PDF when their preview arrives.
      const uid = paper.closest('.thumb[data-uid]')?.dataset.uid;
      const rot = uid ? output.find((o) => o.uid === Number(uid))?.rot || 0 : 0;
      fillPaper(paper, src, i, rot);
    });
    markUsedPages(); // filling a preview clears its "✓ #n" tag; put it back
  }

  function fillPaper(paper, src, i, rot = 0) {
    const url = src.thumbs[i];
    paper.classList.toggle('loading', url === null);
    paper.replaceChildren();
    if (url && url !== 'none') {
      paper.append(h('img', { src: url, alt: '', draggable: false, style: rot ? `transform: rotate(${rot}deg)` : '' }));
    } else if (url === 'none') {
      paper.append(h('span', { class: 'noprev' }, `Page ${i + 1}`));
    }
  }

  function paper(src, i, rot = 0) {
    const p = h('div', { class: 'paper', 'data-key': `${src.id}-${i}` });
    fillPaper(p, src, i, rot);
    return p;
  }

  // ---------- rendering: source files ----------

  function renderSources() {
    const has = sources.length > 0;
    els.drop.classList.toggle('compact', has);
    els.clearAll.hidden = !has;
    els.srcHint.hidden = !sources.some((s) => !s.error);
    els.sources.replaceChildren(...sources.map(sourceCard));
    els.addEverything.hidden = !sources.some((s) => !s.error);
    markUsedPages();
  }

  function sourceCard(src) {
    const card = h('article', {
      class: 'src' + (src.collapsed ? ' collapsed' : '') + (src.error ? ' error' : ''),
      style: `--c: ${src.color}`,
      'data-src': src.id,
    });

    const nSel = src.selected.size;
    const info = h('div', { class: 'src-info' },
      src.error ? 'Not usable' : `${plural(src.pageCount, 'page')} · ${formatSize(src.size)}`,
      h('span', { class: 'used-count' }),
      nSel ? h('span', { class: 'sel-badge' }, `${nSel} selected`) : null,
      !src.error && h('button', {
        type: 'button', class: 'link-btn',
        onclick: () => {
          if (nSel === src.pageCount) src.selected.clear();
          else for (let i = 0; i < src.pageCount; i++) src.selected.add(i);
          renderSources();
        },
      }, nSel === src.pageCount ? 'Clear selection' : 'Select all'),
    );

    const head = h('div', { class: 'src-head' },
      !src.error && h('button', {
        type: 'button', class: 'collapse', 'aria-label': src.collapsed ? 'Show pages' : 'Hide pages',
        'aria-expanded': String(!src.collapsed),
        onclick: () => { src.collapsed = !src.collapsed; renderSources(); },
      }, '▾'),
      h('div', { class: 'src-meta' },
        h('div', { class: 'src-name', title: src.name }, src.name),
        info),
      h('div', { class: 'src-actions' },
        !src.error && h('button', {
          type: 'button', class: 'btn navy small',
          title: nSel ? 'Add the selected pages to the end of your new PDF' : 'Add every page to the end of your new PDF',
          onclick: () => addToOutput(src, nSel ? [...src.selected].sort((a, b) => a - b) : null),
        }, nSel ? `Add ${nSel}` : 'Add all'),
        h('button', {
          type: 'button', class: 'icon-btn danger', title: `Remove ${src.name}`,
          'aria-label': `Remove ${src.name}`, onclick: () => removeSource(src),
        }, '✕'),
      ),
    );
    card.append(head);

    if (src.error) {
      card.append(h('p', { class: 'src-error' }, src.error));
      return card;
    }

    const grid = h('div', { class: 'grid' });
    for (let i = 0; i < src.pageCount; i++) {
      const sel = src.selected.has(i);
      grid.append(h('div', {
        class: 'thumb' + (sel ? ' selected' : ''),
        tabIndex: 0,
        role: 'checkbox',
        'aria-checked': String(sel),
        'aria-label': `${src.name}, page ${i + 1}`,
        'data-kind': 'src', 'data-src': src.id, 'data-page': i,
      },
        paper(src, i),
        h('span', { class: 'check', 'aria-hidden': 'true' }, '✓'),
        h('span', { class: 'pnum' }, `Page ${i + 1}`),
      ));
    }
    card.append(h('div', { class: 'src-body' }, grid));
    return card;
  }

  function removeSource(src) {
    const used = output.filter((o) => o.srcId === src.id).length;
    sources = sources.filter((s) => s !== src);
    output = output.filter((o) => o.srcId !== src.id);
    for (const u of [...outSel]) if (!output.some((o) => o.uid === u)) outSel.delete(u);
    src.thumbs.forEach((u) => u && u !== 'none' && URL.revokeObjectURL(u));
    src.pdfjs?.destroy();
    renderSources();
    renderOutput();
    setStatus(used
      ? `Removed ${src.name} and its ${plural(used, 'page')} from your new PDF.`
      : `Removed ${src.name}.`);
  }

  // ---------- rendering: the new document ----------

  function renderOutput() {
    const n = output.length;
    els.outEmpty.hidden = n > 0;
    els.outClear.hidden = n === 0;
    els.outHint.hidden = n === 0;
    els.outCount.textContent = n ? `· ${plural(n, 'page')}` : '';
    els.merge.disabled = n === 0;
    els.outGrid.replaceChildren(...output.map(outThumb));
    markUsedPages();
  }

  /**
   * On the left, show which pages are already in the new PDF and where:
   * a navy "✓ #3" tag on each page, and "2 of 3 added" on each file.
   */
  function markUsedPages() {
    const where = new Map(); // "srcId-page" -> [positions]
    output.forEach((o, idx) => {
      const key = `${o.srcId}-${o.page}`;
      if (!where.has(key)) where.set(key, []);
      where.get(key).push(idx + 1);
    });

    for (const card of els.sources.querySelectorAll('.src')) {
      const src = byId(Number(card.dataset.src));
      if (!src || src.error) continue;
      let used = 0;
      for (const t of card.querySelectorAll('.thumb')) {
        const pos = where.get(`${src.id}-${t.dataset.page}`);
        t.classList.toggle('used', !!pos);
        t.querySelector('.used-tag')?.remove();
        if (pos) {
          used++;
          const shown = pos.length > 3 ? `${pos.slice(0, 3).map((p) => '#' + p).join(' ')} …` : pos.map((p) => '#' + p).join(' ');
          t.querySelector('.paper').append(h('span', {
            class: 'used-tag',
            title: `In your new PDF at position ${pos.join(', ')}`,
          }, `✓ ${shown}`));
        }
      }
      const count = card.querySelector('.used-count');
      count.textContent = used ? `${used} of ${src.pageCount} added` : '';
      count.hidden = !used;
    }
  }

  function outThumb(o, idx) {
    const src = byId(o.srcId);
    const sel = outSel.has(o.uid);
    return h('div', {
      class: 'thumb' + (sel ? ' selected' : ''),
      style: `--c: ${src.color}`,
      tabIndex: 0,
      role: 'option',
      'aria-selected': String(sel),
      'aria-label': `Position ${idx + 1}: ${src.name}, page ${o.page + 1}`,
      'data-kind': 'out', 'data-uid': o.uid,
    },
      h('span', { class: 'pos' }, String(idx + 1)),
      h('div', { class: 'tools' },
        h('button', {
          type: 'button', class: 'icon-btn', title: 'Rotate', 'aria-label': 'Rotate page',
          onclick: () => { o.rot = (o.rot + 90) % 360; renderOutput(); },
        }, '↻'),
        h('button', {
          type: 'button', class: 'icon-btn danger', title: 'Remove', 'aria-label': 'Remove page',
          onclick: () => removeOut([o.uid]),
        }, '✕'),
      ),
      paper(src, o.page, o.rot),
      h('span', { class: 'label', title: `${src.name}, page ${o.page + 1}` },
        h('b', {}, shortName(src.name)), ` · p${o.page + 1}`),
    );
  }

  function addToOutput(src, pages, at = output.length) {
    const list = pages ?? Array.from({ length: src.pageCount }, (_, i) => i);
    const entries = list.map((page) => ({ uid: nextUid++, srcId: src.id, page, rot: 0 }));
    output.splice(at, 0, ...entries);
    src.selected.clear();
    src.anchor = null;
    renderSources();
    renderOutput();
    setStatus(`Added ${plural(entries.length, 'page')} from ${src.name}.`);
  }

  function removeOut(uids) {
    const set = new Set(uids);
    output = output.filter((o) => !set.has(o.uid));
    uids.forEach((u) => outSel.delete(u));
    renderOutput();
    setStatus(`Removed ${plural(uids.length, 'page')}.`);
  }

  els.outClear.addEventListener('click', () => {
    output = [];
    outSel.clear();
    renderOutput();
    setStatus('');
  });

  els.clearAll.addEventListener('click', () => {
    const msg = output.length
      ? `Remove all ${plural(sources.length, 'file')} and the ${plural(output.length, 'page')} in your new PDF?`
      : `Remove all ${plural(sources.length, 'file')}?`;
    if (!confirm(msg)) return;
    thumbQueue.length = 0;
    for (const s of sources) {
      s.thumbs.forEach((u) => u && u !== 'none' && URL.revokeObjectURL(u));
      s.pdfjs?.destroy();
    }
    sources = [];
    output = [];
    outSel.clear();
    colorIdx = 0;
    renderSources();
    renderOutput();
    setStatus('Cleared everything. Add new PDFs to start again.');
  });

  els.addEverything.addEventListener('click', () => {
    const usable = sources.filter((s) => !s.error);
    for (const s of usable) {
      for (let i = 0; i < s.pageCount; i++) output.push({ uid: nextUid++, srcId: s.id, page: i, rot: 0 });
      s.selected.clear();
    }
    renderSources();
    renderOutput();
    setStatus(`Added every page from ${plural(usable.length, 'file')}.`);
  });

  // ---------- clicking & keyboard selection ----------

  let suppressClick = false;

  // Thumbnails are redrawn on every click, so the browser's own dblclick event
  // can't be relied on; detect a quick second click on the same page instead.
  let lastClick = { key: null, time: 0 };

  document.addEventListener('click', (e) => {
    const t = e.target.closest('.thumb');
    if (!t || e.target.closest('button')) return;
    if (suppressClick) return;

    if (t.dataset.kind === 'src' && !e.shiftKey) {
      const key = `${t.dataset.src}-${t.dataset.page}`;
      const now = performance.now();
      if (lastClick.key === key && now - lastClick.time < 450) {
        lastClick = { key: null, time: 0 };
        const src = byId(Number(t.dataset.src));
        const page = Number(t.dataset.page);
        // Undo the first click's toggle, then add just this page.
        src.selected.has(page) ? src.selected.delete(page) : src.selected.add(page);
        const keep = new Set(src.selected);
        addToOutput(src, [page]);
        src.selected = keep;
        renderSources();
        return;
      }
      lastClick = { key, time: now };
    }
    toggleSelect(t, e.shiftKey);
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target.closest?.('.thumb');
    if (t && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      toggleSelect(t, e.shiftKey);
      return;
    }
    if (e.target.matches?.('input, textarea')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && outSel.size) {
      e.preventDefault();
      removeOut([...outSel]);
    } else if (e.key === 'Escape') {
      outSel.clear();
      sources.forEach((s) => s.selected.clear());
      renderSources();
      renderOutput();
    }
  });

  function toggleSelect(t, shift) {
    const focusKey = t.dataset.kind === 'src' ? `[data-src="${t.dataset.src}"][data-page="${t.dataset.page}"]` : `[data-uid="${t.dataset.uid}"]`;
    if (t.dataset.kind === 'src') {
      const src = byId(Number(t.dataset.src));
      const i = Number(t.dataset.page);
      if (shift && src.anchor !== null) {
        const [a, b] = [Math.min(src.anchor, i), Math.max(src.anchor, i)];
        for (let k = a; k <= b; k++) src.selected.add(k);
      } else {
        src.selected.has(i) ? src.selected.delete(i) : src.selected.add(i);
        src.anchor = i;
      }
      renderSources();
    } else {
      const uid = Number(t.dataset.uid);
      const idx = output.findIndex((o) => o.uid === uid);
      if (shift && outAnchor !== null) {
        const ai = output.findIndex((o) => o.uid === outAnchor);
        if (ai >= 0) for (let k = Math.min(ai, idx); k <= Math.max(ai, idx); k++) outSel.add(output[k].uid);
      } else {
        outSel.has(uid) ? outSel.delete(uid) : outSel.add(uid);
        outAnchor = uid;
      }
      renderOutput();
    }
    document.querySelector(`.thumb${focusKey}`)?.focus({ preventScroll: true });
  }

  // ---------- drag & drop of pages (pointer based, works with mouse and pen) ----------

  let drag = null;

  document.addEventListener('dragstart', (e) => {
    if (e.target.closest?.('.thumb')) e.preventDefault(); // no native image dragging
  });

  document.addEventListener('pointerdown', (e) => {
    const t = e.target.closest('.thumb');
    if (!t || e.button !== 0 || e.pointerType === 'touch' || e.target.closest('button')) return;
    if (drag?.active) endDragVisuals(); // a previous drag never got its pointerup
    drag = { t, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false, insertAt: null };
  });

  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
      startDrag();
    }
    e.preventDefault();
    updateDrag();
  });

  document.addEventListener('pointerup', () => {
    if (!drag) return;
    if (drag.active) {
      finishDrag();
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    }
    drag = null;
  });

  document.addEventListener('pointercancel', () => {
    if (drag?.active) endDragVisuals();
    drag = null;
  });

  function startDrag() {
    const t = drag.t;
    drag.active = true;
    let firstSrc, firstPage, count;

    if (t.dataset.kind === 'src') {
      const src = byId(Number(t.dataset.src));
      const i = Number(t.dataset.page);
      drag.kind = 'src';
      drag.src = src;
      drag.pages = src.selected.has(i) ? [...src.selected].sort((a, b) => a - b) : [i];
      drag.pages.forEach((p) => els.sources
        .querySelector(`.thumb[data-src="${src.id}"][data-page="${p}"]`)?.classList.add('drag-src'));
      [firstSrc, firstPage, count] = [src, i, drag.pages.length];
      els.outPanel.classList.add('drop-ready');
    } else {
      const uid = Number(t.dataset.uid);
      drag.kind = 'out';
      drag.uids = outSel.has(uid) ? output.filter((o) => outSel.has(o.uid)).map((o) => o.uid) : [uid];
      drag.uids.forEach((u) => els.outGrid.querySelector(`.thumb[data-uid="${u}"]`)?.classList.add('drag-src'));
      const o = output.find((x) => x.uid === uid);
      [firstSrc, firstPage, count] = [byId(o.srcId), o.page, drag.uids.length];
    }

    drag.ghost = h('div', { class: 'drag-ghost' },
      h('div', { class: 'paper' },
        count > 1 && h('div', { class: 'stack' }),
        h('div', { style: 'position:absolute;inset:0;border-radius:6px;background:var(--surface)' }),
      ),
      count > 1 && h('span', { class: 'n' }, String(count)),
    );
    const p = drag.ghost.querySelector('.paper');
    const inner = paper(firstSrc, firstPage);
    inner.style.cssText = 'position:absolute;inset:0;background:transparent';
    p.append(inner);
    document.body.append(drag.ghost);
    document.body.classList.add('is-dragging');
    autoScrollLoop();
  }

  function updateDrag() {
    drag.ghost.style.transform = `translate(${drag.x - 30}px, ${drag.y - 30}px)`;
    clearMarkers();

    const r = els.outPanel.getBoundingClientRect();
    const inside = drag.x >= r.left && drag.x <= r.right && drag.y >= r.top && drag.y <= r.bottom;
    els.outPanel.classList.toggle('drop-hover', inside);
    if (!inside) { drag.insertAt = null; return; }

    const thumbs = [...els.outGrid.children];
    let at = thumbs.length;
    for (let k = 0; k < thumbs.length; k++) {
      const b = thumbs[k].getBoundingClientRect();
      if (drag.y < b.top || (drag.y <= b.bottom && drag.x < b.left + b.width / 2)) { at = k; break; }
    }
    drag.insertAt = at;
    if (thumbs.length) {
      if (at < thumbs.length) thumbs[at].classList.add('ins-before');
      else thumbs[thumbs.length - 1].classList.add('ins-after');
    }
  }

  function clearMarkers() {
    els.outGrid.querySelectorAll('.ins-before, .ins-after')
      .forEach((n) => n.classList.remove('ins-before', 'ins-after'));
  }

  function endDragVisuals() {
    document.querySelectorAll('.drag-ghost').forEach((g) => g.remove());
    clearMarkers();
    document.body.classList.remove('is-dragging');
    els.outPanel.classList.remove('drop-ready', 'drop-hover');
    document.querySelectorAll('.drag-src').forEach((n) => n.classList.remove('drag-src'));
  }

  function finishDrag() {
    const at = drag.insertAt;
    endDragVisuals();
    if (at === null) return;

    if (drag.kind === 'src') {
      addToOutput(drag.src, drag.pages, at);
    } else {
      const moving = new Set(drag.uids);
      const before = output.slice(0, at).filter((o) => moving.has(o.uid)).length;
      const moved = output.filter((o) => moving.has(o.uid));
      const rest = output.filter((o) => !moving.has(o.uid));
      rest.splice(at - before, 0, ...moved);
      output = rest;
      renderOutput();
    }
  }

  // Scroll the page (or the output list) when dragging near an edge.
  function autoScrollLoop() {
    if (!drag?.active) return;
    const edge = 60, speed = 14;
    const r = els.outScroll.getBoundingClientRect();
    const overOut = drag.x >= r.left && drag.x <= r.right && drag.y >= r.top && drag.y <= r.bottom;
    let moved = false;
    if (overOut && els.outScroll.scrollHeight > els.outScroll.clientHeight) {
      if (drag.y < r.top + edge) { els.outScroll.scrollTop -= speed; moved = true; }
      else if (drag.y > r.bottom - edge) { els.outScroll.scrollTop += speed; moved = true; }
    }
    if (!moved) {
      if (drag.y < edge) { window.scrollBy(0, -speed); moved = true; }
      else if (drag.y > window.innerHeight - edge) { window.scrollBy(0, speed); moved = true; }
    }
    if (moved) updateDrag();
    requestAnimationFrame(autoScrollLoop);
  }

  // ---------- dropping files from the computer ----------

  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  let fileDepth = 0;

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (fileDepth++ === 0) document.body.classList.add('file-over');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--fileDepth <= 0) { fileDepth = 0; document.body.classList.remove('file-over'); }
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    fileDepth = 0;
    document.body.classList.remove('file-over');
    addFiles(e.dataTransfer.files);
  });

  // ---------- building the final PDF ----------

  function outputName() {
    let n = els.outname.value.trim().replace(/[\\/:*?"<>|]+/g, '-') || 'merged';
    if (!/\.pdf$/i.test(n)) n += '.pdf';
    return n;
  }

  els.merge.addEventListener('click', async () => {
    if (!output.length) return;
    els.merge.disabled = true;
    const label = els.merge.textContent;
    els.merge.textContent = 'Building…';
    setStatus('');

    try {
      const out = await PDFDocument.create();

      // Copy each file's pages in one go so shared fonts/images are copied once.
      // A page used more than once needs its own separate copy.
      const copies = new Map(); // uid -> PDFPage
      const bySource = new Map();
      for (const o of output) {
        if (!bySource.has(o.srcId)) bySource.set(o.srcId, []);
        bySource.get(o.srcId).push(o);
      }
      for (const [srcId, entries] of bySource) {
        const src = byId(srcId);
        const seen = new Set();
        const firstUse = [];
        const repeats = [];
        for (const o of entries) (seen.has(o.page) ? repeats : (seen.add(o.page), firstUse)).push(o);
        const pages = await out.copyPages(src.lib, firstUse.map((o) => o.page));
        firstUse.forEach((o, k) => copies.set(o.uid, pages[k]));
        for (const o of repeats) {
          const [p] = await out.copyPages(src.lib, [o.page]);
          copies.set(o.uid, p);
        }
      }

      for (const o of output) {
        const page = copies.get(o.uid);
        if (o.rot) page.setRotation(degrees((page.getRotation().angle + o.rot) % 360));
        out.addPage(page);
      }

      const bytes = await out.save();
      const name = outputName();
      download(new Blob([bytes], { type: 'application/pdf' }), name);
      setStatus(`Done! ${name} has ${plural(out.getPageCount(), 'page')} (${formatSize(bytes.length)}).`, 'ok');
    } catch (e) {
      console.error(e);
      setStatus(`Something went wrong while building the PDF: ${e.message || e}`, 'err');
    } finally {
      els.merge.textContent = label;
      els.merge.disabled = output.length === 0;
    }
  });

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  renderSources();
  renderOutput();
})();
