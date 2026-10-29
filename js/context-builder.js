// Builds the compact context package sent to the model.
// Excerpts are ranked by reading signals and capped in size — the model never
// receives the whole PDF or the raw event history.
//
// Weighting (strongest first):
//   CRITICAL_IMPORTANCE — selected text (with its paragraph)
//   HIGH_RELEVANCE      — re-read passages (scrolled back up over the lines)
//   then returns to a page, then reading time.
// Fast scrolling and stays under 1 s never reach this module (filtered by the
// aggregator). When reading data exists, pages that were not read are left out.

import { AGG, cleanText, IMPORTANCE } from './event-aggregator.js';
import { foldText } from './text-fold.js';

export const LIMITS = Object.freeze({
  maxExcerpts: 8,
  excerptChars: { deep: 2400, standard: 1300, brief: 500 }, // per page, by depth (backend hard limit: 2600)
  totalExcerptChars: 12000,  // across all excerpts
  maxCritical: 10,
  criticalChars: 500,
  blockChars: 1500,
  maxHigh: 8,
  highChars: 400,
  maxPageSignals: 60,
  maxNotes: 10,
  noteChars: 400,
});

export const WEIGHTS = Object.freeze({
  selection: 120,    // CRITICAL_IMPORTANCE, per selection
  reread: 60,        // HIGH_RELEVANCE, per re-read
  revisit: 20,       // per return to the page
  dwell: 1,          // per counted second on the page
});
export const MIN_INCLUDED_ATTENTION = AGG.MIN_DWELL_SECONDS; // less than 1 s of reading: not read
const HAS_READING_DATA = 20;   // max attention below this: no usable signal, cover the document evenly

const countBy = (items, value = (x) => x.count) => {
  const m = new Map();
  for (const x of items ?? []) m.set(x.page, (m.get(x.page) ?? 0) + value(x));
  return m;
};

/** Attention per page in "seconds-equivalent"; decides how detailed each part of the note is. */
export function attentionByPage(summary) {
  const map = new Map();
  const add = (page, v) => map.set(page, (map.get(page) ?? 0) + v);
  for (const p of summary.pages) add(p.page, WEIGHTS.dwell * p.dwellSeconds + WEIGHTS.revisit * p.revisits + WEIGHTS.reread * (p.rereads ?? 0));
  for (const s of summary.selections) add(s.page, WEIGHTS.selection * s.count);
  return map;
}

/** Pages with a selection or a re-read are always "deep"; otherwise relative to the most-read page. */
export function depthFor(attention, maxAttention, { critical = 0, high = 0 } = {}) {
  if (critical > 0 || high > 0) return 'deep';
  if (maxAttention < HAS_READING_DATA) return 'standard';  // no meaningful signal: balanced note
  if (attention >= Math.max(45, 0.55 * maxAttention)) return 'deep';
  if (attention >= 15) return 'standard';
  return 'brief';
}

/** Per-page counts of CRITICAL selections and HIGH re-reads. */
export function importanceByPage(summary) {
  const critical = countBy(summary.selections);
  const high = countBy(summary.rereads);
  return (page) => ({ critical: critical.get(page) ?? 0, high: high.get(page) ?? 0 });
}

/** Pages with reading signals, strongest first. */
export function rankPages(summary) {
  const attention = attentionByPage(summary);
  const imp = importanceByPage(summary);
  const stats = new Map(summary.pages.map((p) => [p.page, p]));
  return [...attention.entries()]
    .map(([page, score]) => {
      const p = stats.get(page) ?? {};
      const { critical, high } = imp(page);
      const reasons = [];
      if (critical) reasons.push(IMPORTANCE.CRITICAL);
      if (high) reasons.push(IMPORTANCE.HIGH);
      if (p.revisits) reasons.push('revisited');
      if ((p.dwellSeconds ?? 0) >= AGG.DWELL_SIGNAL_SECONDS) reasons.push('long reading time');
      return { page, score, reasons };
    })
    .filter((e) => e.reasons.length > 0)
    .sort((a, b) => b.score - a.score || a.page - b.page);
}

/** Evenly spaced pages across the document, for coverage. */
export function spreadPages(pageCount, n) {
  if (n <= 0) return [];
  if (pageCount <= n) return Array.from({ length: pageCount }, (_, i) => i + 1);
  if (n === 1) return [1];
  const out = new Set();
  for (let i = 0; i < n; i++) out.add(Math.round(1 + (i * (pageCount - 1)) / (n - 1)));
  return [...out];
}

/**
 * Chooses which pages to excerpt. Returns [{page, reasons}] sorted by page.
 * With reading data: only pages actually read (≥ 1 s, or with a selection/re-read).
 * Without (tracking off): evenly spaced pages so the note still covers the document.
 */
export function pagesForContext(task, summary, pageCount) {
  const attention = attentionByPage(summary);
  const max = Math.max(0, ...attention.values());
  const ranked = rankPages(summary).filter((r) => r.page <= pageCount);
  if (max >= HAS_READING_DATA) {
    return [...attention.entries()]
      .filter(([page, a]) => page <= pageCount && a >= MIN_INCLUDED_ATTENTION)
      .sort((a, b) => b[1] - a[1])
      .slice(0, LIMITS.maxExcerpts)
      .map(([page]) => ({ page, reasons: ranked.find((r) => r.page === page)?.reasons ?? [] }))
      .sort((a, b) => a.page - b.page);
  }
  const picked = new Map(ranked.slice(0, 6).map((r) => [r.page, r.reasons]));
  for (const page of spreadPages(pageCount, LIMITS.maxExcerpts)) {
    if (picked.size >= LIMITS.maxExcerpts) break;
    if (!picked.has(page)) picked.set(page, []);
  }
  return [...picked.entries()].map(([page, reasons]) => ({ page, reasons })).sort((a, b) => a.page - b.page);
}

/** Pages left out of the note because they were not read (only when reading data exists). */
export function excludedPages(summary, pageCount) {
  const attention = attentionByPage(summary);
  if (Math.max(0, ...attention.values()) < HAS_READING_DATA) return [];
  const out = [];
  for (let p = 1; p <= pageCount && out.length < 500; p++) if ((attention.get(p) ?? 0) < MIN_INCLUDED_ATTENTION) out.push(p);
  return out;
}

function cutAtWords(text, start, end) {
  let s = start, e = Math.min(end, text.length);
  if (s > 0) { const sp = text.indexOf(' ', s); if (sp !== -1 && sp < e) s = sp + 1; }
  if (e < text.length) { const sp = text.lastIndexOf(' ', e); if (sp > s) e = sp; }
  return (s > 0 ? '… ' : '') + text.slice(s, e) + (e < text.length ? ' …' : '');
}

/** A window of `maxChars` from a page's text, centred on the first anchor that occurs in it. */
export function excerptFor(pageText, anchors, maxChars) {
  const text = cleanText(pageText);
  if (text.length <= maxChars) return text;
  const lower = foldText(text);
  for (const a of anchors) {
    const needle = foldText(cleanText(a)).slice(0, 80);
    if (needle.length < 4) continue;
    const at = lower.indexOf(needle);
    if (at !== -1) {
      const start = Math.max(0, Math.min(at - Math.floor(maxChars / 3), text.length - maxChars));
      return cutAtWords(text, start, start + maxChars);
    }
  }
  return cutAtWords(text, 0, maxChars);
}

/** Text lines between two normalized heights of a page. */
export function textInRange(lines, yStart, yEnd) {
  if (!lines?.length) return '';
  return cleanText(lines.filter((l) => l.ny >= yStart && l.ny <= yEnd).map((l) => l.text).join(' '));
}

const truncate = (s, n) => { const t = cleanText(s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/**
 * @param {object} p
 * @param {'note'} p.task
 * @param {string} p.title
 * @param {string|null} [p.language]
 * @param {number} p.pageCount
 * @param {number} p.currentPage
 * @param {object} p.summary         ReadingAggregator#summary()
 * @param {Map<number,string>} p.pageTexts   extracted text for (at least) the needed pages
 * @param {Map<number,Array>} [p.pageLines]  text lines with normalized y, for re-read passages
 * @param {Array} [p.notes]          saved notes (sent only if includeNotes)
 * @param {boolean} [p.includeNotes]
 */
export function buildContext({ task, title, language = null, pageCount, currentPage, summary, pageTexts, pageLines = new Map(), notes = [], includeNotes = false }) {
  const picks = pagesForContext(task, summary, pageCount).filter((p) => cleanText(pageTexts.get(p.page)).length > 0);
  const attention = attentionByPage(summary);
  const imp = importanceByPage(summary);
  const maxAttention = Math.max(0, ...attention.values());
  for (const p of picks) {
    p.attentionSeconds = Math.round(attention.get(p.page) ?? 0);
    p.depth = depthFor(p.attentionSeconds, maxAttention, imp(p.page));
  }
  // Deep pages get the most text; scale everything down if the total budget is exceeded.
  const wanted = picks.reduce((n, p) => n + LIMITS.excerptChars[p.depth], 0);
  const factor = Math.min(1, LIMITS.totalExcerptChars / Math.max(1, wanted));
  const budget = (p) => Math.max(300, Math.floor(LIMITS.excerptChars[p.depth] * factor));
  const included = new Set(picks.map((p) => p.page));

  // CRITICAL_IMPORTANCE: selections with their paragraph.
  const criticalPassages = [...summary.selections]
    .filter((s) => included.has(s.page))
    .sort((a, b) => b.count - a.count || a.page - b.page)
    .slice(0, LIMITS.maxCritical)
    .map((s) => ({ page: s.page, text: truncate(s.text, LIMITS.criticalChars), block: truncate(s.block || s.text, LIMITS.blockChars),
                   count: s.count, importance: IMPORTANCE.CRITICAL }));

  // HIGH_RELEVANCE: the lines the reader scrolled back up over.
  const highRelevancePassages = [];
  for (const r of summary.rereads ?? []) {
    if (!included.has(r.page) || highRelevancePassages.length >= LIMITS.maxHigh) continue;
    const text = textInRange(pageLines.get(r.page), r.yStart - 0.02, r.yEnd + 0.02);
    if (text) highRelevancePassages.push({ page: r.page, text: truncate(text, LIMITS.highChars), count: r.count, relevance: IMPORTANCE.HIGH });
  }

  const excerpts = picks.map((p) => {
    const anchors = [   // centre the excerpt on the most important passage of the page
      ...criticalPassages.filter((c) => c.page === p.page).map((c) => c.block),
      ...highRelevancePassages.filter((h) => h.page === p.page).map((h) => h.text),
    ];
    return { page: p.page, text: excerptFor(pageTexts.get(p.page), anchors, budget(p)), reasons: p.reasons,
             depth: p.depth, attentionSeconds: p.attentionSeconds };
  });

  const pageSignals = summary.pages
    .filter((p) => p.dwellSeconds > 0 && included.has(p.page))
    .slice(0, LIMITS.maxPageSignals)
    .map((p) => ({ page: p.page, visits: p.visits, revisits: p.revisits, dwellSeconds: Math.round(p.dwellSeconds), rereads: p.rereads ?? 0 }));

  const existingNotes = includeNotes
    ? notes.slice(0, LIMITS.maxNotes).map((n) => ({ page: n.page ?? null, text: truncate(n.text, LIMITS.noteChars) }))
    : [];

  return {
    task,
    document: { title: truncate(title || 'Untitled document', 200), pageCount, language },
    progress: {
      currentPage: Math.max(1, currentPage || 1),
      pagesVisited: summary.pagesVisited,
      percentVisited: Math.round((1000 * summary.pagesVisited) / Math.max(1, pageCount)) / 10,
      totalReadingSeconds: summary.totalActiveSeconds,
    },
    excerpts,
    criticalPassages,
    highRelevancePassages,
    pageSignals,
    existingNotes,
  };
}
