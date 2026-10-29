import { foldText } from './text-fold.js';

// Validates model output against schema/analysis.schema.json, then grounds it:
// page references must be real pages, evidence must be traceable to the
// extracted PDF text, and behaviour-based notes must cite a signal that was
// actually observed on that page. Nothing is rendered without passing here.

let schemaPromise = null;

export function loadSchema(url = new URL('../schema/analysis.schema.json', import.meta.url)) {
  schemaPromise ??= fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Could not load analysis schema (${r.status})`);
    return r.json();
  });
  return schemaPromise;
}

export function taskSchema(schema, task) {
  const keys = schema.tasks[task];
  if (!keys) throw new Error(`Unknown task "${task}"`);
  return { type: 'object', properties: Object.fromEntries(keys.map((k) => [k, schema.properties[k]])), required: keys };
}

/** Same JSON-schema subset as backend/prompts.py#validate. */
export function validate(value, schema, path = '$') {
  const errors = [];
  switch (schema.type) {
    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected object`];
      for (const k of schema.required ?? []) if (!(k in value)) errors.push(`${path}.${k}: missing`);
      for (const [k, sub] of Object.entries(schema.properties ?? {})) if (k in value) errors.push(...validate(value[k], sub, `${path}.${k}`));
      break;
    case 'array':
      if (!Array.isArray(value)) return [`${path}: expected array`];
      value.forEach((v, i) => errors.push(...validate(v, schema.items ?? {}, `${path}[${i}]`)));
      break;
    case 'string':
      if (typeof value !== 'string') errors.push(`${path}: expected string`);
      else if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(', ')}`);
      break;
    case 'integer':
      if (!Number.isInteger(value)) errors.push(`${path}: expected integer`);
      else if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
      break;
  }
  return errors;
}

/** Truncates to schema limits and drops unknown keys. */
export function normalize(value, schema) {
  if (schema.type === 'object' && value && typeof value === 'object') {
    const out = {};
    for (const [k, sub] of Object.entries(schema.properties ?? {})) if (k in value) out[k] = normalize(value[k], sub);
    return out;
  }
  if (schema.type === 'array' && Array.isArray(value)) return value.slice(0, schema.maxItems ?? value.length).map((v) => normalize(v, schema.items ?? {}));
  if (schema.type === 'string' && typeof value === 'string') return value.trim().slice(0, schema.maxLength ?? value.length);
  return value;
}

/** Case-, diacritic-, punctuation- and whitespace-insensitive form used to match evidence against PDF text. */
export function normalizeForMatch(s) {
  return foldText(String(s ?? '').normalize('NFKC').replace(/­/g, ''))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function trigrams(words) {
  const out = [];
  for (let i = 0; i + 2 < words.length; i++) out.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

/**
 * Locates an evidence string in the PDF text.
 * @returns {{status: 'verified'|'page-corrected'|'approximate'|'unverified', page: number|null}}
 */
export function locateEvidence(evidence, page, pageTexts) {
  // Models sometimes join fragments with "..." — every fragment must be found.
  const fragments = String(evidence ?? '').split(/\.{3}|…/).map(normalizeForMatch).filter((f) => f.length >= 8);
  if (!fragments.length) return { status: 'unverified', page: null };

  const norm = new Map();
  const textOf = (p) => {
    if (!norm.has(p)) norm.set(p, ` ${normalizeForMatch(pageTexts.get(p))} `);
    return norm.get(p);
  };
  const contains = (p) => fragments.every((f) => textOf(p).includes(f));
  const otherPages = [...pageTexts.keys()].filter((p) => p !== page);

  if (pageTexts.has(page) && contains(page)) return { status: 'verified', page };
  const elsewhere = otherPages.find(contains);
  if (elsewhere) return { status: 'page-corrected', page: elsewhere };

  // Approximate: most word trigrams of the evidence appear on the page (minor wording drift).
  const grams = trigrams(fragments.join(' ').split(' '));
  if (grams.length >= 2) {
    const ratio = (p) => grams.filter((g) => textOf(p).includes(g)).length / grams.length;
    if (pageTexts.has(page) && ratio(page) >= 0.6) return { status: 'approximate', page };
    const best = otherPages.map((p) => [p, ratio(p)]).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 0.6) return { status: 'approximate', page: best[0] };
  }
  return { status: 'unverified', page: null };
}

// Wording that turns behaviour into claims about the reader's mind (English and Turkish).
export const PSYCH_PATTERN = new RegExp([
  String.raw`\b(confus\w*|struggl\w*|frustrat\w*|you (?:did not|didn't|don't|do not) understand|you understood|you (?:were|are|felt|feel) (?:unsure|lost|stuck|interested|bored)|found (?:it|this) (?:hard|difficult)|you (?:liked|enjoyed|loved))\b`,
  String.raw`(kafan\p{L}* kar\p{L}*|zorland\p{L}*|anlamad\p{L}*|anlad\p{L}*n\p{L}*z|zor bul\p{L}*|sıkıl\p{L}*|ilginizi çek\p{L}*|merak ett\p{L}*)`,
].join('|'), 'iu');

const inRange = (page, pageCount) => Number.isInteger(page) && page >= 1 && page <= pageCount;

/**
 * Full check of one model response.
 * @param {object} raw            parsed JSON from the model
 * @param {string} task
 * @param {object} ctx  { schema, pageCount, pageTexts: Map<number,string>, signals: Map<number,Set<string>>,
 *                        depthByPage?: Map<number,'deep'|'standard'|'brief'> (measured attention) }
 * @returns {{ok: boolean, errors: string[], analysis: {studyNote: object}|null,
 *            dropped: Array<{section:string, reason:string, item:object}>, stats: {verified:number, total:number}}}
 */
export const IMPORTANCE_ORDER = { CRITICAL_IMPORTANCE: 0, HIGH_RELEVANCE: 1, KEY_POINT: 2 };

const overlaps = (a, b) => {
  const x = normalizeForMatch(a), y = normalizeForMatch(b);
  if (x.length < 6 || y.length < 6) return false;
  return x.includes(y.slice(0, 30)) || y.includes(x.slice(0, 30));
};

export function validateAndGround(raw, task, { schema, pageCount, pageTexts, signals, depthByPage = new Map(), selections = [] }) {
  const ts = taskSchema(schema, task);
  const errors = validate(raw, ts);
  if (errors.length) return { ok: false, errors, analysis: null, dropped: [], stats: { verified: 0, total: 0 } };
  const note = normalize(raw, ts).studyNote;
  const dropped = [];
  const stats = { verified: 0, total: 0 };

  // Locates an item's evidence; corrects its page if the quote sits on another page.
  const ground = (item) => {
    stats.total++;
    const loc = locateEvidence(item.evidence, item.page, pageTexts);
    if (loc.status === 'unverified') return { ...item, grounding: 'unverified' };
    if (loc.status === 'verified' || loc.status === 'page-corrected') stats.verified++;
    const fixed = { ...item, grounding: loc.status };
    if (loc.page !== item.page) { fixed.citedPage = item.page; fixed.page = loc.page; }
    return fixed;
  };
  const observed = (page, signal) => signals.get(page)?.has(signal) ?? false;

  const sections = [];
  for (const raw of note.sections) {
    const s = ground({ ...raw, keyPoints: raw.keyPoints.filter((k) => k.trim()) });
    if (!inRange(s.page, pageCount)) { dropped.push({ section: 'sections', reason: `page ${s.page} does not exist`, item: raw }); continue; }
    // Depth follows measured attention, not the model's own judgement.
    if (depthByPage.has(s.page) && depthByPage.get(s.page) !== s.depth) { s.modelDepth = s.depth; s.depth = depthByPage.get(s.page); }
    if (s.signal !== 'none' && !observed(s.page, s.signal)) {
      dropped.push({ section: 'readerNote', reason: `no "${s.signal}" signal was recorded on page ${s.page}`, item: { page: s.page, text: s.readerNote } });
      s.readerNote = '';
      s.signal = 'none';
    }
    if (s.signal === 'none') s.readerNote = '';   // behaviour comments need an observed signal
    s.wordingFlag = !!s.readerNote && PSYCH_PATTERN.test(s.readerNote);
    sections.push(s);
  }
  sections.sort((a, b) => a.page - b.page);

  const reviewLater = note.reviewLater.filter((it) => {
    if (inRange(it.page, pageCount) && observed(it.page, it.signal)) return true;
    dropped.push({ section: 'reviewLater', reason: `no "${it.signal}" signal was recorded on page ${it.page}`, item: it });
    return false;
  }).map((it) => ({ ...it, wordingFlag: PSYCH_PATTERN.test(it.reason) }));

  const questions = note.questions.map(ground).filter((q) => {
    if (inRange(q.page, pageCount)) return true;
    dropped.push({ section: 'questions', reason: `page ${q.page} does not exist`, item: q });
    return false;
  });

  // Highlight bullets: the importance label must match what was really observed on that page.
  const highlights = [];
  for (const h of note.highlights) {
    const g = ground(h);
    if (!inRange(g.page, pageCount)) { dropped.push({ section: 'highlights', reason: `page ${g.page} does not exist`, item: h }); continue; }
    const needs = { CRITICAL_IMPORTANCE: 'selection', HIGH_RELEVANCE: 'reread' }[g.importance];
    if (needs && !observed(g.page, needs)) {
      g.claimedImportance = g.importance;
      g.importance = observed(g.page, 'reread') ? 'HIGH_RELEVANCE' : 'KEY_POINT';
      if (g.importance === g.claimedImportance) delete g.claimedImportance;
    }
    highlights.push(g);
  }
  // Every selected passage (CRITICAL_IMPORTANCE) must appear at the top, even if the model skipped it.
  for (const s of selections) {
    if (!inRange(s.page, pageCount)) continue;
    const covered = highlights.some((h) => h.importance === 'CRITICAL_IMPORTANCE' && h.page === s.page
      && (overlaps(h.evidence, s.text) || overlaps(h.text, s.text) || overlaps(h.evidence, s.block ?? '')));
    if (!covered) {
      highlights.push({ text: s.text, page: s.page, importance: 'CRITICAL_IMPORTANCE', evidence: s.text,
                        grounding: 'verified', fromSelection: true });
    }
  }
  highlights.sort((a, b) => IMPORTANCE_ORDER[a.importance] - IMPORTANCE_ORDER[b.importance] || a.page - b.page);

  return {
    ok: true, errors: [], dropped, stats,
    analysis: { studyNote: { title: note.title, highlights, overview: note.overview, sections, reviewLater, questions } },
  };
}
