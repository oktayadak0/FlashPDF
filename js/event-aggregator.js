// Turns reading signals into a small set of aggregated records.
//
// Pure logic: time is always passed in (milliseconds), so it is fully testable.
//
// Signals, by weight:
//   CRITICAL_IMPORTANCE — text the reader selected (click + drag). The only pointer
//                         interaction PiCODE uses; general mouse movement is not tracked.
//   HIGH_RELEVANCE      — re-reading: scrolling down within a page, then back up over
//                         the same lines and staying there for at least 1 second.
//   weaker              — returns to a page, reading time on a page.
// Noise that never enters the data:
//   • stays on a page shorter than 1 second (measured with real elapsed time)
//   • fast scrolling (more than one screen per second)
//   • time after 3 minutes without any scrolling or selecting (reader likely away)
//
// Coarse event record (the only per-event structure PiCODE stores):
// {
//   pageNumber: 3,
//   eventType: "page_visit" | "page_revisit" | "text_selection" | "text_reread",
//   timestamp: "2026-10-17T12:00:00.000Z",
//   dwellTimeSeconds?: 18.5,             // page_visit
//   revisitCount?: 2,                    // revisits / re-reads of that page so far
//   secondsSinceLastVisit?: 95,          // page_revisit
//   selectedText?: "Example passage",    // text_selection
//   selectionCount?: 2,                  // text_selection
//   importance?: "CRITICAL_IMPORTANCE",  // text_selection
//   relevance?: "HIGH_RELEVANCE",        // text_reread
//   region?: { band: 4, yStart: 0.33, yEnd: 0.42 }  // text_reread, normalized to page height
// }

export const IMPORTANCE = Object.freeze({ CRITICAL: 'CRITICAL_IMPORTANCE', HIGH: 'HIGH_RELEVANCE' });

export const AGG = Object.freeze({
  MIN_DWELL_SECONDS: 1,       // anything shorter is ignored (never written to state)
  IDLE_CAP_SECONDS: 180,      // no scroll/selection for this long → further time is not counted
  REGION_BANDS: 12,           // used to key re-read regions
  DWELL_SIGNAL_SECONDS: 20,   // page reading time above this is reported to the model
  MAX_EVENTS: 200,
  MAX_SELECTIONS: 50,
  MAX_SELECTION_CHARS: 1000,
  MAX_BLOCK_CHARS: 1500,
  MAX_VISIT_LOG: 20,
  MAX_REREADS: 60,
});

export const EVENT_TYPES = ['page_visit', 'page_revisit', 'text_selection', 'text_reread'];
export const SIGNALS = ['selection', 'reread', 'revisit', 'dwell'];

const iso = (ms) => new Date(ms).toISOString();
export const cleanText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const round1 = (v) => Math.round(v * 10) / 10;

export class ReadingAggregator {
  constructor({ startedAt = Date.now() } = {}) {
    this.reset(startedAt);
  }

  reset(now = Date.now()) {
    this.startedAt = now;
    this.totalActiveSeconds = 0;   // counted reading time
    this.skimmedSeconds = 0;       // fast scrolling: not counted
    this.idleIgnoredSeconds = 0;   // after the idle cap: not counted
    this.ignoredShortVisits = 0;   // stays under 1 s: only this counter, no page data
    this.pages = {};       // page -> { page, dwellSeconds, visits, revisits, rereads, lastVisitEnd, visitLog[] }
    this.rereads = {};     // "page:b0-b1" -> { page, yStart, yEnd, count, lastAt, relevance }
    this.selections = {};  // "page:text" -> { page, text, block, count, firstAt, lastAt, importance }
    this.events = [];
    this.current = null;   // visit in progress: { page, enteredAt, lastTickAt, accrued, settled }
    this.lastSettledPage = null;
  }

  _page(n) {
    return (this.pages[n] ??= { page: n, dwellSeconds: 0, visits: 0, revisits: 0, rereads: 0, lastVisitEnd: null, visitLog: [] });
  }

  _event(e) {
    this.events.push(e);
    if (this.events.length > AGG.MAX_EVENTS) this.events.splice(0, this.events.length - AGG.MAX_EVENTS);
  }

  /** The reader is now looking at `page`. */
  setPage(page, now) {
    if (!Number.isInteger(page) || page < 1) return;
    if (this.current?.page === page) return;
    this._endVisit(now);
    this.current = { page, enteredAt: now, lastTickAt: now, accrued: 0, settled: false };
  }

  /** Stop accruing (tracking paused, document closed). */
  suspend(now) {
    this._endVisit(now);
  }

  _endVisit(now) {
    const c = this.current;
    if (!c) return;
    if (c.settled) {
      const p = this._page(c.page);
      p.lastVisitEnd = now;
      p.visitLog.push({ start: iso(c.enteredAt), end: iso(now), seconds: round1(c.accrued) });
      if (p.visitLog.length > AGG.MAX_VISIT_LOG) p.visitLog.shift();
      this._event({ pageNumber: c.page, eventType: 'page_visit', timestamp: iso(now),
                    dwellTimeSeconds: round1(c.accrued), revisitCount: p.revisits });
    } else {
      this.ignoredShortVisits += 1;   // under 1 s: nothing about this page is stored
    }
    this.current = null;
  }

  _settle(c, now) {
    c.settled = true;
    const p = this._page(c.page);
    if (p.visits === 0) {
      p.visits = 1;
    } else if (this.lastSettledPage !== c.page) {
      // Back on a page after properly visiting another one: a revisit.
      p.visits += 1;
      p.revisits += 1;
      const gap = p.lastVisitEnd != null ? Math.round((c.enteredAt - p.lastVisitEnd) / 1000) : null;
      this._event({ pageNumber: c.page, eventType: 'page_revisit', timestamp: iso(now),
                    revisitCount: p.revisits, secondsSinceLastVisit: gap });
    }
    this.lastSettledPage = c.page;
    p.dwellSeconds += c.accrued;
    this.totalActiveSeconds += c.accrued;
  }

  /**
   * Called on every sampling tick. Counts the real time elapsed since the previous
   * tick (at most `seconds`), so a stay of 0.3 s adds 0.3 s, never a whole sample.
   * @param {number} now
   * @param {object} s
   * @param {boolean} [s.active=true]     tab visible and tracking on
   * @param {number} [s.seconds=1]        sampling interval (upper bound per tick)
   * @param {number} [s.idleSeconds=0]    seconds since the last scroll or selection
   * @param {boolean} [s.skimming=false]  scrolling faster than one screen per second
   */
  tick(now, { active = true, seconds = 1, idleSeconds = 0, skimming = false } = {}) {
    const c = this.current;
    if (!c) return;
    const elapsed = Math.min(seconds, Math.max(0, (now - c.lastTickAt) / 1000));
    c.lastTickAt = now;
    if (!active) return;
    if (skimming) { this.skimmedSeconds += elapsed; return; }
    if (idleSeconds >= AGG.IDLE_CAP_SECONDS) { this.idleIgnoredSeconds += elapsed; return; }
    c.accrued += elapsed;
    if (c.settled) {
      const p = this._page(c.page);
      p.dwellSeconds += elapsed;
      this.totalActiveSeconds += elapsed;
    } else if (c.accrued >= AGG.MIN_DWELL_SECONDS) {
      this._settle(c, now);
    }
  }

  /**
   * HIGH_RELEVANCE: the reader scrolled down within a page and then back up over the
   * part between yStart and yEnd (normalized page heights) and stayed there ≥ 1 s.
   */
  recordReread({ page, yStart, yEnd }, now) {
    if (!Number.isInteger(page) || page < 1) return null;
    const a = clamp01(Math.min(yStart, yEnd)), b = clamp01(Math.max(yStart, yEnd));
    if (b - a < 0.01) return null;
    const b0 = Math.min(AGG.REGION_BANDS - 1, Math.floor(a * AGG.REGION_BANDS));
    const b1 = Math.min(AGG.REGION_BANDS - 1, Math.floor(b * AGG.REGION_BANDS));
    const key = `${page}:${b0}-${b1}`;
    if (!this.rereads[key] && Object.keys(this.rereads).length >= AGG.MAX_REREADS) return null;
    const entry = (this.rereads[key] ??= { page, yStart: +a.toFixed(3), yEnd: +b.toFixed(3), count: 0, lastAt: null, relevance: IMPORTANCE.HIGH });
    entry.count += 1;
    entry.lastAt = iso(now);
    const p = this._page(page);
    p.rereads += 1;
    this._event({ pageNumber: page, eventType: 'text_reread', timestamp: iso(now), revisitCount: p.rereads,
                  relevance: IMPORTANCE.HIGH, region: { band: b0, yStart: entry.yStart, yEnd: entry.yEnd } });
    return entry;
  }

  /**
   * CRITICAL_IMPORTANCE: text the reader selected. `block` is the paragraph around
   * the selection (from the PDF text), sent to the model with the selection.
   */
  recordSelection({ page, text, block = '', ny = null }, now) {
    const clean = cleanText(text).slice(0, AGG.MAX_SELECTION_CHARS);
    if (!Number.isInteger(page) || page < 1 || clean.length < 3) return null;
    const key = `${page}:${clean.toLowerCase().slice(0, 200)}`;
    let entry = this.selections[key];
    if (!entry) {
      if (Object.keys(this.selections).length >= AGG.MAX_SELECTIONS) return null;
      entry = this.selections[key] = { page, text: clean, block: '', count: 0, firstAt: iso(now), lastAt: null, ny, importance: IMPORTANCE.CRITICAL };
    }
    const b = cleanText(block).slice(0, AGG.MAX_BLOCK_CHARS);
    if (b.length > entry.block.length) entry.block = b;
    entry.count += 1;
    entry.lastAt = iso(now);
    this._event({ pageNumber: page, eventType: 'text_selection', timestamp: iso(now),
                  selectedText: clean, selectionCount: entry.count, importance: IMPORTANCE.CRITICAL });
    return entry;
  }

  /** Read-only aggregate view used by the UI and the context builder. */
  summary(now = Date.now()) {
    const pages = Object.values(this.pages)
      .filter((p) => p.dwellSeconds > 0 || p.visits > 0 || p.rereads > 0)
      .map(({ page, dwellSeconds, visits, revisits, rereads, lastVisitEnd }) =>
        ({ page, dwellSeconds: round1(dwellSeconds), visits, revisits, rereads, lastVisitEnd }))
      .sort((a, b) => a.page - b.page);
    const rereads = Object.values(this.rereads).map((r) => ({ ...r }))
      .sort((a, b) => b.count - a.count || a.page - b.page);
    const selections = Object.values(this.selections).map((s) => ({ ...s }))
      .sort((a, b) => (b.lastAt > a.lastAt ? 1 : -1));
    return {
      startedAt: iso(this.startedAt),
      durationSeconds: Math.max(0, Math.round((now - this.startedAt) / 1000)),
      totalActiveSeconds: round1(this.totalActiveSeconds),
      skimmedSeconds: round1(this.skimmedSeconds),
      idleIgnoredSeconds: round1(this.idleIgnoredSeconds),
      ignoredShortVisits: this.ignoredShortVisits,
      currentPage: this.current?.page ?? null,
      pagesVisited: pages.filter((p) => p.visits > 0).length,
      pages,
      revisitedPages: pages.filter((p) => p.revisits > 0),
      rereads,
      selections,
      events: this.events.slice(-60),
      eventCount: this.events.length,
    };
  }

  isEmpty() {
    return this.totalActiveSeconds === 0 && Object.keys(this.selections).length === 0 && Object.keys(this.rereads).length === 0;
  }

  /** Persistable snapshot: aggregates and coarse events only. */
  toJSON() {
    return {
      version: 2,
      startedAt: this.startedAt,
      totalActiveSeconds: this.totalActiveSeconds,
      skimmedSeconds: this.skimmedSeconds,
      idleIgnoredSeconds: this.idleIgnoredSeconds,
      ignoredShortVisits: this.ignoredShortVisits,
      pages: this.pages,
      rereads: this.rereads,
      selections: this.selections,
      events: this.events,
      lastSettledPage: this.lastSettledPage,
    };
  }

  static fromJSON(data) {
    const a = new ReadingAggregator({ startedAt: data?.startedAt ?? Date.now() });
    if (!data || (data.version !== 1 && data.version !== 2)) return a;
    a.totalActiveSeconds = data.totalActiveSeconds ?? 0;
    a.skimmedSeconds = data.skimmedSeconds ?? 0;
    a.idleIgnoredSeconds = data.idleIgnoredSeconds ?? 0;
    a.ignoredShortVisits = data.ignoredShortVisits ?? 0;
    a.pages = {};
    for (const [k, p] of Object.entries(data.pages ?? {})) {
      a.pages[k] = { page: p.page, dwellSeconds: p.dwellSeconds ?? 0, visits: p.visits ?? 0, revisits: p.revisits ?? 0,
                     rereads: p.rereads ?? 0, lastVisitEnd: p.lastVisitEnd ?? null, visitLog: structuredClone(p.visitLog ?? []) };
    }
    a.rereads = structuredClone(data.rereads ?? {});
    for (const r of Object.values(a.rereads)) r.relevance = IMPORTANCE.HIGH;
    a.selections = structuredClone(data.selections ?? {});
    for (const s of Object.values(a.selections)) { s.block ??= ''; s.importance = IMPORTANCE.CRITICAL; }
    a.events = structuredClone((data.events ?? []).filter((e) => EVENT_TYPES.includes(e.eventType)));
    a.lastSettledPage = data.lastSettledPage ?? null;
    return a;
  }
}

/** Which behaviour signals were actually observed per page (used to reject unsupported model claims). */
export function signalsByPage(summary) {
  const map = new Map();
  const add = (page, s) => { if (!map.has(page)) map.set(page, new Set()); map.get(page).add(s); };
  for (const s of summary.selections) add(s.page, 'selection');
  for (const r of summary.rereads ?? []) add(r.page, 'reread');
  for (const p of summary.pages) {
    if (p.revisits > 0) add(p.page, 'revisit');
    if (p.dwellSeconds >= AGG.DWELL_SIGNAL_SECONDS) add(p.page, 'dwell');
  }
  return map;
}

/** Validates one coarse event record. Returns a list of problems (empty = valid). */
export function validateEvent(e) {
  const errs = [];
  if (!e || typeof e !== 'object') return ['not an object'];
  if (!Number.isInteger(e.pageNumber) || e.pageNumber < 1) errs.push('pageNumber must be a positive integer');
  if (!EVENT_TYPES.includes(e.eventType)) errs.push(`eventType must be one of ${EVENT_TYPES.join(', ')}`);
  if (typeof e.timestamp !== 'string' || Number.isNaN(Date.parse(e.timestamp))) errs.push('timestamp must be ISO-8601');
  if ('dwellTimeSeconds' in e && !(e.dwellTimeSeconds >= AGG.MIN_DWELL_SECONDS)) errs.push(`dwellTimeSeconds must be >= ${AGG.MIN_DWELL_SECONDS}`);
  if ('revisitCount' in e && !(Number.isInteger(e.revisitCount) && e.revisitCount >= 0)) errs.push('revisitCount must be a non-negative integer');
  if (e.eventType === 'text_selection') {
    if (!(typeof e.selectedText === 'string' && e.selectedText.length > 0)) errs.push('text_selection needs selectedText');
    if (e.importance !== IMPORTANCE.CRITICAL) errs.push('text_selection must be CRITICAL_IMPORTANCE');
  }
  if (e.eventType === 'text_reread') {
    if (!(e.region && e.region.yStart >= 0 && e.region.yEnd <= 1)) errs.push('text_reread needs a normalized region');
    if (e.relevance !== IMPORTANCE.HIGH) errs.push('text_reread must be HIGH_RELEVANCE');
  }
  return errs;
}
