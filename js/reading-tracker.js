// Observes a deliberately small set of reading signals inside the PDF viewer
// and feeds them to a ReadingAggregator. Nothing is recorded unless the user
// consented and tracking is not paused.
//
// Listens ONLY to:
//   • text selection inside the PDF (click + drag) → CRITICAL_IMPORTANCE
//   • the viewer's scroll position → fast-scroll filter and re-read detection (HIGH_RELEVANCE)
//   • page changes and tab visibility → reading time per page
// It does not listen to pointer movement, hover or position, keyboard input,
// the clipboard, or anything outside the viewer.

export const TRACKER = Object.freeze({
  SAMPLE_MS: 500,             // sampling interval; elapsed time is measured exactly
  MIN_DWELL_MS: 1000,         // a re-read only counts if the reader stays ≥ 1 s on it
  SKIM_WINDOW_MS: 1500,
  SKIM_SCREENS_PER_SECOND: 1, // faster scrolling than this is skimming
  REREAD_MIN_PX: 50,          // scrolling back up at least this far (and ≥ 4% of a page) is a re-read
  REREAD_MAX_SCREENS: 1.5,    // longer jumps back are navigation, not re-reading
  READING_LINE: 0.35,         // the line of the viewport the reader is assumed to look at
  SELECTION_DEBOUNCE_MS: 700,
});

export class ReadingTracker extends EventTarget {
  constructor({ reader, viewer }) {
    super();
    this.reader = reader;
    this.viewer = viewer;
    this.aggregator = null;
    this.consent = false;
    this.paused = false;
    this.lastActivity = Date.now();
    this.scrollTrail = [];     // last ~1.5 s of scroll positions, in memory only
    this.lastSelection = '';
    this._selTimer = 0;
    this._resetScroll();

    viewer.addEventListener('scroll', () => this._onScroll(), { passive: true });
    document.addEventListener('selectionchange', () => {
      clearTimeout(this._selTimer);
      this._selTimer = setTimeout(() => this._onSelection(), TRACKER.SELECTION_DEBOUNCE_MS);
    });
    reader.addEventListener('pagechange', (e) => {
      if (this.active) this.aggregator.setPage(e.detail.page, Date.now());
    });
    this._timer = setInterval(() => this._tick(), TRACKER.SAMPLE_MS);
  }

  get active() { return this.consent && !this.paused && !!this.aggregator; }
  get state() { return !this.consent ? 'off' : this.paused ? 'paused' : 'on'; }

  /** Attach a fresh aggregator (new session) or null (no document / demo mode). */
  setAggregator(agg) {
    this.aggregator?.suspend(Date.now());
    this.aggregator = agg;
    this.lastSelection = '';
    this._resetScroll();
    this.lastActivity = Date.now();
    if (this.active && this.reader.numPages) agg.setPage(this.reader.currentPage, Date.now());
    this._changed();
  }

  setConsent(granted) {
    this.consent = !!granted;
    this.lastActivity = Date.now();
    if (!this.consent) this.aggregator?.suspend(Date.now());
    else if (this.active && this.reader.numPages) this.aggregator.setPage(this.reader.currentPage, Date.now());
    this._changed();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.aggregator?.suspend(Date.now());
    this._changed();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.lastActivity = Date.now();
    this._resetScroll();
    if (this.active && this.reader.numPages) this.aggregator.setPage(this.reader.currentPage, Date.now());
    this._changed();
  }

  // ------------------------------------------------------------ scrolling: skim speed and re-reading
  _resetScroll() {
    clearTimeout(this._rereadTimer);
    this.scroll = { lastTop: this.viewer.scrollTop, peak: this.viewer.scrollTop, downTravel: 0, up: null };
    this.scrollTrail = [];
  }

  _onScroll() {
    const now = Date.now();
    const top = this.viewer.scrollTop;
    const s = this.scroll;
    const delta = top - s.lastTop;
    s.lastTop = top;
    if (this.reader.isProgrammaticScroll()) {   // jumps made by the app are not reading behaviour
      this._resetScroll();
      return;
    }
    this.lastActivity = now;
    this.scrollTrail.push({ t: now, top });
    while (this.scrollTrail.length && now - this.scrollTrail[0].t > TRACKER.SKIM_WINDOW_MS) this.scrollTrail.shift();
    if (!this.active || delta === 0) return;

    if (delta > 0) {                       // moving down the page
      if (s.up) {
        // Scrolled back up, then down again: it was a re-read only if the reader stayed ≥ 1 s.
        if (now - s.up.lastAt >= TRACKER.MIN_DWELL_MS) this._finishReread();
        else this._dropReread();
      }
      s.peak = Math.max(s.peak, top);
      s.downTravel += delta;
    } else {                               // moving back up
      s.up ??= { from: s.peak };
      s.up.to = top;
      s.up.lastAt = now;
    }
    clearTimeout(this._rereadTimer);
    if (s.up) this._rereadTimer = setTimeout(() => this._finishReread(), TRACKER.MIN_DWELL_MS);
  }

  _dropReread() {
    this.scroll.up = null;
    this.scroll.peak = this.scroll.lastTop;
    this.scroll.downTravel = 0;
  }

  _finishReread() {
    const s = this.scroll;
    const ep = s.up;
    s.up = null;
    if (!ep || ep.to == null || !this.active) return;
    const dist = ep.from - ep.to;
    const screen = this.viewer.clientHeight;
    const minDist = Math.max(TRACKER.REREAD_MIN_PX, 0.04 * this.reader.pageHeightPx());
    // Must have scrolled down over (most of) that part first; very long jumps are navigation.
    if (dist >= minDist && dist <= TRACKER.REREAD_MAX_SCREENS * screen && s.downTravel >= dist * 0.5) {
      const line = screen * TRACKER.READING_LINE;   // the lines that passed the reading line again
      const now = Date.now();
      let recorded = false;
      for (const r of this.reader.rangeToPages(ep.to + line, ep.from + line)) {
        if (this.aggregator.recordReread(r, now)) recorded = true;
      }
      if (recorded) this._changed();
    }
    s.peak = s.lastTop;
    s.downTravel = 0;
  }

  /** True while the reader scrolls faster than one screen per second. */
  isSkimming(now = Date.now()) {
    const trail = this.scrollTrail.filter((x) => now - x.t <= TRACKER.SKIM_WINDOW_MS);
    if (trail.length < 2) return false;
    let travel = 0;
    for (let i = 1; i < trail.length; i++) travel += Math.abs(trail[i].top - trail[i - 1].top);
    return travel / Math.max(1, this.viewer.clientHeight) / (TRACKER.SKIM_WINDOW_MS / 1000) >= TRACKER.SKIM_SCREENS_PER_SECOND;
  }

  // ------------------------------------------------------------ text selection (CRITICAL_IMPORTANCE)
  _onSelection() {
    const info = this.reader.selectionInfo();
    if (!info) { this.lastSelection = ''; return; }
    this.lastActivity = Date.now();
    const key = `${info.page}:${info.text}`;
    if (!this.active || key === this.lastSelection) return;
    this.lastSelection = key;
    const block = this.reader.paragraphAround(info.page, info.text);
    if (this.aggregator.recordSelection({ ...info, block }, Date.now())) this._changed();
  }

  _tick() {
    if (!this.active) return;
    const now = Date.now();
    this.aggregator.tick(now, {
      active: document.visibilityState === 'visible',
      seconds: TRACKER.SAMPLE_MS / 1000,
      idleSeconds: (now - this.lastActivity) / 1000,
      skimming: this.isSkimming(now),
    });
    this._changed();
  }

  _changed() { this.dispatchEvent(new Event('change')); }
}
