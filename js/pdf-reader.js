// PDF.js-based reader: continuous pages, lazy rendering of visible pages,
// background text extraction, search and text highlighting.
//
// Events (CustomEvent on the reader):
//   pagechange {page}    scalechange {scale}    textprogress {done,total}
//   textready {chars, pages, hasText}           pagerendered {page}

import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { foldChar, foldText } from './text-fold.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_TEXT_PAGES = 2000;         // text extraction cap for very large documents
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const KEEP_RENDERED = 10;                   // rendered pages kept in memory

export class PdfReaderError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const collapse = (s) => s.replace(/\s+/g, ' ');

/** Pure helper behind PdfReader#paragraphAround (exported for tests). */
export function paragraphAround(lines, selected) {
  const sel = collapse(String(selected ?? '')).trim();
  if (!lines?.length || sel.length < 3) return sel;
  const gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i].ny - lines[i - 1].ny);
  // Lower median: the normal line spacing, even when paragraphs are short.
  const median = [...gaps].sort((a, b) => a - b)[Math.floor((gaps.length - 1) / 2)] ?? 0;
  const paras = [[lines[0].text]];
  gaps.forEach((g, i) => {
    if (g > median * 1.35) paras.push([]);
    paras[paras.length - 1].push(lines[i + 1].text);
  });
  const texts = paras.map((p) => collapse(p.join(' ')).trim());
  const folded = texts.map(foldText);
  const head = foldText(sel.slice(0, 40)), tail = foldText(sel.slice(-40));
  const first = folded.findIndex((t) => t.includes(head));
  if (first === -1) return sel;
  let last = first;
  for (let i = first; i < folded.length; i++) if (folded[i].includes(tail)) { last = i; break; }
  return texts.slice(first, last + 1).join(' ').slice(0, 1500);
}

export class PdfReader extends EventTarget {
  constructor({ viewer, pagesEl }) {
    super();
    this.viewer = viewer;
    this.pagesEl = pagesEl;
    this.doc = null;
    this.scale = 1;
    this.pageEls = [];
    this.sizes = [];            // unscaled page sizes {w, h}
    this.rendered = new Map();  // page -> render entry
    this.texts = new Map();     // page -> extracted text
    this.lines = new Map();     // page -> [{ny, text}]
    this.highlight = null;      // { page, text, mode, active }
    this.currentPage = 1;
    this.loadToken = 0;
    this.textReady = Promise.resolve();
    this.observer = new IntersectionObserver((entries) => this._onIntersect(entries), { root: viewer, rootMargin: '600px 0px' });
    let raf = 0;
    viewer.addEventListener('scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; this._updateCurrent(); });
    }, { passive: true });
    // Re-fit to the new width on resize unless the user chose a zoom level.
    let resizeTimer = 0;
    new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (this.doc && !this.userZoomed) this.setScale(this._fitScale(this.sizes[0].w));
      }, 200);
    }).observe(viewer);
  }

  get numPages() { return this.doc?.numPages ?? 0; }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  /** Opens a PDF from bytes. Resolves with { docId, numPages, title }. */
  async open({ data, name }) {
    if (!data || data.byteLength === 0) throw new PdfReaderError('empty', 'The file is empty.');
    if (data.byteLength > MAX_FILE_BYTES) {
      throw new PdfReaderError('too_large', `The file is ${(data.byteLength / 1048576).toFixed(0)} MB; the limit is ${MAX_FILE_BYTES / 1048576} MB.`);
    }
    await this.close();
    const token = ++this.loadToken;
    this.loadingTask = pdfjsLib.getDocument({ data, isEvalSupported: false, enableXfa: false });
    let doc;
    try {
      doc = await this.loadingTask.promise;
    } catch (e) {
      if (e?.name === 'PasswordException') throw new PdfReaderError('password', 'This PDF is password-protected. PiCODE does not open protected PDFs.');
      if (e?.name === 'InvalidPDFException') throw new PdfReaderError('invalid', 'This file is not a valid PDF or is corrupted.');
      throw new PdfReaderError('load_failed', `The PDF could not be opened (${e?.message || 'unknown error'}).`);
    }
    if (token !== this.loadToken) { doc.destroy(); throw new PdfReaderError('superseded', 'Another document was opened.'); }
    if (doc.numPages < 1) throw new PdfReaderError('empty', 'This PDF has no pages.');
    this.doc = doc;

    const meta = await doc.getMetadata().catch(() => null);
    const title = (meta?.info?.Title || '').trim() || name.replace(/\.pdf$/i, '');
    const first = await doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    this.sizes = Array.from({ length: doc.numPages }, () => ({ w: vp.width, h: vp.height }));
    this.scale = this._fitScale(vp.width);
    this.userZoomed = false;
    this._buildPlaceholders();
    this.currentPage = 1;
    this._markCurrent();
    this.viewer.scrollTop = 0;
    this.textReady = this._extractAll(token);
    this._emit('scalechange', { scale: this.scale });
    return { docId: doc.fingerprints?.[0] || `${name}-${data.byteLength}`, numPages: doc.numPages, title };
  }

  async close() {
    this.loadToken++;
    for (const n of [...this.rendered.keys()]) this._unrender(n);
    this.observer.disconnect();
    this.pagesEl.replaceChildren();
    this.pageEls = [];
    this.texts.clear();
    this.lines.clear();
    this.highlight = null;
    const doc = this.doc;
    this.doc = null;
    if (this.loadingTask) { await this.loadingTask.destroy().catch(() => {}); this.loadingTask = null; }
    else if (doc) await doc.destroy().catch(() => {});
  }

  _fitScale(pageWidth) {
    const avail = Math.max(200, this.viewer.clientWidth - (this.viewer.clientWidth < 600 ? 20 : 48));
    return Math.min(1.5, Math.max(0.4, +(avail / pageWidth).toFixed(2)));
  }

  _buildPlaceholders() {
    const frag = document.createDocumentFragment();
    this.pageEls = this.sizes.map((_, i) => {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.page = String(i + 1);
      el.setAttribute('role', 'region');
      el.setAttribute('aria-label', `Page ${i + 1}`);
      el.innerHTML = `<div class="page-loading">Page ${i + 1}</div><span class="page-label" aria-hidden="true">${i + 1}</span>`;
      this._sizePage(el, i + 1);
      frag.append(el);
      return el;
    });
    this.pagesEl.append(frag);
    for (const el of this.pageEls) this.observer.observe(el);
  }

  _sizePage(el, n) {
    const { w, h } = this.sizes[n - 1];
    el.style.width = `${Math.floor(w * this.scale)}px`;
    el.style.height = `${Math.floor(h * this.scale)}px`;
    el.style.setProperty('--scale-factor', String(this.scale));
  }

  _onIntersect(entries) {
    for (const e of entries) if (e.isIntersecting) this._render(Number(e.target.dataset.page));
  }

  async _render(n) {
    if (!this.doc || this.rendered.has(n)) return;
    const token = this.loadToken;
    const el = this.pageEls[n - 1];
    const entry = { cancelled: false };
    this.rendered.set(n, entry);
    try {
      const page = await this.doc.getPage(n);
      if (entry.cancelled || token !== this.loadToken) return;
      const base = page.getViewport({ scale: 1 });
      if (base.width !== this.sizes[n - 1].w || base.height !== this.sizes[n - 1].h) {
        this.sizes[n - 1] = { w: base.width, h: base.height };
        this._sizePage(el, n);
      }
      const viewport = page.getViewport({ scale: this.scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.setAttribute('aria-hidden', 'true');
      entry.renderTask = page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      });
      await entry.renderTask.promise;
      if (entry.cancelled) return;
      el.querySelector('.page-loading')?.remove();
      el.prepend(canvas);
      entry.canvas = canvas;

      const textContent = await page.getTextContent();
      if (entry.cancelled) return;
      this._cacheText(n, textContent, base);
      const layer = document.createElement('div');
      layer.className = 'textLayer';
      el.append(layer);
      entry.layer = layer;
      entry.textLayer = new pdfjsLib.TextLayer({ textContentSource: textContent, container: layer, viewport });
      await entry.textLayer.render();
      if (entry.cancelled) return;
      if (this.highlight?.page === n) this._applyHighlight();
      this._evict();
      this._emit('pagerendered', { page: n });
    } catch (e) {
      if (e?.name === 'RenderingCancelledException' || entry.cancelled) return;
      this.rendered.delete(n);
      const msg = el.querySelector('.page-loading');
      if (msg) msg.textContent = `Page ${n} could not be rendered.`;
    }
  }

  _unrender(n) {
    const entry = this.rendered.get(n);
    if (!entry) return;
    entry.cancelled = true;
    entry.renderTask?.cancel();
    entry.textLayer?.cancel();
    entry.canvas?.remove();
    entry.layer?.remove();
    if (entry.canvas) { entry.canvas.width = 0; entry.canvas.height = 0; }
    this.rendered.delete(n);
    const el = this.pageEls[n - 1];
    if (el && !el.querySelector('.page-loading')) {
      const ph = document.createElement('div');
      ph.className = 'page-loading';
      ph.textContent = `Page ${n}`;
      el.prepend(ph);
    }
  }

  _evict() {
    if (this.rendered.size <= KEEP_RENDERED) return;
    const far = [...this.rendered.keys()]
      .sort((a, b) => Math.abs(b - this.currentPage) - Math.abs(a - this.currentPage))
      .slice(0, this.rendered.size - KEEP_RENDERED)
      .filter((n) => Math.abs(n - this.currentPage) > 3);
    for (const n of far) this._unrender(n);
  }

  _updateCurrent() {
    if (!this.pageEls.length) return;
    const line = this.viewer.scrollTop + this.viewer.clientHeight * 0.35;
    let lo = 0, hi = this.pageEls.length - 1;
    while (lo < hi) {               // last page whose top is above the reading line
      const mid = (lo + hi + 1) >> 1;
      if (this.pageEls[mid].offsetTop <= line) lo = mid; else hi = mid - 1;
    }
    const page = lo + 1;
    if (page !== this.currentPage) {
      this.currentPage = page;
      this._markCurrent();
      this._emit('pagechange', { page });
    }
  }

  _markCurrent() {
    this.pagesEl.querySelector('.page.current')?.classList.remove('current');
    this.pageEls[this.currentPage - 1]?.classList.add('current');
  }

  goToPage(n, { flash = false } = {}) {
    if (!this.doc) return;
    const page = Math.min(this.numPages, Math.max(1, Math.round(n)));
    const el = this.pageEls[page - 1];
    this.markProgrammaticScroll();
    this.viewer.scrollTop = el.offsetTop - 12;
    this._updateCurrent();
    if (this.currentPage !== page) {  // short last pages may not reach the reading line
      this.currentPage = page;
      this._markCurrent();
      this._emit('pagechange', { page });
    }
    if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }

  // ---------------------------------------------------------------- zoom
  setScale(scale) {
    if (!this.doc) return;
    const s = Math.min(3, Math.max(0.5, +scale.toFixed(2)));
    if (s === this.scale) return;
    const el = this.pageEls[this.currentPage - 1];
    const ratio = (this.viewer.scrollTop - el.offsetTop) / el.offsetHeight;
    for (const n of [...this.rendered.keys()]) this._unrender(n);
    this.scale = s;
    this.pageEls.forEach((p, i) => this._sizePage(p, i + 1));
    this.markProgrammaticScroll();
    this.viewer.scrollTop = el.offsetTop + ratio * el.offsetHeight;
    // Re-observe so currently visible pages report intersection again and re-render.
    this.observer.disconnect();
    for (const p of this.pageEls) this.observer.observe(p);
    this._emit('scalechange', { scale: s });
  }
  zoomIn() { this.userZoomed = true; this.setScale(ZOOM_STEPS.find((z) => z > this.scale + 0.01) ?? this.scale); }
  zoomOut() { this.userZoomed = true; this.setScale([...ZOOM_STEPS].reverse().find((z) => z < this.scale - 0.01) ?? this.scale); }

  // ---------------------------------------------------------------- text
  _cacheText(n, textContent, baseViewport) {
    if (this.texts.has(n)) return;
    let text = '';
    const rows = [];
    for (const item of textContent.items) {
      if (!('str' in item)) continue;
      text += item.str + (item.hasEOL ? '\n' : '');
      if (!item.str.trim()) continue;
      const [, y] = baseViewport.convertToViewportPoint(item.transform[4], item.transform[5]);
      const ny = y / baseViewport.height;
      const row = rows.find((r) => Math.abs(r.ny - ny) < 0.004);
      if (row) row.text += (row.text.endsWith(' ') ? '' : ' ') + item.str;
      else rows.push({ ny, text: item.str });
    }
    this.texts.set(n, text);
    this.lines.set(n, rows.sort((a, b) => a.ny - b.ny).map((r) => ({ ny: +r.ny.toFixed(4), text: collapse(r.text).trim() })));
  }

  /** Extracted text of a page (extracts on demand). */
  async getPageText(n) {
    if (this.texts.has(n)) return this.texts.get(n);
    if (!this.doc || n < 1 || n > this.numPages) return '';
    const page = await this.doc.getPage(n);
    const tc = await page.getTextContent();
    this._cacheText(n, tc, page.getViewport({ scale: 1 }));
    if (!this.rendered.has(n)) page.cleanup();
    return this.texts.get(n);
  }

  async _extractAll(token) {
    const total = Math.min(this.numPages, MAX_TEXT_PAGES);
    let chars = 0;
    for (let n = 1; n <= total; n++) {
      if (token !== this.loadToken) return;
      try { chars += collapse(await this.getPageText(n)).trim().length; } catch { /* skip unreadable page */ }
      if (n % 5 === 0) {
        this._emit('textprogress', { done: n, total });
        await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
      }
    }
    if (token !== this.loadToken) return;
    this._emit('textready', { chars, pages: total, hasText: chars >= Math.max(40, total * 15) });
  }

  /** Case-insensitive search across extracted text. */
  async search(query) {
    await this.textReady;
    const q = foldText(collapse(query).trim());
    if (q.length < 2) return [];
    const results = [];
    for (const [page, text] of [...this.texts.entries()].sort((a, b) => a[0] - b[0])) {
      const hay = foldText(collapse(text));
      let at = hay.indexOf(q), index = 0;
      while (at !== -1 && results.length < 500) {
        results.push({ page, index: index++ });
        at = hay.indexOf(q, at + q.length);
      }
    }
    return results;
  }

  // ---------------------------------------------------------------- highlight
  /**
   * Highlights `text` on `page`. mode "search": exact (case/space-insensitive);
   * mode "loose": punctuation-insensitive, falls back to the first words (for evidence).
   * `active` = which occurrence on the page to emphasize and scroll to.
   */
  setHighlight(page, text, { mode = 'search', active = 0 } = {}) {
    this.clearHighlight();
    this.highlight = { page, text, mode, active };
    if (this.rendered.get(page)?.layer) return this._applyHighlight();
    return false;
  }

  clearHighlight() {
    this.highlight = null;
    for (const s of this.pagesEl.querySelectorAll('.pc-hl')) s.classList.remove('pc-hl', 'pc-active');
  }

  _applyHighlight() {
    const h = this.highlight;
    const layer = this.rendered.get(h.page)?.layer;
    if (!layer) return false;
    const norm = h.mode === 'loose'
      ? (c) => (/[\p{L}\p{N}]/u.test(c) ? foldChar(c) : ' ')
      : (c) => (/\s/.test(c) ? ' ' : foldChar(c));
    // Build a normalized string of the text layer with a map back to span nodes.
    let str = '';
    const owner = [];
    const push = (ch, node) => {
      if (ch === ' ' && (str === '' || str.endsWith(' '))) return;
      str += ch;
      owner.push(node);
    };
    for (const node of layer.querySelectorAll('span:not(.markedContent), br')) {
      if (node.tagName === 'BR') { push(' ', null); continue; }
      for (const ch of node.textContent) push(norm(ch), node);
    }
    const prep = (t) => [...t].map(norm).join('').replace(/ +/g, ' ').trim();
    let needle = prep(h.text);
    let at = needle ? str.indexOf(needle) : -1;
    if (at === -1 && h.mode === 'loose') {
      needle = needle.split(' ').slice(0, 8).join(' ');
      at = needle.length >= 8 ? str.indexOf(needle) : -1;
    }
    if (at === -1) return false;
    let occurrence = 0, first = null;
    while (at !== -1) {
      const nodes = new Set(owner.slice(at, at + needle.length).filter(Boolean));
      for (const n of nodes) {
        n.classList.add('pc-hl');
        if (occurrence === h.active) { n.classList.add('pc-active'); first ??= n; }
      }
      occurrence++;
      at = str.indexOf(needle, at + needle.length);
    }
    if (first) {
      const top = first.getBoundingClientRect().top - this.viewer.getBoundingClientRect().top;
      if (top < 40 || top > this.viewer.clientHeight - 60) {
        this.markProgrammaticScroll();
        this.viewer.scrollTop += top - this.viewer.clientHeight * 0.3;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------- geometry helpers for the tracker
  /** Scrolls caused by the app (navigation, zoom, search) — not by the reader's own scrolling. */
  markProgrammaticScroll(ms = 500) { this.programmaticUntil = performance.now() + ms; }
  isProgrammaticScroll() { return performance.now() < (this.programmaticUntil ?? 0); }

  /** Height of the current page in pixels (for thresholds). */
  pageHeightPx() { return this.pageEls[this.currentPage - 1]?.offsetHeight ?? this.viewer.clientHeight; }

  /**
   * Splits a vertical range of the scrolled content (viewer coordinates, px) into
   * per-page ranges normalized to page height: [{page, yStart, yEnd}].
   */
  rangeToPages(top, bottom) {
    const out = [];
    for (const el of this.pageEls) {
      const a = Math.max(top, el.offsetTop), b = Math.min(bottom, el.offsetTop + el.offsetHeight);
      if (b <= a) continue;
      out.push({ page: Number(el.dataset.page), yStart: (a - el.offsetTop) / el.offsetHeight, yEnd: (b - el.offsetTop) / el.offsetHeight });
    }
    return out;
  }

  /**
   * The paragraph(s) of a page that contain `selected`, using the extracted text
   * lines: a vertical gap clearly larger than the usual line spacing starts a new
   * paragraph. Falls back to the selection itself.
   */
  paragraphAround(page, selected) {
    return paragraphAround(this.lines.get(page), selected);
  }

  /** Current text selection inside the PDF, or null. */
  selectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const el = node?.closest?.('.page');
    if (!el || !this.pagesEl.contains(el)) return null;
    const text = collapse(sel.toString()).trim();
    if (!text) return null;
    const rect = range.getBoundingClientRect();
    const pr = el.getBoundingClientRect();
    return { page: Number(el.dataset.page), text, ny: Math.min(1, Math.max(0, (rect.top - pr.top) / pr.height)), rect };
  }
}
