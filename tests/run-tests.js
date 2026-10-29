// Minimal in-browser test runner (no dependencies). Open /tests/ while the app server runs.

import { ReadingAggregator, AGG, IMPORTANCE, signalsByPage, validateEvent } from '../js/event-aggregator.js';
import { buildContext, rankPages, spreadPages, excerptFor, textInRange, attentionByPage, depthFor, excludedPages, importanceByPage, LIMITS } from '../js/context-builder.js';
import { loadSchema, validate, taskSchema, validateAndGround, locateEvidence, normalizeForMatch, PSYCH_PATTERN } from '../js/schema-validator.js';
import { Store, createNote, validateNote } from '../js/local-storage.js';
import { toMarkdown, toJSON } from '../js/export.js';
import { studyNoteToMarkdown, shortParagraphs } from '../js/note-format.js';
import { foldText, detectLanguage } from '../js/text-fold.js';
import { paragraphAround } from '../js/pdf-reader.js';
import { DEMO_ANALYSIS, demoAggregate, SAMPLE } from '../js/demo-data.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const eq = (a, b, msg = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, msg = 'expected truthy') => { if (!v) throw new Error(msg); };

/** Simulates `seconds` of reading on `page` with 1 s ticks. */
function read(agg, t, page, seconds, opts = {}) {
  agg.setPage(page, t.now);
  for (let i = 0; i < seconds; i++) { t.now += 1000; agg.tick(t.now, opts); }
}

// ---------------------------------------------------------------- noise filtering
test('stays under 1 second never reach the page data', () => {
  const t = { now: 0 }; const a = new ReadingAggregator({ startedAt: 0 });
  read(a, t, 1, 5);
  a.setPage(2, t.now); t.now += 600; a.tick(t.now, { seconds: 1 });   // 0.6 s on page 2
  read(a, t, 3, 4);
  a.suspend(t.now);
  const s = a.summary(t.now);
  eq(s.pages.map((p) => p.page), [1, 3], 'page 2 not stored at all');
  eq(s.ignoredShortVisits, 1);
  eq(s.totalActiveSeconds, 9);
  ok(!s.events.some((e) => e.pageNumber === 2), 'no events for page 2');
});

test('elapsed time is measured exactly (a tick never adds more than the real time)', () => {
  const a = new ReadingAggregator({ startedAt: 0 });
  a.setPage(1, 0);
  a.tick(400, { seconds: 1 });
  a.tick(1300, { seconds: 1 });
  a.tick(1800, { seconds: 1 });
  eq(a.summary(1800).pages[0].dwellSeconds, 1.8);
});

test('fast scrolling is ignored', () => {
  const t = { now: 0 }; const a = new ReadingAggregator({ startedAt: 0 });
  a.setPage(1, 0);
  for (let i = 0; i < 10; i++) { t.now += 1000; a.tick(t.now, { skimming: true }); }
  for (let i = 0; i < 4; i++) { t.now += 1000; a.tick(t.now); }
  const s = a.summary(t.now);
  eq([s.pages[0].dwellSeconds, s.skimmedSeconds], [4, 10]);
});

test('time after 3 minutes without scrolling or selecting is not counted', () => {
  const t = { now: 0 }; const a = new ReadingAggregator({ startedAt: 0 });
  a.setPage(1, 0);
  for (let i = 0; i < 200; i++) { t.now += 1000; a.tick(t.now, { idleSeconds: i + 1 }); }
  const s = a.summary(t.now);
  eq(s.pages[0].dwellSeconds, AGG.IDLE_CAP_SECONDS - 1);
  eq(s.idleIgnoredSeconds, 200 - (AGG.IDLE_CAP_SECONDS - 1));
});

test('inactive ticks (hidden tab) do not add time', () => {
  const a = new ReadingAggregator({ startedAt: 0 });
  a.setPage(1, 0);
  for (let i = 1; i <= 30; i++) a.tick(i * 1000, { active: i <= 4 });
  eq(a.summary(30000).pages[0].dwellSeconds, 4);
});

// ---------------------------------------------------------------- visits, selections, re-reads
test('returning to a page after visiting another counts as a revisit', () => {
  const t = { now: 0 }; const a = new ReadingAggregator({ startedAt: 0 });
  read(a, t, 1, 5); read(a, t, 2, 5); read(a, t, 1, 5); read(a, t, 2, 4); read(a, t, 1, 4);
  const s = a.summary(t.now);
  eq(s.pages.find((p) => p.page === 1).revisits, 2);
  eq(s.pages.find((p) => p.page === 2).revisits, 1);
  eq(s.events.find((e) => e.eventType === 'page_revisit').secondsSinceLastVisit, 5, 'gap between visits');
});

test('a sub-second bounce to another page is not a revisit', () => {
  const t = { now: 0 }; const a = new ReadingAggregator({ startedAt: 0 });
  read(a, t, 1, 5);
  a.setPage(2, t.now); t.now += 300;
  read(a, t, 1, 5);
  const p1 = a.summary(t.now).pages.find((p) => p.page === 1);
  eq([p1.visits, p1.revisits], [1, 0]);
});

test('selections are CRITICAL_IMPORTANCE, deduplicated and keep their paragraph', () => {
  const a = new ReadingAggregator({ startedAt: 0 });
  a.recordSelection({ page: 3, text: '  Aralıklı   çalışma ', block: 'Aralıklı çalışma daha kalıcıdır.' }, 1000);
  a.recordSelection({ page: 3, text: 'aralıklı çalışma' }, 2000);
  a.recordSelection({ page: 4, text: 'Aralıklı çalışma' }, 3000);
  ok(a.recordSelection({ page: 4, text: 'ab' }, 4000) === null, 'too short ignored');
  const s = a.summary(5000);
  const p3 = s.selections.find((x) => x.page === 3);
  eq([s.selections.length, p3.count, p3.text, p3.block, p3.importance], [2, 2, 'Aralıklı çalışma', 'Aralıklı çalışma daha kalıcıdır.', IMPORTANCE.CRITICAL]);
});

test('re-reads are HIGH_RELEVANCE, recorded per page region and as events', () => {
  const a = new ReadingAggregator({ startedAt: 0 });
  a.recordReread({ page: 2, yStart: 0.31, yEnd: 0.2 }, 1000);
  a.recordReread({ page: 2, yStart: 0.2, yEnd: 0.31 }, 2000);
  ok(a.recordReread({ page: 2, yStart: 0.5, yEnd: 0.501 }, 3000) === null, 'tiny ranges ignored');
  const s = a.summary(3000);
  eq([s.rereads.length, s.rereads[0].count, s.rereads[0].relevance, s.pages[0].rereads], [1, 2, IMPORTANCE.HIGH, 2]);
  ok(signalsByPage(s).get(2).has('reread'));
});

test('all emitted events match the documented event schema', () => {
  const t = { now: Date.parse('2026-10-17T10:00:00Z') }; const a = new ReadingAggregator({ startedAt: t.now });
  read(a, t, 1, 5); read(a, t, 2, 5);
  a.recordSelection({ page: 2, text: 'hello world' }, t.now);
  a.recordReread({ page: 2, yStart: 0.1, yEnd: 0.3 }, t.now);
  read(a, t, 1, 5);
  a.suspend(t.now);
  const events = a.summary(t.now).events;
  eq(new Set(events.map((e) => e.eventType)).size, 4, 'all four event types emitted');
  for (const e of events) eq(validateEvent(e), [], `event ${e.eventType}`);
  ok(validateEvent({ pageNumber: 0, eventType: 'mouse_move', timestamp: 'x' }).length === 3, 'invalid event rejected');
  ok(validateEvent({ pageNumber: 1, eventType: 'page_visit', timestamp: new Date().toISOString(), dwellTimeSeconds: 0.4 }).length === 1, 'sub-second visit rejected');
});

test('snapshot round-trips; old snapshots lose their pointer data', () => {
  const t = { now: 0 }; const a = new ReadingAggregator({ startedAt: 0 });
  read(a, t, 1, 5); read(a, t, 2, 5); read(a, t, 1, 5);
  a.recordSelection({ page: 1, text: 'abc def' }, t.now);
  const b = ReadingAggregator.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));
  eq(b.summary(t.now).pages, a.summary(t.now).pages);
  eq(b.summary(t.now).selections, a.summary(t.now).selections);
  const old = ReadingAggregator.fromJSON({ version: 1, pages: { 1: { page: 1, dwellSeconds: 9, activeSeconds: 5, visits: 1, revisits: 0 } },
    regions: { '1:2': { page: 1, band: 2, dwellSeconds: 9 } }, events: [{ pageNumber: 1, eventType: 'region_dwell', timestamp: 'x' }] });
  const json = JSON.stringify(old.toJSON());
  ok(!json.includes('activeSeconds') && !json.includes('region_dwell') && !('regions' in old.toJSON()), 'pointer-derived data dropped');
});

test('signalsByPage reflects only observed behaviour', () => {
  const sig = signalsByPage(ReadingAggregator.fromJSON(demoAggregate(0)).summary(0));
  ok(['selection', 'reread', 'revisit', 'dwell'].every((x) => sig.get(2).has(x)));
  ok(!sig.get(1).has('reread') && !sig.get(1).has('selection'));
  ok(!sig.has(6), 'page 6 has no signals');
});

// ---------------------------------------------------------------- tracker (DOM)
test('tracker listens to no mouse events; detects re-reads only after a 1 s stay; flags fast scrolling', async () => {
  const { ReadingTracker } = await import('../js/reading-tracker.js');
  const viewer = document.createElement('div');
  viewer.style.cssText = 'position:fixed;left:-9999px;top:0;width:300px;height:500px;overflow:auto';
  viewer.append(Object.assign(document.createElement('div'), { style: 'height:5000px' }));
  document.body.append(viewer);
  const viewerEvents = [], docEvents = [];
  const vAdd = viewer.addEventListener.bind(viewer);
  viewer.addEventListener = (type, ...rest) => { viewerEvents.push(type); return vAdd(type, ...rest); };
  const dAdd = document.addEventListener;
  document.addEventListener = function (type, ...rest) { docEvents.push(type); return dAdd.call(this, type, ...rest); };
  const ranges = [];
  const reader = Object.assign(new EventTarget(), {
    numPages: 1, currentPage: 1, isProgrammaticScroll: () => false, pageHeightPx: () => 1000,
    rangeToPages: (a, b) => { ranges.push([a, b]); return [{ page: 1, yStart: a / 5000, yEnd: b / 5000 }]; },
    selectionInfo: () => null, paragraphAround: (p, t) => t,
  });
  let tracker;
  try {
    tracker = new ReadingTracker({ reader, viewer });
  } finally {
    document.addEventListener = dAdd;
  }
  clearInterval(tracker._timer);
  try {
    const mouse = /pointer|mouse|wheel|hover|touch|drag|click/;
    eq(viewerEvents, ['scroll'], 'viewer listeners');
    eq(docEvents, ['selectionchange'], 'document listeners');
    ok(![...viewerEvents, ...docEvents].some((e) => mouse.test(e)), 'no mouse listeners');

    const agg = new ReadingAggregator({ startedAt: Date.now() });
    tracker.setConsent(true);
    tracker.setAggregator(agg);
    const scrollTo = (top, ago = 0) => { viewer.scrollTop = top; tracker._onScroll(); if (ago && tracker.scroll.up) tracker.scroll.up.lastAt -= ago; };
    // Up and straight back down (< 1 s on the re-read lines): ignored.
    for (const top of [100, 200, 300, 400, 250]) scrollTo(top);
    scrollTo(450);
    eq(agg.summary().rereads.length, 0, 'sub-second re-read ignored');
    // Up, stay ≥ 1 s, then down: recorded.
    for (const top of [600, 700]) scrollTo(top);
    scrollTo(550, 1500);
    scrollTo(800);
    eq(agg.summary().rereads.length, 1, 're-read after a 1 s stay');
    eq(ranges.at(-1).map(Math.round), [550 + 500 * 0.35, 700 + 500 * 0.35], 'the lines scrolled back over (browsers may report sub-pixel scroll)');
    // A small wobble is never a re-read.
    for (const top of [900, 920, 905]) scrollTo(top);
    tracker._finishReread();
    eq(agg.summary().rereads.length, 1, 'wobble ignored');

    const now = Date.now();
    tracker.scrollTrail = [{ t: now - 1000, top: 0 }, { t: now - 500, top: 900 }, { t: now, top: 1800 }];
    ok(tracker.isSkimming(now), 'fast scrolling flagged');
    tracker.scrollTrail = [{ t: now - 1000, top: 0 }, { t: now, top: 200 }];
    ok(!tracker.isSkimming(now), 'normal scrolling not flagged');
  } finally {
    clearTimeout(tracker._rereadTimer);
    tracker.aggregator = null;
    viewer.remove();
  }
});

test('a selection expands to its paragraph', () => {
  const lines = [
    { ny: 0.10, text: 'Başlık' },
    { ny: 0.15, text: 'Birinci paragrafın ilk satırı ve' },
    { ny: 0.17, text: 'devamı burada biter.' },
    { ny: 0.21, text: 'İkinci paragraf test etkisini' },
    { ny: 0.23, text: 'anlatır ve burada biter.' },
  ];
  eq(paragraphAround(lines, 'test etkisini anlatır'), 'İkinci paragraf test etkisini anlatır ve burada biter.');
  eq(paragraphAround(lines, 'olmayan bir metin'), 'olmayan bir metin', 'fallback to the selection');
});

// ---------------------------------------------------------------- attention → note depth
test('selections (critical) and re-reads (high) weigh most and force "deep"', () => {
  const s = ReadingAggregator.fromJSON(demoAggregate(0)).summary(0);
  const att = attentionByPage(s);
  const max = Math.max(...att.values());
  const imp = importanceByPage(s);
  eq([1, 2, 3, 4, 5].map((p) => depthFor(att.get(p) ?? 0, max, imp(p))), ['standard', 'deep', 'deep', 'standard', 'standard']);
  eq(depthFor(10, 900, { critical: 1 }), 'deep');
  eq(depthFor(10, 900, { high: 1 }), 'deep');
  eq(depthFor(5, 10), 'standard', 'no meaningful signal anywhere: balanced note');
  const one = (o) => attentionByPage({ pages: [{ page: 1, revisits: 0, dwellSeconds: 0, rereads: 0, ...o.page }], selections: o.sel ?? [] }).get(1);
  ok(one({ sel: [{ page: 1, count: 1 }] }) > one({ page: { rereads: 1 } }), 'selection > re-read');
  ok(one({ page: { rereads: 1 } }) > one({ page: { dwellSeconds: 45 } }), 're-read > 45 s of reading');
});

test('context: critical then high passages, unread pages left out, deep pages get more text', () => {
  const texts = new Map(Array.from({ length: 6 }, (_, i) => [i + 1, `Sayfa ${i + 1} metni. `.repeat(300)]));
  const s = ReadingAggregator.fromJSON(demoAggregate(0)).summary(0);
  const ctx = buildContext({ task: 'note', title: 'T', language: 'tr', pageCount: 6, currentPage: 2, summary: s, pageTexts: texts,
    pageLines: new Map([[2, [{ ny: 0.25, text: 'Sayfa 2 metni.' }]]]) });
  const by = Object.fromEntries(ctx.excerpts.map((e) => [e.page, e]));
  eq(Object.keys(by).map(Number), [1, 2, 3, 4, 5], 'page 6 (not read) excluded');
  eq(excludedPages(s, 6), [6]);
  eq([by[2].depth, by[1].depth], ['deep', 'standard']);
  ok(by[2].text.length > 1.5 * by[1].text.length, `deep ${by[2].text.length} vs standard ${by[1].text.length}`);
  eq(by[2].reasons.slice(0, 2), [IMPORTANCE.CRITICAL, IMPORTANCE.HIGH], 'strongest reasons first');
  eq(ctx.criticalPassages.map((c) => [c.page, c.importance, c.block.startsWith(c.text.slice(0, 10)) || c.block.length > c.text.length]),
    [[2, IMPORTANCE.CRITICAL, true], [3, IMPORTANCE.CRITICAL, true]]);
  eq(ctx.highRelevancePassages.map((r) => [r.page, r.count, r.relevance]), [[2, 2, IMPORTANCE.HIGH]], 'only pages with line data');
  ok(!('regionSignals' in ctx) && !('selections' in ctx), 'no pointer-derived fields');
  const empty = { pages: [], selections: [], rereads: [], pagesVisited: 0, totalActiveSeconds: 0 };
  eq(buildContext({ task: 'note', title: 'T', pageCount: 6, currentPage: 1, summary: empty, pageTexts: texts }).excerpts.length, 6,
    'tracking off: whole document covered');
});

test('page ranking puts critical pages first', () => {
  const ranked = rankPages(ReadingAggregator.fromJSON(demoAggregate(0)).summary(0));
  eq(ranked[0].page, 2);
  eq(ranked[0].reasons[0], IMPORTANCE.CRITICAL);
});

test('spreadPages covers the document evenly and stays in range', () => {
  eq(spreadPages(5, 8), [1, 2, 3, 4, 5]);
  const big = spreadPages(500, 8);
  eq(big.length, 8); eq(big[0], 1); eq(big[7], 500);
});

test('context respects size limits and only references real pages', () => {
  const pageCount = 40;
  const texts = new Map(Array.from({ length: pageCount }, (_, i) => [i + 1, `Page ${i + 1} text. `.repeat(400)]));
  const s = ReadingAggregator.fromJSON(demoAggregate(0)).summary(0);
  const ctx = buildContext({ task: 'note', title: 'T', pageCount, currentPage: 3, summary: s, pageTexts: texts });
  ok(ctx.excerpts.length <= LIMITS.maxExcerpts);
  const total = ctx.excerpts.reduce((n, e) => n + e.text.length, 0);
  ok(total <= LIMITS.totalExcerptChars + ctx.excerpts.length * 4, `${total} chars`);
  ok(ctx.excerpts.every((e) => e.page >= 1 && e.page <= pageCount && e.text.length <= 2600));
});

test('excerpts are centred on the selected paragraph (Turkish-safe)', () => {
  const text = 'a '.repeat(2000) + 'İLGİLİ PASAJ burada ' + 'b '.repeat(2000);
  const ex = excerptFor(text, ['ilgili pasaj'], 300);
  ok(ex.includes('İLGİLİ PASAJ burada'), ex.slice(0, 80));
  ok(ex.length <= 306);
});

test('textInRange returns the lines between two heights', () => {
  const lines = [{ ny: 0.05, text: 'top' }, { ny: 0.30, text: 'middle' }, { ny: 0.9, text: 'bottom' }];
  eq(textInRange(lines, 0.2, 0.4), 'middle');
  eq(textInRange(lines, 0.5, 0.6), '');
});

// ---------------------------------------------------------------- Turkish text handling
test('folding keeps length and ignores Turkish case and diacritics', () => {
  eq(foldText('İĞNE ışık Şöyle'), 'igne isik soyle');
  eq(foldText('İstanbul').length, 'İstanbul'.length);
  eq(normalizeForMatch('Geri ÇAĞIRMANIN — sağladığı'), normalizeForMatch('geri cagirmanin sagladigi'));
  eq(detectLanguage('Bu rehber, öğrenmeyi daha kalıcı hale getiren teknikleri anlatır ve açıklar.'), 'tr');
  eq(detectLanguage('This guide explains study techniques that improve retention.'), 'en');
});

test('psychological wording is flagged in English and Turkish, tips are not', () => {
  ok(PSYCH_PATTERN.test('You were confused by this section.'));
  ok(PSYCH_PATTERN.test('Bu bölümde kafanız karıştı.'));
  ok(!PSYCH_PATTERN.test('Bu paragrafı seçtiniz; bakmadan özetlemeyi deneyin.'));
});

// ---------------------------------------------------------------- response validation & grounding
const pageTexts = new Map([
  [1, 'Unutma öğrenmeden hemen sonra en hızlıdır ve ardından yavaşlar.'],
  [2, 'Geri çağırmanın sağladığı bu yarara test etkisi denir.\nTest bir öğrenme olayıdır.'],
  [3, 'Aralıklı çalışma yığılmış çalışmadan daha başarılıdır.'],
]);
const section = (o) => ({ heading: 'H', page: 1, depth: 'standard', content: 'İçerik.', keyPoints: [], evidence: '', readerNote: '', signal: 'none', ...o });
const noteWith = (o) => ({ studyNote: { title: 'T', highlights: [], overview: 'O', sections: [], reviewLater: [], questions: [], ...o } });

test('schema validation rejects wrong shapes and enums', async () => {
  const schema = await loadSchema();
  const ts = taskSchema(schema, 'note');
  eq(validate(noteWith({}), ts), []);
  const errs = validate(noteWith({ sections: [section({ page: '2', depth: 'huge', signal: 'cursor_region' })], questions: undefined,
    highlights: [{ text: 't', page: 1, importance: 'LOW', evidence: 'e' }] }), ts);
  ok(errs.some((e) => e.includes('questions: expected array')), errs.join('; '));
  ok(errs.some((e) => e.includes('page: expected integer')));
  ok(errs.some((e) => e.includes('depth: must be one of')));
  ok(errs.some((e) => e.includes('signal: must be one of')), 'pointer signals no longer allowed');
  ok(errs.some((e) => e.includes('importance: must be one of')));
});

test('evidence matching tolerates case, punctuation, line breaks and diacritics', () => {
  eq(locateEvidence('geri ÇAĞIRMANIN sağladığı — bu yarara test etkisi denir', 2, pageTexts).status, 'verified');
  eq(locateEvidence('Geri cagirmanin sagladigi bu yarara test etkisi denir', 2, pageTexts).status, 'verified');
  eq(locateEvidence('Geri çağırmanın sağladığı bu yarara test etkisi denir.', 3, pageTexts), { status: 'page-corrected', page: 2 });
  eq(locateEvidence('Öğrenciler her gün on iki saat uyumalıdır', 2, pageTexts).status, 'unverified');
});

test('highlights: labels must match observed behaviour; missing selections are added on top', async () => {
  const schema = await loadSchema();
  const signals = new Map([[2, new Set(['selection', 'reread'])], [3, new Set(['reread'])]]);
  const raw = noteWith({ highlights: [
    { text: 'Key idea', page: 1, importance: 'KEY_POINT', evidence: 'Unutma öğrenmeden hemen sonra en hızlıdır' },
    { text: 'Claims critical, but nothing was selected on p.3', page: 3, importance: 'CRITICAL_IMPORTANCE', evidence: 'Aralıklı çalışma yığılmış çalışmadan daha başarılıdır.' },
    { text: 'Claims high on p.1 without re-read', page: 1, importance: 'HIGH_RELEVANCE', evidence: 'ardından yavaşlar' },
    { text: 'Real re-read', page: 2, importance: 'HIGH_RELEVANCE', evidence: 'Test bir öğrenme olayıdır.' },
  ] });
  const selections = [{ page: 2, text: 'Geri çağırmanın sağladığı bu yarara test etkisi denir.', block: '' }];
  const r = validateAndGround(raw, 'note', { schema, pageCount: 3, pageTexts, signals, selections });
  const hl = r.analysis.studyNote.highlights;
  eq(hl.map((x) => [x.page, x.importance]), [[2, 'CRITICAL_IMPORTANCE'], [2, 'HIGH_RELEVANCE'], [3, 'HIGH_RELEVANCE'], [1, 'KEY_POINT'], [1, 'KEY_POINT']],
    'critical first, then high, then key; false labels downgraded');
  ok(hl[0].fromSelection, 'the selection the model skipped was added');
  eq(hl.find((x) => x.page === 3).claimedImportance, 'CRITICAL_IMPORTANCE');
});

test('grounding enforces measured depth, real pages, quotes and observed signals', async () => {
  const schema = await loadSchema();
  const signals = new Map([[2, new Set(['selection', 'revisit'])]]);
  const raw = noteWith({
    sections: [
      section({ page: 3, depth: 'brief', evidence: 'Aralıklı çalışma yığılmış çalışmadan daha başarılıdır.' }),
      section({ page: 1, evidence: 'Geri çağırmanın sağladığı bu yarara test etkisi denir.' }),       // wrong page
      section({ page: 2, depth: 'standard', evidence: 'Test bir öğrenme olayıdır.', readerNote: 'Bu cümleyi seçtiniz.', signal: 'selection' }),
      section({ page: 2, evidence: 'Uydurma bir cümle burada duruyor.', readerNote: 'Bu sayfada kafanız karıştı.', signal: 'revisit' }),
      section({ page: 1, evidence: '', readerNote: 'Burada uzun süre kaldınız.', signal: 'dwell' }),   // dwell not observed on p.1
      section({ page: 99, evidence: 'yok' }),
    ],
    reviewLater: [{ page: 2, reason: 'Geri döndünüz.', signal: 'revisit' }, { page: 3, reason: 'x', signal: 'reread' }],
    questions: [{ question: 'Q', answer: 'A', page: 2, evidence: 'Test bir öğrenme olayıdır.' }],
  });
  const depthByPage = new Map([[1, 'standard'], [2, 'deep'], [3, 'standard']]);
  const r = validateAndGround(raw, 'note', { schema, pageCount: 3, pageTexts, signals, depthByPage });
  ok(r.ok, r.errors.join('; '));
  const secs = r.analysis.studyNote.sections;
  eq(secs.map((x) => x.page), [1, 2, 2, 2, 3], 'sorted by page, page 99 dropped, wrong page corrected');
  eq(secs.find((x) => x.page === 3).depth, 'standard', 'measured depth overrides the model');
  eq(secs.filter((x) => x.page === 2 && x.readerNote).length, 2);
  ok(secs.find((x) => x.readerNote.includes('kafanız')).wordingFlag, 'psychological wording flagged');
  eq(secs.find((x) => x.page === 1).readerNote, '', 'unobserved dwell claim removed');
  eq(r.analysis.studyNote.reviewLater.map((x) => x.page), [2]);
});

test('the demo note grounds fully against the real sample PDF', async () => {
  const schema = await loadSchema();
  const pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  const res = await fetch(`../${SAMPLE.url}`);
  ok(res.ok, 'sample PDF is served');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()) }).promise;
  const texts = new Map();
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    texts.set(p, tc.items.map((i) => i.str + (i.hasEOL ? '\n' : '')).join(''));
  }
  const summary = ReadingAggregator.fromJSON(demoAggregate(0)).summary(0);
  for (const s of summary.selections) eq(locateEvidence(s.block, s.page, texts).status, 'verified', `block on p.${s.page} is real PDF text`);
  const r = validateAndGround(DEMO_ANALYSIS, 'note', { schema, pageCount: doc.numPages, pageTexts: texts, signals: signalsByPage(summary), selections: summary.selections });
  ok(r.ok, r.errors.join('; '));
  eq(r.dropped, [], 'nothing dropped');
  eq(r.stats.verified, r.stats.total, `${r.stats.verified}/${r.stats.total} quotes verified`);
  ok(!r.analysis.studyNote.highlights.some((h) => h.fromSelection || h.claimedImportance), 'demo labels all correct');
  doc.destroy();
});

// ---------------------------------------------------------------- storage & export
test('notes persist, update and delete in IndexedDB', async () => {
  const name = `picode-test-${Date.now()}`;
  const store = await new Store(name).open();
  ok(store.persistent, 'IndexedDB available');
  try {
    const n = createNote({ docId: 'doc-a', text: 'İlk not', page: 2 });
    await store.saveNote(n);
    await store.saveNote(createNote({ docId: 'doc-b', text: 'Other doc' }));
    eq((await store.listNotes('doc-a')).map((x) => x.text), ['İlk not']);
    await store.saveNote({ ...n, text: 'Düzenlendi', edited: true });
    eq((await store.listNotes('doc-a'))[0].text, 'Düzenlendi');
    await store.saveSession({ id: 's1', docId: 'doc-a', startedAt: 'x', aggregate: {} });
    await store.saveAnalysis('doc-a', { studyNote: {} }, {});
    await store.deleteDocumentData('doc-a');
    eq(await store.listNotes('doc-a'), []);
    eq(await store.listSessions('doc-a'), []);
    eq(await store.getAnalysis('doc-a'), undefined);
    eq((await store.listNotes('doc-b')).length, 1, 'other documents untouched');
    let threw = false;
    try { await store.saveNote({ ...n, text: '   ' }); } catch { threw = true; }
    ok(threw, 'empty note rejected');
  } finally {
    store.close();
    indexedDB.deleteDatabase(name);
  }
});

test('data from the pre-rename (FocusNote) database is moved once, then the old database is removed', async () => {
  const stamp = Date.now();
  const src = `focusnote-mig-${stamp}`, dst = `picode-mig-${stamp}`;
  const old = await new Store(src, { migrateFrom: null }).open();
  await old.saveNote(createNote({ docId: 'd', text: 'eski not', page: 1 }));
  await old.setSetting('consent', 'granted');
  old.close();
  const s = await new Store(dst, { migrateFrom: src }).open();
  try {
    eq(s.migratedRows, 2);
    eq((await s.listNotes('d'))[0].text, 'eski not');
    eq(await s.getSetting('consent'), 'granted');
    await new Promise((r) => setTimeout(r, 300));
    ok(!(await indexedDB.databases()).some((d) => d.name === src), 'old database removed');
  } finally {
    s.close();
  }
  const again = await new Store(dst, { migrateFrom: src }).open();
  eq(again.migratedRows, 0, 'nothing migrated twice');
  again.close();
  indexedDB.deleteDatabase(dst);
});

test('an old tab holding the FocusNote database cannot freeze start-up', async () => {
  const stamp = Date.now();
  const legacyName = `focusnote-stuck-${stamp}`, newName = `picode-stuck-${stamp}`;
  // An "old tab": legacy connection kept open with no versionchange handler (pre-fix code).
  const legacy = await new Store(legacyName, { migrateFrom: null }).open();
  await legacy.setSetting('consent', 'granted');
  const oldTab = legacy.backend.db;
  oldTab.onversionchange = null;
  indexedDB.deleteDatabase(legacyName);   // a previous migration's delete, now blocked
  const t0 = performance.now();
  const s = await new Store(newName, { migrateFrom: legacyName }).open();
  const ms = performance.now() - t0;
  try {
    ok(ms < 4000, `open() returned in ${Math.round(ms)} ms`);
    ok(s.persistent, 'the app still gets its own persistent storage');
    ok(s.migrationError, 'migration was skipped, to be retried next start');
    await s.setSetting('x', 1);
    eq(await s.getSetting('x'), 1, 'storage works');
  } finally {
    s.close();
    oldTab.close();
    indexedDB.deleteDatabase(newName);
  }
});

test('our own connections step aside when another tab deletes the database', async () => {
  const name = `picode-yield-${Date.now()}`;
  const s = await new Store(name, { migrateFrom: null }).open();
  const deleted = await Promise.race([
    new Promise((r) => { const req = indexedDB.deleteDatabase(name); req.onsuccess = () => r(true); }),
    new Promise((r) => setTimeout(() => r(false), 3000)),
  ]);
  ok(deleted, 'delete was not blocked by our open connection');
  s.close();
});

test('note validation', () => {
  eq(validateNote(createNote({ docId: 'd', text: 'x', page: 1 })), []);
  ok(validateNote({ id: 'a', docId: 'd', text: 'x', page: 0, source: 'ai' }).length === 1);
  ok(validateNote({ id: 'a', docId: 'd', text: 'x', source: 'robot' }).length === 1);
});

test('the note exports as one block: highlights, then a sub-headed summary of short paragraphs', () => {
  const note = DEMO_ANALYSIS.studyNote;
  const md = studyNoteToMarkdown(note, { lang: 'tr', meta: { model: 'gemma4:12b' }, attention: new Map([[2, 610]]) });
  ok(md.startsWith(`# ${note.title}\n`));
  const at = (s) => md.indexOf(s);
  ok(at('## Öne çıkanlar') > 0 && at('## Öne çıkanlar') < at('## Özet') && at('## Özet') < at('## Kaynaklar'), 'order');
  const bullets = md.slice(at('## Öne çıkanlar'), at('## Özet'));
  ok(bullets.indexOf('Çok önemli') < bullets.indexOf('Yüksek') && bullets.indexOf('Yüksek') < bullets.indexOf('**Önemli:**'), 'critical → high → key');
  const summary = md.slice(at('## Özet'), at('## Kaynaklar'));
  eq((summary.match(/^### /gm) ?? []).length, note.sections.length, 'one H3 sub-heading per section');
  ok(summary.includes('### Geri çağırma pratiği ve test etkisi _(s. 2)_'));
  ok(summary.indexOf('_(s. 1)_') < summary.indexOf('_(s. 5)_'), 'page order');
  const prose = summary.split('\n').filter((l) => l && !/^(#|-|_|>)/.test(l));
  ok(prose.every((l) => l.split(/\s+/).length <= 70), `paragraphs are short (longest ${Math.max(...prose.map((l) => l.split(/\s+/).length))} words)`);
  ok(md.includes('_Ayrıntılı, yaklaşık 10 dk 10 sn dikkat_'));
  eq((md.match(/^# /gm) ?? []).length, 1, 'single document');
});

test('long paragraphs are split into short ones at sentence boundaries', () => {
  const text = 'Birinci cümle burada. İkinci cümle de var. Üçüncü cümle geliyor. Dördüncü cümle biter.\n\nYeni paragraf.';
  eq(shortParagraphs(text), ['Birinci cümle burada. İkinci cümle de var.', 'Üçüncü cümle geliyor. Dördüncü cümle biter.', 'Yeni paragraf.']);
  eq(shortParagraphs('Ebbinghaus 1885 yılında yayımladı. Sonra 2. bölüme geçti.', { maxSentences: 1 }), ['Ebbinghaus 1885 yılında yayımladı.', 'Sonra 2. bölüme geçti.']);
  eq(shortParagraphs('Kısa.'), ['Kısa.']);
  eq(shortParagraphs('Paragraf bir.\n\nkeyPoints: \n- sızan madde\n- ikinci madde'), ['Paragraf bir.'], 'leaked lists/labels removed');
});

test('AI notes: summary is an accordion that toggles smoothly and keeps its state', async () => {
  const { renderNotes } = await import('../js/notes-panel.js');
  const root = document.createElement('div');
  document.body.append(root);
  try {
    const noop = () => {};
    const props = { hasDoc: true, note: DEMO_ANALYSIS.studyNote, lastRun: { simulated: true }, dropped: [], stats: null, busy: false,
      modelOk: true, isSample: true, lang: 'tr', attention: new Map(), pageStats: new Map(), excluded: [6],
      handlers: { goToPage: noop, locate: noop, saveNote: noop, copyNote: noop, regenerate: noop, openSettings: noop, startDemo: noop } };
    renderNotes(root, props);
    const card = root.querySelector('.note-card');
    ok(card, 'one note card');
    const accs = [...card.querySelectorAll('.acc')];
    eq(accs.map((a) => a.querySelector('.acc-title').textContent), ['Özet', 'Kaynaklar ve okuma notları', 'Kendini test et']);
    const summary = accs[0];
    const btn = summary.querySelector('.acc-btn');
    const panel = summary.querySelector('.acc-panel');
    eq([summary.dataset.open, btn.getAttribute('aria-expanded'), panel.inert], ['true', 'true', false], 'summary open by default');
    const css = await (await fetch('../styles/main.css', { cache: 'no-store' })).text();
    ok(/\.acc-panel\s*\{[^}]*transition:\s*grid-template-rows/.test(css), 'smooth height transition');
    eq(summary.querySelectorAll('h4.sum-h').length, DEMO_ANALYSIS.studyNote.sections.length, 'H4 sub-heading per section');
    ok(summary.querySelectorAll('.sum-points li').length > 0, 'key points as bullets');
    eq(accs[1].querySelector('.acc-panel').inert, true, 'sources collapsed and inert');
    btn.click();
    eq([summary.dataset.open, btn.getAttribute('aria-expanded'), panel.inert], ['false', 'false', true], 'collapsed');
    renderNotes(root, props);
    eq(root.querySelector('.acc').dataset.open, 'false', 'state kept across re-render');
    root.querySelector('.acc-btn').click();
    eq(root.querySelector('.acc').dataset.open, 'true');
    ok(card.querySelector('.hl-list') && card.querySelector('.hl-list').compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING, 'highlights come before the summary');
  } finally {
    root.remove();
  }
});

test('branding: FlashPDF title and wordmark, no model-status pill in the header', async () => {
  const html = await (await fetch('../', { cache: 'no-store' })).text();
  ok(!/FocusNote/i.test(html), 'no FocusNote left in the page');
  ok(html.includes('<title>FlashPDF</title>'));
  ok(html.includes('class="wordmark"') && html.includes('aria-label="FlashPDF"'), 'FlashPDF wordmark in the header');
  ok(!html.includes('model-pill'), 'model status pill removed');
  for (const f of ['../js/app.js', '../js/notes-panel.js', '../js/local-storage.js', '../js/export.js']) {
    const src = await (await fetch(f, { cache: 'no-store' })).text();
    ok(!/FocusNote/.test(src.replace(/moved from FocusNote|Moving data from FocusNote|LEGACY_DB_NAME = 'focusnote'|before the app was renamed/g, '')), `${f} renamed`);
  }
});

test('Markdown and JSON exports contain notes with provenance', () => {
  const notes = [
    { ...createNote({ docId: 'd', text: 'Mine', page: 3 }) },
    { ...createNote({ docId: 'd', text: 'From AI', page: 1, source: 'ai', origin: { model: 'gemma4:12b' } }), edited: true },
    { ...createNote({ docId: 'd', text: '# saved copy', source: 'ai', origin: { section: 'studyNote', model: 'gemma4:12b', generatedAt: 'g1' } }) },
  ];
  const md = toMarkdown({ title: 'Doc', notes, analysis: DEMO_ANALYSIS, analysisMeta: { model: 'gemma4:12b', generatedAt: 'g1' }, lang: 'tr' });
  ok(md.startsWith(`# ${DEMO_ANALYSIS.studyNote.title}`), 'study note first');
  ok(md.includes('_(your note)_') && md.includes('AI (gemma4:12b), edited by you'));
  ok(!md.includes('# saved copy'), 'saved copy of the current note is not duplicated');
  const js = JSON.parse(toJSON({ title: 'Doc', docId: 'd', notes }));
  eq([js.format, js.notes.length], ['picode-export', 3]);
});

// ---------------------------------------------------------------- run
const out = document.getElementById('results');
let passed = 0;
for (const t of tests) {
  const row = document.createElement('div');
  try {
    await t.fn();
    passed++;
    row.className = 'pass';
    row.textContent = `✓ ${t.name}`;
  } catch (e) {
    row.className = 'fail';
    row.textContent = `✗ ${t.name}`;
    const pre = document.createElement('pre');
    pre.textContent = e.stack || String(e);
    row.append(pre);
  }
  out.append(row);
}
const summary = document.getElementById('summary');
summary.textContent = `${passed}/${tests.length} passed`;
summary.className = passed === tests.length ? 'pass' : 'fail';
window.testResults = { passed, total: tests.length };
