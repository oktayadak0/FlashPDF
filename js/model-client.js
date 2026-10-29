// Talks to the PiCODE backend only (same origin). The backend owns the
// model endpoint, credentials and runtime-specific API, so this module is
// independent of the model vendor.

export class ModelClientError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, { cache: 'no-store', ...options });
  } catch (e) {
    if (e.name === 'AbortError') throw new ModelClientError('cancelled', 'Request cancelled.');
    throw new ModelClientError('backend_unreachable', 'The PiCODE backend is not reachable. Is the server running?');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ModelClientError(body.error || `http_${res.status}`, body.message || `Request failed (HTTP ${res.status}).`);
  }
  return res;
}

export async function getStatus() { return (await request('/api/status')).json(); }
export async function getConfig() { return (await request('/api/config')).json(); }
export async function saveConfig(cfg) {
  return (await request('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
  })).json();
}

/**
 * Runs one analysis task. The backend streams NDJSON events:
 *   {type:"status", phase}, {type:"progress", chunks}, {type:"result", analysis, meta}, {type:"error", code, message}
 * @param {'session'|'summary'|'notes'|'questions'} task
 * @param {object} context   package from context-builder.js
 * @param {{onEvent?: Function, signal?: AbortSignal, allowRemote?: boolean}} opts
 * @returns {Promise<{analysis: object, meta: object}>} raw (not yet grounded) model output
 */
export async function runTask(task, context, { onEvent, signal, allowRemote = false } = {}) {
  const res = await request('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: { ...context, task }, allowRemote }),
    signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  const handle = (line) => {
    if (!line.trim()) return;
    let evt;
    try { evt = JSON.parse(line); } catch { return; }
    onEvent?.(evt);
    if (evt.type === 'error') throw new ModelClientError(evt.code, evt.message, evt.details);
    if (evt.type === 'result') result = evt;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        handle(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    handle(buffer);
  } catch (e) {
    if (e instanceof ModelClientError) throw e;
    if (e.name === 'AbortError') throw new ModelClientError('cancelled', 'Analysis cancelled.');
    throw new ModelClientError('stream_failed', 'The connection to the backend was interrupted.');
  }
  if (!result) throw new ModelClientError('incomplete', 'The analysis ended without a result.');
  return { analysis: result.analysis, meta: result.meta };
}

export const analyzeReadingSession = (ctx, opts) => runTask('session', ctx, opts);
export const generateDocumentSummary = (ctx, opts) => runTask('summary', ctx, opts);
export const generatePersonalizedNotes = (ctx, opts) => runTask('notes', ctx, opts);
export const generateStudyQuestions = (ctx, opts) => runTask('questions', ctx, opts);
