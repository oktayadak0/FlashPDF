// Export the study note and saved notes as Markdown or JSON.

import { studyNoteToMarkdown } from './note-format.js';

const sourceLabel = (n) => n.source === 'manual' ? 'your note'
  : n.source === 'demo' ? 'simulated demo note'
  : `AI (${n.origin?.model ?? 'model'})${n.edited ? ', edited by you' : ''}`;

const pageLabel = (p) => (p ? `p. ${p}` : 'general');

/**
 * The study note (if any) as one Markdown document, followed by the saved notes.
 * Saved notes that are themselves a copy of the study note are not repeated.
 */
export function toMarkdown({ title, notes, analysis = null, analysisMeta = null, lang = 'en', attention = new Map(), exportedAt = new Date() }) {
  const out = [];
  if (analysis?.studyNote) {
    out.push(studyNoteToMarkdown(analysis.studyNote, { lang, meta: analysisMeta, attention }).trimEnd(), '', '---', '');
  }
  const current = analysis?.studyNote ? analysisMeta?.generatedAt : null;
  const own = notes.filter((n) => !(n.origin?.section === 'studyNote' && current && n.origin.generatedAt === current));
  out.push(`# ${title} — ${lang === 'tr' ? 'kaydedilen notlar' : 'saved notes'}`, '',
    `_${lang === 'tr' ? 'Dışa aktarıldı' : 'Exported'} ${exportedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC_`, '');
  if (!own.length) out.push(lang === 'tr' ? '_Kaydedilmiş not yok._' : '_No saved notes._', '');
  for (const n of [...own].sort((a, b) => (a.page ?? 0) - (b.page ?? 0))) {
    out.push(`- **${pageLabel(n.page)}** — ${n.text.replace(/\n+/g, ' ')} _(${sourceLabel(n)})_`);
    if (n.quote) out.push(`  > ${n.quote}`);
  }
  return out.join('\n').trimEnd() + '\n';
}

export function toJSON({ title, docId, notes, analysis = null, analysisMeta = null, exportedAt = new Date() }) {
  return JSON.stringify({
    format: 'picode-export', version: 1, exportedAt: exportedAt.toISOString(),
    document: { title, docId },
    notes: notes.map(({ id, page, text, quote, source, edited, origin, createdAt, updatedAt }) =>
      ({ id, page, text, quote, source, edited, origin, createdAt, updatedAt })),
    analysis: analysis ? { meta: analysisMeta, data: analysis } : null,
  }, null, 2);
}

export function download(filename, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const safeFilename = (s) => (s || 'picode').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'picode';
