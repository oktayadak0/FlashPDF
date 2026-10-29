// PiCODE application shell: wires the reader, tracker, storage, model
// client and panels together. Feature logic lives in the imported modules.

import { PdfReader } from './pdf-reader.js';
import { ReadingTracker } from './reading-tracker.js';
import { ReadingAggregator, signalsByPage } from './event-aggregator.js';
import { buildContext, pagesForContext, attentionByPage, depthFor, excludedPages, importanceByPage } from './context-builder.js';
import { detectLanguage } from './text-fold.js';
import { studyNoteToMarkdown } from './note-format.js';
import { loadSchema, validateAndGround } from './schema-validator.js';
import { Store, createNote } from './local-storage.js';
import * as model from './model-client.js';
import { renderNotes, renderSaved } from './notes-panel.js';
import { renderSession } from './session-panel.js';
import { toMarkdown, toJSON, download, safeFilename } from './export.js';
import { SAMPLE, demoAggregate, DEMO_ANALYSIS } from './demo-data.js';
import { h } from './dom.js';

const $ = (id) => document.getElementById(id);
const ANALYSIS_TIMEOUT_MS = 10 * 60 * 1000;
const NEW_NOTE = '__new__';

const els = {
  viewer: $('viewer'), pages: $('pages'), banners: $('banners'), docTitle: $('doc-title'),
  pageInput: $('page-input'), pageCount: $('page-count'), prev: $('btn-prev'), next: $('btn-next'),
  zoomIn: $('btn-zoom-in'), zoomOut: $('btn-zoom-out'), zoomLabel: $('zoom-label'),
  searchForm: $('search-form'), searchInput: $('search-input'), searchCount: $('search-count'),
  searchPrev: $('btn-search-prev'), searchNext: $('btn-search-next'),
  trackingPill: $('tracking-pill'), modelDot: $('model-dot'), panel: $('panel'), scrim: $('scrim'),
  notesBody: $('notes-body'), savedBody: $('saved-body'), sessionBody: $('session-body'), savedCount: $('saved-count'),
  analyze: $('btn-analyze'), resumeTracking: $('btn-resume-tracking'), includeNotes: $('opt-include-notes'), progress: $('analysis-progress'),
  progressText: $('progress-text'), progressTime: $('progress-time'), cancel: $('btn-cancel'),
  preview: $('context-preview'), previewBody: $('context-preview-body'), fileInput: $('file-input'),
  selectionPop: $('selection-pop'), toasts: $('toasts'), drop: $('drop-overlay'), demoBtn: $('btn-demo'),
};

const reader = new PdfReader({ viewer: els.viewer, pagesEl: els.pages });
const tracker = new ReadingTracker({ reader, viewer: els.viewer });

const state = {
  store: null,
  doc: null,            // { docId, title, name, pageCount, isSample }
  session: null,        // { id, docId, startedAt }
  aggregator: null,     // the real session aggregator
  real: { analysis: null, notes: [] },
  demo: null,           // { aggregator, analysis, notes } while demo mode is on
  status: null,         // last /api/status response
  consent: null,        // 'granted' | 'declined' | null (not asked yet)
  busy: false,
  abort: null,
  editingId: null,
  previousSessions: null,
  hasText: true,
  search: { query: '', results: [], index: -1 },
  selection: null,
  tab: 'notes',
  lang: 'en',           // language of the open document; the study note follows it
};

const cur = () => state.demo ?? state.real;
const activeAggregator = () => state.demo?.aggregator ?? state.aggregator;

// ------------------------------------------------------------------ helpers

function toast(message, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, message);
  els.toasts.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3200);
}

const banners = new Map();
function setBanner(key, { kind = '', text, actions = [] }) {
  clearBanner(key);
  const el = h('div', { class: `banner ${kind}`, role: kind === 'error' ? 'alert' : null },
    h('span', { class: 'text' }, text),
    actions.map(([label, fn]) => h('button', { class: 'btn small', type: 'button', onclick: fn }, label)),
    h('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'Dismiss', onclick: () => clearBanner(key) }, '×'));
  banners.set(key, el);
  els.banners.append(el);
}
function clearBanner(key) { banners.get(key)?.remove(); banners.delete(key); }

function isLocalUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1'].includes(host) || host.endsWith('.localhost');
  } catch { return false; }
}

function openDialog(id) { const d = $(id); if (!d.open) d.showModal(); return d; }
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close('dismiss'); });
}

const isNarrow = () => window.matchMedia('(max-width: 920px)').matches;
function setPanelOpen(open) {
  els.panel.classList.toggle('open', open);
  els.scrim.hidden = !open;
  $('btn-panel').setAttribute('aria-expanded', String(open));
}

// ------------------------------------------------------------------ rendering

function renderToolbar() {
  const has = !!state.doc;
  els.docTitle.textContent = has ? state.doc.title : 'No document open';
  els.docTitle.title = has ? `${state.doc.title} (${state.doc.name})` : '';
  els.viewer.classList.toggle('has-doc', has);
  for (const b of [els.pageInput, els.zoomIn, els.zoomOut, els.searchInput]) b.disabled = !has;
  els.pageCount.textContent = has ? `/ ${state.doc.pageCount}` : '/ –';
  els.pageInput.max = has ? state.doc.pageCount : 1;
  updatePageControls();
  els.zoomLabel.textContent = `${Math.round(reader.scale * 100)}%`;
  els.analyze.disabled = !has || state.busy;
  els.analyze.querySelector('span').textContent = state.demo ? 'Create simulated study note (demo)' : 'Create study note';
  for (const id of ['btn-add-note', 'btn-copy-md', 'btn-export-md', 'btn-export-json']) $(id).disabled = !has;
  els.demoBtn.setAttribute('aria-pressed', String(!!state.demo));
  renderTrackingPill();
}

function updatePageControls() {
  const page = reader.currentPage, n = state.doc?.pageCount ?? 0;
  if (document.activeElement !== els.pageInput) els.pageInput.value = n ? page : 1;
  els.prev.disabled = !n || page <= 1;
  els.next.disabled = !n || page >= n;
}

function renderTrackingPill() {
  const st = state.demo ? 'demo' : tracker.state;
  const label = { on: 'Tracking on', paused: 'Tracking paused', off: 'Tracking off', demo: 'Demo events' }[st];
  els.trackingPill.dataset.state = st;
  els.trackingPill.querySelector('.label').textContent = label;
  els.trackingPill.title = {
    on: 'Reading signals are being recorded locally. Click to pause.',
    paused: 'Tracking is paused. Click to resume.',
    off: 'Reading signals are not recorded. Click to review and allow.',
    demo: 'Demo mode shows simulated example events; nothing is recorded.',
  }[st];
  els.trackingPill.setAttribute('aria-label', `${label}. ${els.trackingPill.title}`);
  if (els.resumeTracking) {
    els.resumeTracking.style.display = (st === 'paused' && state.doc) ? 'flex' : 'none';
  }
}

function renderModelPill() {
  const s = state.status;
  let st = 'checking', label = 'Checking model…';
  if (state.demo) { st = 'demo'; label = 'Demo mode (simulated)'; }
  else if (s && s.ok && s.isGemma4) { st = 'ready'; label = `Gemma 4 ready · ${s.model}`; }
  else if (s && s.ok && s.isGemma4 === false) { st = 'warn'; label = `Not Gemma 4 · ${s.model}`; }
  else if (s && s.ok) { st = 'warn'; label = `${s.model} (Gemma 4 unverified)`; }
  else if (s) { st = 'offline'; label = s.reachable ? 'Model not installed' : 'Model offline'; }
  // Shown as a small dot on the sidebar "Model" button (the header shows the PiCODE wordmark).
  els.modelDot.dataset.state = st;
  const btn = $('btn-settings');
  btn.title = `Model settings — ${label}`;
  btn.setAttribute('aria-label', `Model settings. Status: ${label}`);
}

/** Attention per page (seconds-equivalent) for the active session; drives note depth. */
const currentAttention = () => attentionByPage(activeAggregator()?.summary() ?? { pages: [], regions: [], selections: [] });

/** The current study note as one Markdown document. */
function studyNoteMarkdown() {
  const a = cur().analysis;
  if (!a?.data?.studyNote) return '';
  return studyNoteToMarkdown(a.data.studyNote, { lang: state.lang, meta: a.lastRun, attention: currentAttention() });
}

const noteHandlers = {
  goToPage: (p) => locate(p),
  locate: (page, text) => locate(page, text || null),
  saveNote: () => saveStudyNote(),
  copyNote: async () => {
    try { await navigator.clipboard.writeText(studyNoteMarkdown()); toast('Study note copied as Markdown.'); }
    catch { toast('Clipboard is not available; use the Markdown export instead.', 'error'); }
  },
  regenerate: () => runAnalysis(),
  openSettings: () => openSettings(),
  startDemo: () => startDemo(),
};

function renderNotesTab() {
  const a = cur().analysis;
  const summary = activeAggregator()?.summary();
  renderNotes(els.notesBody, {
    hasDoc: !!state.doc, note: a?.data?.studyNote ?? null, lastRun: a?.lastRun ?? null,
    dropped: a?.dropped ?? [], stats: a?.stats ?? null, busy: state.busy, modelOk: !!state.status?.ok,
    isSample: !!state.doc?.isSample, lang: state.lang, attention: currentAttention(),
    pageStats: new Map((summary?.pages ?? []).map((p) => [p.page, {
      ...p, selections: (summary?.selections ?? []).filter((x) => x.page === p.page).reduce((n, x) => n + x.count, 0),
    }])),
    excluded: a?.lastRun?.excludedPages ?? [], handlers: noteHandlers,
  });
}

const savedHandlers = {
  goToPage: (p) => locate(p),
  locateNote: (n) => locate(n.page, n.quote || n.text),
  edit: (n) => { state.editingId = n.id; renderSavedTab(); },
  cancelEdit: () => { state.editingId = null; renderSavedTab(); },
  commitEdit: async (n, text) => {
    const clean = text.trim();
    if (!clean) { toast('A note cannot be empty.', 'error'); return; }
    if (n === null) {
      await addNote(createNote({ docId: state.doc.docId, text: clean, page: reader.currentPage, source: state.demo ? 'demo' : 'manual' }));
    } else {
      await updateNote({ ...n, text: clean, edited: n.source === 'ai' ? true : n.edited });
    }
    state.editingId = null;
    renderSavedTab();
  },
  remove: async (n) => {
    if (!confirm('Delete this note?')) return;
    try {
      if (!state.demo) await state.store.deleteNote(n.id);
      cur().notes = cur().notes.filter((x) => x.id !== n.id);
      renderSavedTab();
      toast('Note deleted.');
    } catch (e) { toast(`Could not delete note: ${e.message}`, 'error'); }
  },
};

function renderSavedTab() {
  renderSaved(els.savedBody, {
    hasDoc: !!state.doc, notes: cur().notes, editingId: state.editingId, isDemo: !!state.demo,
    draftPage: reader.currentPage, handlers: savedHandlers,
  });
  els.savedCount.textContent = cur().notes.length ? String(cur().notes.length) : '';
}

let lastSessionSig = '';
function renderSessionTab(force = false) {
  const agg = activeAggregator();
  const summary = agg ? agg.summary() : null;
  const sig = summary ? `${summary.totalActiveSeconds}|${summary.skimmedSeconds}|${summary.idleIgnoredSeconds}|${summary.ignoredShortVisits}|${summary.rereads.length}|${summary.eventCount}|${summary.selections.length}|${tracker.state}|${!!state.demo}` : 'none';
  if (!force && (state.tab !== 'session' || sig === lastSessionSig)) return;
  lastSessionSig = sig;
  renderSession(els.sessionBody, {
    hasDoc: !!state.doc && !!summary, isDemo: !!state.demo, state: tracker.state, summary,
    pageCount: state.doc?.pageCount ?? 0, lines: reader.lines, previousSessions: state.previousSessions,
    persistent: state.store?.persistent ?? true,
    handlers: {
      pause: () => { tracker.pause(); toast('Tracking paused. Nothing new is recorded.'); },
      resume: () => { tracker.resume(); toast('Tracking resumed.'); },
      askConsent: () => openDialog('dlg-consent'),
      clearSession, openPrivacy, goToPage: (p) => locate(p),
      locateText: (p, text) => locate(p, text),
    },
  });
}

function renderAll() {
  renderToolbar();
  renderModelPill();
  renderNotesTab();
  renderSavedTab();
  renderSessionTab(true);
}

// ------------------------------------------------------------------ navigation

function locate(page, text = null) {
  if (!state.doc || !Number.isInteger(page)) return;
  reader.goToPage(page, { flash: true });
  if (text) reader.setHighlight(page, text, { mode: 'loose' });
  else reader.clearHighlight();
  if (isNarrow()) setPanelOpen(false);
}

reader.addEventListener('pagechange', () => { updatePageControls(); });
reader.addEventListener('scalechange', (e) => { els.zoomLabel.textContent = `${Math.round(e.detail.scale * 100)}%`; });
reader.addEventListener('textready', (e) => {
  state.hasText = e.detail.hasText;
  state.lang = detectLanguage([...reader.texts.values()].join(' '));
  if (state.tab === 'notes') renderNotesTab();
  if (!e.detail.hasText) {
    setBanner('notext', { kind: 'warn', text: 'This PDF has little or no extractable text (it may be a scanned image). Reading works, but search and AI analysis need a text layer; OCR is not included.' });
  }
});

els.prev.addEventListener('click', () => reader.goToPage(reader.currentPage - 1));
els.next.addEventListener('click', () => reader.goToPage(reader.currentPage + 1));
els.pageInput.addEventListener('change', () => {
  const n = parseInt(els.pageInput.value, 10);
  if (Number.isInteger(n)) reader.goToPage(n);
  updatePageControls();
});
els.zoomIn.addEventListener('click', () => reader.zoomIn());
els.zoomOut.addEventListener('click', () => reader.zoomOut());

els.viewer.addEventListener('keydown', (e) => {
  if (!state.doc || e.target !== els.viewer) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); reader.goToPage(reader.currentPage + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); reader.goToPage(reader.currentPage - 1); }
  else if (e.key === '+' || e.key === '=') { e.preventDefault(); reader.zoomIn(); }
  else if (e.key === '-') { e.preventDefault(); reader.zoomOut(); }
});
document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (e.key === '/' && !typing && state.doc) { e.preventDefault(); els.searchInput.focus(); }
  if (e.key === 'Escape' && els.panel.classList.contains('open')) setPanelOpen(false);
});

// ------------------------------------------------------------------ search

async function runSearch(direction = 1) {
  const q = els.searchInput.value.trim();
  if (!q) { clearSearch(); return; }
  const s = state.search;
  if (q !== s.query) {
    els.searchCount.textContent = '…';
    s.query = q;
    s.results = await reader.search(q);
    s.index = direction > 0 ? 0 : s.results.length - 1;
  } else if (s.results.length) {
    s.index = (s.index + direction + s.results.length) % s.results.length;
  }
  const has = s.results.length > 0;
  els.searchPrev.disabled = els.searchNext.disabled = !has;
  els.searchCount.textContent = has ? `${s.index + 1}/${s.results.length}` : q.length < 2 ? '' : '0';
  if (!has) { reader.clearHighlight(); return; }
  const r = s.results[s.index];
  if (r.page !== reader.currentPage) reader.goToPage(r.page);
  reader.setHighlight(r.page, q, { mode: 'search', active: r.index });
}
function clearSearch() {
  state.search = { query: '', results: [], index: -1 };
  els.searchCount.textContent = '';
  els.searchPrev.disabled = els.searchNext.disabled = true;
  reader.clearHighlight();
}
els.searchForm.addEventListener('submit', (e) => { e.preventDefault(); runSearch(1); });
els.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); runSearch(-1); }
  if (e.key === 'Escape') { els.searchInput.value = ''; clearSearch(); els.viewer.focus(); }
});
els.searchInput.addEventListener('input', () => { if (!els.searchInput.value) clearSearch(); });
els.searchNext.addEventListener('click', () => runSearch(1));
els.searchPrev.addEventListener('click', () => runSearch(-1));

// ------------------------------------------------------------------ documents & sessions

function showViewerMessage(title, text, kind = '') {
  els.pages.replaceChildren(h('div', { class: `viewer-message ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('h2', {}, title), h('p', {}, text),
    h('div', { class: 'empty-actions', style: 'justify-content:center' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => els.fileInput.click() }, 'Open another PDF'),
      h('button', { class: 'btn', type: 'button', onclick: openSample }, 'Open the sample'))));
  els.viewer.classList.add('has-doc');
}

async function openDocument({ data, name, isSample = false }) {
  try {
    await Promise.race([
      state.ready,
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]);
  } catch (e) {
    console.warn('Storage ready timed out or failed, proceeding', e);
  }
  if (state.demo && !isSample) exitDemo({ silent: true });
  await endSession();
  clearBanner('notext');
  clearSearch();
  els.searchInput.value = '';
  state.doc = null;
  state.real = { analysis: null, notes: [] };
  state.aggregator = null;
  tracker.setAggregator(null);
  showViewerMessage('Opening…', name);
  let info;
  try {
    info = await reader.open({ data, name });
  } catch (e) {
    if (e.code === 'superseded') return;
    renderAll();
    showViewerMessage('This PDF could not be opened', e.message || String(e), 'error');
    toast(e.message || 'Could not open the PDF.', 'error');
    return;
  }
  els.pages.querySelector('.viewer-message')?.remove();
  state.doc = { docId: info.docId, title: info.title, name, pageCount: info.numPages, isSample };
  state.hasText = true;
  els.viewer.focus({ preventScroll: true });

  // Start a new reading session for this document.
  state.aggregator = new ReadingAggregator({ startedAt: Date.now() });
  state.session = { id: crypto.randomUUID(), docId: info.docId, startedAt: new Date().toISOString() };
  tracker.setAggregator(state.demo ? null : state.aggregator);

  try {
    await state.store.saveDocument({ docId: info.docId, title: info.title, name, pageCount: info.numPages });
    state.real.notes = await state.store.listNotes(info.docId);
    const saved = await state.store.getAnalysis(info.docId);
    // Analyses stored by older versions (separate cards) are ignored rather than migrated.
    if (saved?.data?.studyNote) state.real.analysis = { data: saved.data, lastRun: saved.meta?.lastRun ?? null, stats: saved.meta?.stats ?? null, dropped: [] };
    const sessions = await state.store.listSessions(info.docId);
    state.previousSessions = { count: sessions.length, seconds: sessions.reduce((n, s) => n + (s.aggregate?.totalActiveSeconds ?? 0), 0) };
  } catch (e) {
    toast(`Local storage error: ${e.message}`, 'error');
  }
  renderAll();
  if (state.consent === null && !state.demo) openDialog('dlg-consent');
}

async function openFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('Please choose a PDF file.', 'error'); return; }
  try {
    await openDocument({ data: new Uint8Array(await file.arrayBuffer()), name: file.name });
  } catch (e) { toast(`Could not read the file: ${e.message}`, 'error'); }
}

async function openSample() {
  const consentDlg = $('dlg-consent');
  if (consentDlg && consentDlg.open) {
    consentDlg.close('accept');
    state.consent = 'granted';
    tracker.setConsent(true);
  }
  toast('Opening sample PDF…', 'info');
  try {
    const res = await fetch(SAMPLE.url + '?t=' + Date.now());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await openDocument({ data: new Uint8Array(await res.arrayBuffer()), name: SAMPLE.name, isSample: true });
  } catch (e) {
    console.error('Failed to open sample:', e);
    toast(`The sample PDF is missing (${e.message}). Run: py samples/make_sample_pdf.py`, 'error');
  }
}

async function persistSession() {
  const agg = state.aggregator;
  if (!state.doc || !agg || !state.session || state.store == null) return;
  if (agg.isEmpty()) return;  // don't store empty sessions
  try {
    await state.store.saveSession({ ...state.session, endedAt: new Date().toISOString(), aggregate: agg.toJSON() });
  } catch (e) {
    console.warn('Session not saved', e);
  }
}

async function endSession() {
  state.aggregator?.suspend(Date.now());
  await persistSession();
  state.session = null;
}

async function clearSession() {
  if (!state.doc || state.demo) return;
  if (!confirm('Clear everything recorded in the current reading session?')) return;
  try { if (state.session) await state.store.deleteSession(state.session.id); } catch { /* nothing stored yet */ }
  state.aggregator = new ReadingAggregator({ startedAt: Date.now() });
  state.session = { id: crypto.randomUUID(), docId: state.doc.docId, startedAt: new Date().toISOString() };
  tracker.setAggregator(state.aggregator);
  renderSessionTab(true);
  toast('Current session cleared.');
}

setInterval(persistSession, 15000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistSession(); });
window.addEventListener('pagehide', () => { persistSession(); });

// ------------------------------------------------------------------ notes

async function addNote(note) {
  try {
    const saved = state.demo ? note : await state.store.saveNote(note);
    cur().notes.push(saved);
    renderSavedTab();
    return saved;
  } catch (e) {
    toast(`Could not save note: ${e.message}`, 'error');
    return null;
  }
}

async function updateNote(note) {
  try {
    const saved = state.demo ? { ...note, updatedAt: new Date().toISOString() } : await state.store.saveNote(note);
    cur().notes = cur().notes.map((n) => (n.id === saved.id ? saved : n));
  } catch (e) { toast(`Could not save note: ${e.message}`, 'error'); }
}

/** Saves the whole study note as ONE saved note (Markdown), so it can be edited and exported as a unit. */
async function saveStudyNote() {
  const a = cur().analysis;
  if (!a?.data?.studyNote) return;
  const meta = a.lastRun ?? {};
  const same = cur().notes.find((n) => n.origin?.section === 'studyNote' && n.origin.generatedAt === meta.generatedAt);
  if (same) { toast(state.lang === 'tr' ? 'Bu not zaten kaydedildi.' : 'This note is already saved.'); selectTab('saved'); return; }
  const saved = await addNote(createNote({
    docId: state.doc.docId, page: null, text: studyNoteMarkdown(),
    source: meta.simulated ? 'demo' : 'ai',
    origin: { section: 'studyNote', model: meta.simulated ? 'simulated demo' : meta.model, generatedAt: meta.generatedAt ?? null, simulated: !!meta.simulated },
  }));
  if (saved) { toast(state.lang === 'tr' ? 'Çalışma notu kaydedildi.' : 'Study note saved.'); selectTab('saved'); }
}

$('btn-add-note').addEventListener('click', () => { state.editingId = NEW_NOTE; selectTab('saved'); renderSavedTab(); });

// Floating "Save as note" for text selected in the PDF (independent of tracking consent).
let selTimer = 0;
document.addEventListener('selectionchange', () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    const info = state.doc ? reader.selectionInfo() : null;
    state.selection = info;
    if (!info) { els.selectionPop.hidden = true; return; }
    els.selectionPop.hidden = false;
    const w = els.selectionPop.offsetWidth || 110;
    const left = Math.min(window.innerWidth - w - 8, Math.max(8, info.rect.right - w));
    const top = info.rect.top > 60 ? info.rect.top - 42 : info.rect.bottom + 8;
    els.selectionPop.style.left = `${left}px`;
    els.selectionPop.style.top = `${top}px`;
  }, 250);
});
// UI only (not tracking): keeps the text selection alive when the "Save as note" button is pressed.
els.selectionPop.addEventListener('pointerdown', (e) => e.preventDefault());
$('btn-save-selection').addEventListener('click', async () => {
  const info = state.selection;
  if (!info || !state.doc) return;
  const saved = await addNote(createNote({ docId: state.doc.docId, page: info.page, text: info.text.slice(0, 4000), source: state.demo ? 'demo' : 'manual' }));
  els.selectionPop.hidden = true;
  window.getSelection()?.removeAllRanges();
  if (saved) {
    state.editingId = saved.id;
    selectTab('saved');
    renderSavedTab();
    if (isNarrow()) setPanelOpen(true);
    toast('Passage saved — add your own words if you like.');
  }
});

// ------------------------------------------------------------------ export

function exportPayload() {
  const a = cur().analysis;
  return {
    title: state.doc.title, docId: state.doc.docId, notes: cur().notes,
    analysis: a?.data ?? null, analysisMeta: a?.lastRun ?? null, lang: state.lang, attention: currentAttention(),
  };
}
$('btn-export-md').addEventListener('click', () => {
  if (!state.doc) return;
  download(`${safeFilename(state.doc.title)}-notes.md`, toMarkdown(exportPayload()), 'text/markdown;charset=utf-8');
});
$('btn-export-json').addEventListener('click', () => {
  if (!state.doc) return;
  download(`${safeFilename(state.doc.title)}-notes.json`, toJSON(exportPayload()), 'application/json');
});
$('btn-copy-md').addEventListener('click', async () => {
  if (!state.doc) return;
  try {
    await navigator.clipboard.writeText(toMarkdown(exportPayload()));
    toast('Notes copied as Markdown.');
  } catch { toast('Clipboard is not available; use the Markdown export instead.', 'error'); }
});

// ------------------------------------------------------------------ model status & settings

async function checkModel() {
  try {
    state.status = await model.getStatus();
  } catch (e) {
    state.status = { ok: false, reachable: false, error: { code: e.code, message: e.message }, baseUrl: '?', model: '?' };
  }
  renderModelPill();
  if (!state.status.ok && !state.demo) {
    setBanner('model', {
      kind: 'warn',
      text: `Gemma 4 is not available (${state.status.error?.message ?? 'unknown error'}). You can still read and take notes; AI analysis needs the model.`,
      actions: [['Model setup', () => openSettings()], ['Try demo mode', () => startDemo()]],
    });
  } else {
    clearBanner('model');
  }
  if (state.tab === 'notes') renderNotesTab();
  return state.status;
}

function describeStatus(s) {
  const box = $('cfg-status');
  box.className = 'status-box';
  box.replaceChildren();
  if (!s) return;
  const row = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
  if (!s.reachable) {
    box.classList.add('bad');
    box.append(h('strong', {}, 'Not connected. '), s.error?.message ?? '',
      h('p', { class: 'small' }, s.runtime === 'ollama' ? 'Is Ollama running? Start it with “ollama serve”, then test again.' : 'Is the server running and the URL correct?'));
    return;
  }
  if (!s.modelInstalled) {
    box.classList.add('warn');
    box.append(h('strong', {}, `Connected, but “${s.model}” is not available. `),
      s.availableModels?.length ? h('p', { class: 'small' }, 'Available: ',
        s.availableModels.map((m, i) => [i ? ', ' : '', h('button', { class: 'link-btn', type: 'button', onclick: () => { $('cfg-model').value = m; } }, m)])) : 'No models found on this runtime.');
    return;
  }
  box.classList.add(s.isGemma4 ? 'ok' : 'warn');
  const verdict = s.isGemma4 === true
    ? (s.verification === 'runtime-metadata' ? 'Gemma 4 — verified from runtime metadata' : 'Gemma 4 — inferred from the model name only')
    : s.isGemma4 === false ? `Not Gemma 4 (family: ${s.family ?? 'unknown'}). Results will be labeled with the real model name.`
      : 'Model family could not be determined.';
  box.append(h('strong', {}, 'Connected. '), verdict,
    h('dl', {}, row('Model', s.model), s.family ? row('Family', s.family) : null,
      s.parameterSize ? row('Size', `${s.parameterSize}${s.quantization ? ` · ${s.quantization}` : ''}`) : null,
      row('Endpoint', `${s.baseUrl} (${s.isLocal ? 'this computer' : 'REMOTE'})`)));
}

async function openSettings() {
  const d = openDialog('dlg-settings');
  try {
    const cfg = await model.getConfig();
    $('cfg-runtime').value = cfg.runtime;
    $('cfg-base').value = cfg.baseUrl;
    $('cfg-model').value = cfg.model;
  } catch (e) {
    $('cfg-status').className = 'status-box bad';
    $('cfg-status').textContent = e.message;
    return d;
  }
  $('cfg-remote-warning').hidden = isLocalUrl($('cfg-base').value);
  $('cfg-status').className = 'status-box';
  $('cfg-status').textContent = 'Checking connection…';
  describeStatus(await checkModel());
  $('cfg-models').replaceChildren(...(state.status?.availableModels ?? []).map((m) => h('option', { value: m })));
  return d;
}

async function applySettings() {
  const cfg = { runtime: $('cfg-runtime').value, baseUrl: $('cfg-base').value.trim(), model: $('cfg-model').value.trim() };
  if (!/^https?:\/\//.test(cfg.baseUrl) || !cfg.model) { toast('Enter a valid http(s) URL and a model identifier.', 'error'); return false; }
  if (!isLocalUrl(cfg.baseUrl) && !confirm(`${cfg.baseUrl} is not on this computer. If you use it, PDF excerpts and reading signals will be sent there when you analyze (you will be asked each time). Continue?`)) return false;
  $('cfg-status').className = 'status-box';
  $('cfg-status').textContent = 'Testing connection…';
  try { await model.saveConfig(cfg); } catch (e) { toast(e.message, 'error'); return false; }
  describeStatus(await checkModel());
  $('cfg-models').replaceChildren(...(state.status?.availableModels ?? []).map((m) => h('option', { value: m })));
  return true;
}

$('cfg-base').addEventListener('input', () => { $('cfg-remote-warning').hidden = isLocalUrl($('cfg-base').value); });
$('btn-test').addEventListener('click', () => applySettings());
$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await applySettings()) { $('dlg-settings').close(); toast(state.status?.ok ? 'Model settings saved.' : 'Settings saved, but the model is not reachable.'); }
});

// ------------------------------------------------------------------ analysis

function setProgress(text) { els.progressText.textContent = text; }

async function gatherTexts(task, summary) {
  const pages = pagesForContext(task, summary, state.doc.pageCount).map((p) => p.page);
  const texts = new Map();
  for (const p of pages) texts.set(p, await reader.getPageText(p));
  return texts;
}

async function buildCurrentContext(task) {
  const summary = state.aggregator.summary();
  const pageTexts = await gatherTexts(task, summary);
  await reader.textReady;
  return buildContext({
    task, title: state.doc.title, language: state.lang, pageCount: state.doc.pageCount, currentPage: reader.currentPage,
    summary, pageTexts, pageLines: reader.lines, notes: state.real.notes, includeNotes: els.includeNotes.checked,
  });
}

/** Measured depth per page (same rule the context builder used), so the note can't over- or under-state it. */
function measuredDepths(summary) {
  const attention = attentionByPage(summary);
  const max = Math.max(0, ...attention.values());
  const imp = importanceByPage(summary);
  const out = new Map();
  for (let p = 1; p <= state.doc.pageCount; p++) out.set(p, depthFor(attention.get(p) ?? 0, max, imp(p)));
  return out;
}

els.preview.addEventListener('toggle', async () => {
  if (!els.preview.open) return;
  if (!state.doc) { els.previewBody.textContent = 'Open a document first.'; return; }
  if (state.demo) { els.previewBody.textContent = 'Demo mode: nothing is sent to a model. The simulated study note is pre-written.'; return; }
  const ctx = await buildCurrentContext('note');
  const where = state.status ? `${state.status.model} at ${state.status.baseUrl}` : 'the configured model';
  els.previewBody.textContent = `// Sent to the PiCODE backend, which forwards it to ${where}.\n${JSON.stringify(ctx, null, 2)}`;
});

function setAnalysis(target, checked, meta) {
  target.analysis = { data: checked.analysis, lastRun: meta, dropped: checked.dropped, stats: checked.stats };
}

async function persistAnalysis() {
  if (state.demo || !state.doc || !state.real.analysis) return;
  const a = state.real.analysis;
  try { await state.store.saveAnalysis(state.doc.docId, a.data, { lastRun: a.lastRun, stats: a.stats }); }
  catch (e) { toast(`Could not store analysis: ${e.message}`, 'error'); }
}

async function runSimulated() {
  setBusy(true);
  setProgress('Creating the simulated study note (demo — no model involved)…');
  await new Promise((r) => setTimeout(r, 900));
  const schema = await loadSchema();
  await reader.textReady;
  const summary = state.demo.aggregator.summary();
  const checked = validateAndGround(DEMO_ANALYSIS, 'note', {
    schema, pageCount: state.doc.pageCount, pageTexts: reader.texts, signals: signalsByPage(summary), depthByPage: measuredDepths(summary),
    selections: summary.selections,
  });
  setAnalysis(state.demo, checked, { simulated: true, model: 'simulated demo', generatedAt: new Date().toISOString(), durationSeconds: 0,
    excludedPages: excludedPages(summary, state.doc.pageCount) });
  setBusy(false);
  renderNotesTab();
}

function setBusy(busy) {
  state.busy = busy;
  els.progress.hidden = !busy;
  els.analyze.disabled = busy || !state.doc;
  clearInterval(setBusy.timer);
  if (busy) {
    const started = Date.now();
    els.progressTime.textContent = '0s';
    setBusy.timer = setInterval(() => { els.progressTime.textContent = `${Math.round((Date.now() - started) / 1000)}s elapsed`; }, 1000);
  }
}

async function runAnalysis() {
  const task = 'note';
  if (!state.doc || state.busy) return;
  selectTab('notes');
  if (isNarrow()) setPanelOpen(true);
  if (state.demo) { await runSimulated(); return; }

  // Automatically pause tracking while generating and viewing the study note,
  // so time spent reading the summary doesn't pollute the reader's document dwell signals!
  if (tracker.state === 'on') {
    tracker.pause();
    renderTrackingPill();
    toast('Tracking paused while you view your study note.', 'info');
  }

  clearBanner('analysis');
  const status = await checkModel();
  if (!status.ok) {
    setBanner('analysis', { kind: 'error', text: `Cannot analyze: ${status.error?.message ?? 'model unavailable'}.`,
      actions: [['Model setup', openSettings], ...(state.doc.isSample ? [['Try demo mode', startDemo]] : [])] });
    return;
  }
  if (!state.hasText) { toast('This PDF has no extractable text to analyze.', 'error'); return; }
  let allowRemote = false;
  if (!status.isLocal) {
    allowRemote = confirm(`The model endpoint ${status.baseUrl} is NOT on this computer.\n\nPDF excerpts, selected passages and reading statistics will be sent there. Continue?`);
    if (!allowRemote) return;
  }

  setBusy(true);
  setProgress('Preparing context…');
  const abort = new AbortController();
  state.abort = abort;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, ANALYSIS_TIMEOUT_MS);
  try {
    const ctx = await buildCurrentContext(task);
    if (!ctx.excerpts.length) throw new model.ModelClientError('no_text', 'No text could be extracted from the pages needed for this analysis.');
    const result = await model.runTask(task, ctx, {
      signal: abort.signal, allowRemote,
      onEvent: (evt) => {
        if (evt.type === 'status' && evt.phase === 'sent') {
          const deep = ctx.excerpts.filter((x) => x.depth === 'deep').map((x) => x.page);
          setProgress(`Sent ${ctx.excerpts.length} excerpts to ${evt.model}${deep.length ? ` (detailed notes for p. ${deep.join(', ')})` : ''}. Waiting for output — the first run loads the model and can take a minute or two…`);
        }
        else if (evt.type === 'progress') setProgress(`Writing the study note… ${evt.chunks} tokens received`);
        else if (evt.type === 'status' && evt.phase === 'repairing') setProgress('The output was not valid JSON — asking the model to repair it (one retry)…');
        else if (evt.type === 'status' && evt.phase === 'expanding') setProgress(`Expanding the sections you focused on (p. ${evt.pages.join(', ')}) — they came back too short…`);
      },
    });
    setProgress('Validating against the schema and the PDF text…');
    const schema = await loadSchema();
    const summary = state.aggregator.summary();
    const checked = validateAndGround(result.analysis, task, {
      schema, pageCount: state.doc.pageCount, pageTexts: reader.texts, signals: signalsByPage(summary),
      depthByPage: new Map(ctx.excerpts.map((x) => [x.page, x.depth])),
      selections: summary.selections.filter((s) => ctx.excerpts.some((x) => x.page === s.page)),
    });
    if (!checked.ok) throw new model.ModelClientError('invalid_response', `The model response failed validation: ${checked.errors.slice(0, 3).join('; ')}`);
    setAnalysis(state.real, checked, { ...result.meta, simulated: false, isGemma4: status.isGemma4 === true,
      excludedPages: excludedPages(summary, state.doc.pageCount) });
    await persistAnalysis();
    toast(checked.dropped.length ? `Study note ready (${checked.dropped.length} unsupported item(s) removed).` : 'Study note ready.');
  } catch (e) {
    const cancelled = e.code === 'cancelled' && !timedOut;
    const msg = timedOut ? `The analysis took longer than ${ANALYSIS_TIMEOUT_MS / 60000} minutes and was stopped.` : e.message;
    setBanner('analysis', { kind: cancelled ? '' : 'error', text: msg,
      actions: cancelled ? [] : [['Retry', () => runAnalysis()], ['Model setup', openSettings]] });
    if (['unreachable', 'model_not_found', 'backend_unreachable'].includes(e.code)) checkModel();
  } finally {
    clearTimeout(timeout);
    state.abort = null;
    setBusy(false);
    renderNotesTab();
  }
}

els.analyze.addEventListener('click', () => runAnalysis());
els.cancel.addEventListener('click', () => state.abort?.abort());
els.resumeTracking?.addEventListener('click', () => {
  tracker.resume();
  renderTrackingPill();
  toast('Tracking resumed. FlashPDF is observing your reading.');
  els.viewer.focus();
});

// ------------------------------------------------------------------ demo mode

async function startDemo() {
  if (state.demo) return;
  if (!state.doc?.isSample) await openSample();
  if (!state.doc?.isSample) return;
  state.demo = { aggregator: ReadingAggregator.fromJSON(demoAggregate()), analysis: null, notes: [] };
  tracker.setAggregator(null);   // real tracking stops; demo data stays separate
  clearBanner('model');
  setBanner('demo', {
    kind: 'demo',
    text: 'Demo mode — simulated example reading events and a pre-written analysis of the sample PDF. Nothing here comes from Gemma 4 and nothing is saved.',
    actions: [['Exit demo', () => exitDemo()]],
  });
  renderAll();
  await runSimulated();
  renderAll();
}

function exitDemo({ silent = false } = {}) {
  if (!state.demo) return;
  state.demo = null;
  clearBanner('demo');
  tracker.setAggregator(state.aggregator);
  if (!silent) { renderAll(); checkModel(); toast('Demo mode ended. Demo notes were discarded.'); }
}

els.demoBtn.addEventListener('click', () => (state.demo ? exitDemo() : startDemo()));

// ------------------------------------------------------------------ privacy & consent

async function setConsent(value) {
  state.consent = value;
  try { await state.store.setSetting('consent', value); } catch { /* memory only */ }
  tracker.setConsent(value === 'granted');
  renderTrackingPill();
  renderSessionTab(true);
}

$('dlg-consent').addEventListener('close', () => {
  const v = $('dlg-consent').returnValue;
  if (v === 'accept') {
    setConsent('granted');
    toast('Reading signals ON. FlashPDF is now observing reading signals.');
  } else if (v === 'decline') {
    setConsent('declined');
    toast('Reading without tracking.');
  }
});

const consentAcceptBtn = $('dlg-consent').querySelector('button[value="accept"]');
if (consentAcceptBtn) {
  consentAcceptBtn.addEventListener('click', () => {
    sessionStorage.setItem('flashpdf-session-consent', 'granted');
    setConsent('granted');
    tracker.setConsent(true);
    renderTrackingPill();
  });
}
const consentDeclineBtn = $('dlg-consent').querySelector('button[value="decline"]');
if (consentDeclineBtn) {
  consentDeclineBtn.addEventListener('click', () => {
    sessionStorage.setItem('flashpdf-session-consent', 'declined');
    setConsent('declined');
    tracker.setConsent(false);
    renderTrackingPill();
  });
}

function openPrivacy() {
  const s = state.status;
  const endpoint = s?.baseUrl ?? 'the configured endpoint';
  const local = s ? s.isLocal : true;
  const body = $('privacy-body');
  const btn = (label, fn, cls = 'btn small') => h('button', { class: cls, type: 'button', onclick: fn }, label);
  body.replaceChildren(h('div', { class: 'privacy-grid' },
    h('section', {},
      h('h3', {}, 'What PiCODE records (only with your permission)'),
      h('ul', {},
        h('li', {}, 'Text you select in the PDF (click and drag), with its page and paragraph — tagged CRITICAL_IMPORTANCE.'),
        h('li', {}, 'Scroll position, speed and direction — to ignore fast scrolling and to detect re-reading (scrolling back up over lines), tagged HIGH_RELEVANCE.'),
        h('li', {}, 'Pages read, approximate reading time per page, and returns to earlier pages. Stays under one second are never stored; time after 3 minutes without any scrolling or selecting is not counted.')),
      h('p', { class: 'small muted' }, 'Never recorded: mouse movement, pointer position or hovering, keystrokes, clipboard, screen, other tabs or applications. Signals are observations — they are not used to infer what you think or feel.'),
      h('div', { class: 'row' },
        h('span', { class: 'tag' }, `Status: ${state.demo ? 'demo (nothing recorded)' : tracker.state}`),
        state.consent === 'granted' ? btn('Withdraw permission', () => { setConsent('declined'); openPrivacy(); }) : btn('Allow reading signals', () => { $('dlg-privacy').close(); openDialog('dlg-consent'); }),
        tracker.state === 'on' ? btn('Pause', () => { tracker.pause(); openPrivacy(); }) : null,
        tracker.state === 'paused' ? btn('Resume', () => { tracker.resume(); openPrivacy(); }) : null)),
    h('section', {},
      h('h3', {}, 'Where it is stored'),
      h('p', {}, state.store?.persistent
        ? 'In this browser only (IndexedDB database “picode”). PDFs themselves are not stored; they are read from your disk each time.'
        : 'Browser storage is unavailable, so data is kept in memory and lost when the page closes.')),
    h('section', {},
      h('h3', {}, 'What is sent, and where'),
      h('p', {}, 'Only when you click Create study note or Regenerate: up to 8 PDF text excerpts (at most 12,000 characters; longer for pages you spent more time on), your selected passages with their paragraphs, re-read passages, per-page visit statistics, and — only if you tick the box — your saved notes.'),
      h('p', {}, 'They go to the PiCODE backend on this computer, which forwards them to ', h('strong', {}, endpoint), local ? ' (this computer).' : ' — a REMOTE endpoint; you are asked before every request.'),
      h('p', { class: 'small muted' }, 'No analytics, no third-party services, no CDN. Use “Preview what will be sent” in the AI notes tab to see the exact data.')),
    h('section', {},
      h('h3', {}, 'Your controls'),
      h('div', { class: 'row' },
        btn('Clear current session', () => { $('dlg-privacy').close(); clearSession(); }),
        btn('Export notes (Markdown)', () => $('btn-export-md').click()),
        btn('Export notes (JSON)', () => $('btn-export-json').click())),
      h('div', { class: 'row' },
        state.doc ? btn('Delete this document’s data', deleteDocumentData, 'btn small danger') : null,
        btn('Delete all PiCODE data', deleteAllData, 'btn small danger'))),
  ));
  for (const b of body.querySelectorAll('.row .btn')) if (!state.doc && /session|Export/.test(b.textContent)) b.disabled = true;
  openDialog('dlg-privacy');
}

async function deleteDocumentData() {
  if (!state.doc) return;
  if (!confirm(`Delete all locally stored notes, analyses and reading sessions for “${state.doc.title}”? This cannot be undone.`)) return;
  try {
    await state.store.deleteDocumentData(state.doc.docId);
    state.real = { analysis: null, notes: [] };
    state.previousSessions = null;
    state.aggregator = new ReadingAggregator({ startedAt: Date.now() });
    state.session = { id: crypto.randomUUID(), docId: state.doc.docId, startedAt: new Date().toISOString() };
    if (!state.demo) tracker.setAggregator(state.aggregator);
    $('dlg-privacy').close();
    renderAll();
    toast('Document data deleted.');
  } catch (e) { toast(`Delete failed: ${e.message}`, 'error'); }
}

async function deleteAllData() {
  if (!confirm('Delete ALL PiCODE data in this browser (notes, analyses, sessions, settings and consent)? This cannot be undone.')) return;
  try {
    await state.store.deleteAll();
    try { localStorage.removeItem('picode-theme'); } catch { /* ignore */ }
    state.real = { analysis: null, notes: [] };
    state.previousSessions = null;
    state.consent = null;
    tracker.setConsent(false);
    if (state.doc) {
      state.aggregator = new ReadingAggregator({ startedAt: Date.now() });
      state.session = { id: crypto.randomUUID(), docId: state.doc.docId, startedAt: new Date().toISOString() };
      if (!state.demo) tracker.setAggregator(state.aggregator);
    }
    $('dlg-privacy').close();
    renderAll();
    toast('All PiCODE data deleted.');
  } catch (e) { toast(`Delete failed: ${e.message}`, 'error'); }
}

els.trackingPill.addEventListener('click', () => {
  if (state.demo) { toast('Demo mode shows simulated events; real tracking is suspended.'); return; }
  if (tracker.state === 'off') openDialog('dlg-consent');
  else if (tracker.state === 'on') { tracker.pause(); toast('Tracking paused.'); }
  else { tracker.resume(); toast('Tracking resumed.'); }
});
tracker.addEventListener('change', () => { renderTrackingPill(); renderSessionTab(); });

// ------------------------------------------------------------------ tabs, panel, theme, misc

function selectTab(name) {
  state.tab = name;
  for (const t of ['notes', 'saved', 'session']) {
    const tab = $(`tab-${t}`);
    const on = t === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`view-${t}`).hidden = !on;
  }
  if (name === 'session') renderSessionTab(true);
}
const tabNames = ['notes', 'saved', 'session'];
for (const t of tabNames) {
  const tab = $(`tab-${t}`);
  tab.addEventListener('click', () => selectTab(t));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = tabNames[(tabNames.indexOf(t) + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
    selectTab(next);
    $(`tab-${next}`).focus();
  });
}

$('btn-panel').addEventListener('click', () => setPanelOpen(!els.panel.classList.contains('open')));
$('btn-panel-close').addEventListener('click', () => setPanelOpen(false));
els.scrim.addEventListener('click', () => setPanelOpen(false));

$('btn-theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('picode-theme', next); } catch { /* preference not kept */ }
});
$('btn-help').addEventListener('click', () => openDialog('dlg-help'));
$('btn-privacy').addEventListener('click', openPrivacy);
$('btn-settings').addEventListener('click', openSettings);
$('btn-open').addEventListener('click', () => els.fileInput.click());
$('btn-sample').addEventListener('click', () => { if (state.demo) exitDemo({ silent: true }); openSample(); });
els.fileInput.addEventListener('change', () => { openFile(els.fileInput.files[0]); els.fileInput.value = ''; });
document.querySelector('[data-action="open"]').addEventListener('click', () => els.fileInput.click());
document.querySelector('[data-action="sample"]').addEventListener('click', openSample);

// Drag and drop a PDF anywhere.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; els.drop.hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; els.drop.hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.drop.hidden = true;
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (file) openFile(file); else toast('Drop a PDF file to open it.', 'error');
});

// ------------------------------------------------------------------ start

async function init() {
  // Show consent dialog directly on page entry unless already granted in this session
  const sessionConsent = sessionStorage.getItem('flashpdf-session-consent');
  if (!sessionConsent) {
    setTimeout(() => openDialog('dlg-consent'), 150);
  }

  // The model check and the schema do not depend on local storage: start them first,
  // so a slow or blocked IndexedDB can never hide the model status.
  checkModel();
  loadSchema().catch((e) => toast(e.message, 'error'));
  state.store = await new Store().open();
  if (state.store.migratedRows) toast(`Your notes and sessions were loaded into FlashPDF (${state.store.migratedRows} records).`);
  if (!state.store.persistent) {
    setBanner('storage', { kind: 'warn', text: `Browser storage is unavailable (${state.store.error?.message ?? 'unknown reason'}) — notes and sessions will only last until this page is closed.` });
  }
  state.consent = sessionConsent || await state.store.getSetting('consent', null).catch(() => null);
  tracker.setConsent(state.consent === 'granted');
  renderAll();
  if (state.consent === null && !sessionConsent) {
    openDialog('dlg-consent');
  }
}

// Everything that touches storage (opening a document, saving notes) waits for this.
// (Store#open never throws: it falls back to in-memory storage itself.)
state.ready = init().catch((e) => {
  console.error(e);
  toast(`PiCODE failed to start: ${e.message}`, 'error');
});

// Debug handle for the browser console (same page only; nothing is sent anywhere).
window.picode = { reader, tracker, state };
