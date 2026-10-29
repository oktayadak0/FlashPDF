// Renders the "Session" tab: exactly what has been recorded in this reading
// session, plus tracking controls. Transparency is the point of this view.

import { h, fmtDuration, clockTime } from './dom.js';
import { textInRange } from './context-builder.js';

function describeEvent(e) {
  switch (e.eventType) {
    case 'page_visit': return `Read for ${fmtDuration(e.dwellTimeSeconds)}`;
    case 'page_revisit': return `Returned to page (revisit #${e.revisitCount}${e.secondsSinceLastVisit != null ? `, ${fmtDuration(e.secondsSinceLastVisit)} after leaving` : ''})`;
    case 'text_selection': return `CRITICAL · selected “${e.selectedText.slice(0, 70)}${e.selectedText.length > 70 ? '…' : ''}”${e.selectionCount > 1 ? ` (×${e.selectionCount})` : ''}`;
    case 'text_reread': return `HIGH · scrolled back to re-read ${Math.round(e.region.yStart * 100)}–${Math.round(e.region.yEnd * 100)}% of the page (re-read #${e.revisitCount})`;
    default: return e.eventType;
  }
}

const stat = (v, k, cls = '') => h('div', { class: `stat ${cls}` }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));

/**
 * @param {HTMLElement} root
 * @param {object} s { hasDoc, isDemo, state, summary, pageCount, lines: Map, previousSessions, persistent, handlers }
 */
export function renderSession(root, s) {
  const hd = s.handlers;
  root.replaceChildren();
  if (s.isDemo) {
    root.append(h('div', { class: 'callout sim' }, h('strong', {}, 'Example events (simulated). '),
      'These are hand-written sample interactions for the demo. Your real reading is not recorded in demo mode.'));
  } else {
    const label = { on: 'Recording reading signals', paused: 'Tracking paused', off: 'Tracking is off' }[s.state];
    root.append(h('div', { class: 'track-controls' },
      h('span', { class: 'tag', style: 'height:28px;padding:0 10px' }, label),
      s.state === 'on' ? h('button', { class: 'btn small', type: 'button', onclick: hd.pause }, 'Pause') : null,
      s.state === 'paused' ? h('button', { class: 'btn small primary', type: 'button', onclick: hd.resume }, 'Resume') : null,
      s.state === 'off' ? h('button', { class: 'btn small primary', type: 'button', onclick: hd.askConsent }, 'Allow reading signals') : null,
      s.hasDoc ? h('button', { class: 'btn small', type: 'button', onclick: hd.clearSession }, 'Clear session') : null,
      h('button', { class: 'link-btn small', type: 'button', onclick: hd.openPrivacy }, 'What is collected?'),
    ));
    if (s.state === 'off') root.append(h('div', { class: 'callout' }, 'Without reading signals PiCODE can still summarize the document, but selections and re-reads cannot shape the note.'));
    if (!s.persistent) root.append(h('div', { class: 'callout warn' }, 'Browser storage is unavailable, so this session and your notes will be lost when the page closes.'));
  }
  if (!s.hasDoc) { root.append(h('div', { class: 'empty-panel' }, h('strong', {}, 'No document open'))); return; }

  const sum = s.summary;
  const selections = sum.selections.reduce((n, x) => n + x.count, 0);
  const rereads = (sum.rereads ?? []).reduce((n, r) => n + r.count, 0);
  const revisits = sum.pages.reduce((n, p) => n + p.revisits, 0);
  root.append(h('div', { class: 'stats' },
    stat(String(selections), 'selections · critical', 'crit'),
    stat(String(rereads), 're-reads · high', 'high'),
    stat(fmtDuration(sum.totalActiveSeconds), 'reading time'),
    stat(`${sum.pagesVisited}/${s.pageCount}`, 'pages read'),
    stat(String(revisits), 'page revisits'),
    stat(fmtDuration(sum.durationSeconds), 'session length'),
  ));
  const ignored = [];
  if (sum.ignoredShortVisits) ignored.push(`${sum.ignoredShortVisits} page pass${sum.ignoredShortVisits > 1 ? 'es' : ''} under 1 s`);
  if (sum.skimmedSeconds >= 1) ignored.push(`${fmtDuration(sum.skimmedSeconds)} of fast scrolling`);
  if (sum.idleIgnoredSeconds >= 1) ignored.push(`${fmtDuration(sum.idleIgnoredSeconds)} after 3 min without scrolling or selecting`);
  if (ignored.length) root.append(h('p', { class: 'section-note' }, `Ignored as noise: ${ignored.join(', ')}.`));

  if (sum.selections.length) {
    root.append(h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h3', {}, 'Selected passages'), h('span', { class: 'imp-badge crit' }, 'CRITICAL')),
      sum.selections.slice(0, 12).map((x) => h('article', { class: 'card clickable imp-card crit', tabindex: 0, onclick: () => hd.locateText(x.page, x.text) },
        h('div', { class: 'card-top' }, h('p', { class: 'card-text small' }, `“${x.text.slice(0, 220)}${x.text.length > 220 ? '…' : ''}”`),
          h('span', { class: 'page-ref' }, `p. ${x.page}`)),
        x.count > 1 ? h('div', { class: 'card-meta' }, `selected ${x.count} times`) : null)),
    ));
  }

  if (sum.rereads?.length) {
    root.append(h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h3', {}, 'Re-read passages'), h('span', { class: 'imp-badge high' }, 'HIGH')),
      h('p', { class: 'section-note' }, 'Lines you scrolled back up to and stayed on for at least a second.'),
      sum.rereads.slice(0, 8).map((r) => {
        const text = textInRange(s.lines.get(r.page), r.yStart - 0.02, r.yEnd + 0.02);
        return h('article', { class: 'card clickable imp-card high', tabindex: 0, onclick: () => hd.locateText(r.page, text.slice(0, 80)) },
          h('div', { class: 'card-top' }, h('p', { class: 'card-text small' }, text ? `“${text.slice(0, 200)}${text.length > 200 ? '…' : ''}”` : `${Math.round(r.yStart * 100)}–${Math.round(r.yEnd * 100)}% of the page`),
            h('span', { class: 'page-ref' }, `p. ${r.page}`)),
          r.count > 1 ? h('div', { class: 'card-meta' }, `re-read ${r.count} times`) : null);
      }),
    ));
  }

  const shown = sum.pages.filter((p) => p.dwellSeconds > 0);
  if (shown.length) {
    const max = Math.max(...shown.map((p) => p.dwellSeconds), 1);
    root.append(h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h3', {}, 'Time per page')),
      h('div', { class: 'bars' }, shown.map((p) => h('div', { class: 'bar-row' },
        h('button', { class: 'page-ref', type: 'button', onclick: () => hd.goToPage(p.page) }, `p. ${p.page}`),
        h('div', { class: 'bar', role: 'img', 'aria-label': `Page ${p.page}: ${fmtDuration(p.dwellSeconds)}, ${p.rereads ?? 0} re-reads, ${p.revisits} revisits` },
          h('span', { style: `width:${Math.max(3, (100 * p.dwellSeconds) / max)}%` })),
        h('span', { class: 'val' }, fmtDuration(p.dwellSeconds),
          p.rereads ? h('span', { class: 'rr', title: `${p.rereads} re-read(s)` }, ` ⟲${p.rereads}`) : null,
          p.revisits ? h('span', { class: 'rv', title: `${p.revisits} revisit(s)` }, ` ↺${p.revisits}`) : null),
      ))),
    ));
  }

  root.append(h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h3', {}, 'Recorded events'), h('span', { class: 'muted small' }, `${sum.eventCount} total`)),
    sum.events.length
      ? h('ul', { class: 'event-list' }, [...sum.events].reverse().slice(0, 20).map((e) => h('li', {},
        h('span', { class: 'time' }, clockTime(e.timestamp)),
        h('button', { class: 'page-ref', type: 'button', onclick: () => hd.goToPage(e.pageNumber) }, `p. ${e.pageNumber}`),
        h('span', { class: 'what', title: describeEvent(e) }, describeEvent(e)))))
      : h('p', { class: 'muted small' }, s.state === 'on' ? 'Nothing yet. Select text or read a page for a moment.' : 'No events recorded.'),
  ));

  if (!s.isDemo && s.previousSessions?.count) {
    root.append(h('p', { class: 'muted small' },
      `${s.previousSessions.count} earlier session${s.previousSessions.count > 1 ? 's' : ''} with this document stored locally (${fmtDuration(s.previousSessions.seconds)} of reading).`));
  }
}
