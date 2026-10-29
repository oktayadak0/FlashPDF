// Local persistence in IndexedDB (this browser only). Falls back to an
// in-memory store if IndexedDB is unavailable, and reports that to the UI.
//
// Stores:
//   settings  { key, value }
//   documents { docId, title, name, pageCount, lastOpened }
//   sessions  { id, docId, startedAt, endedAt, aggregate }   aggregate = ReadingAggregator#toJSON()
//   notes     { id, docId, page, text, quote, source, edited, origin, createdAt, updatedAt }
//   analyses  { docId, data, meta, updatedAt }

const STORES = {
  settings: { keyPath: 'key' },
  documents: { keyPath: 'docId' },
  sessions: { keyPath: 'id', index: 'docId' },
  notes: { keyPath: 'id', index: 'docId' },
  analyses: { keyPath: 'docId' },
};

export const NOTE_SOURCES = ['ai', 'manual', 'demo'];

const reqP = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const OPEN_TIMEOUT_MS = 4000;      // opening our own database
export const MIGRATE_TIMEOUT_MS = 2500;   // the one-time move from the pre-rename database

/** Rejects if `promise` has not settled within `ms` (IndexedDB requests can wait forever behind another tab). */
function withTimeout(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000} s`)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function openDb(name) {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) { reject(new Error('IndexedDB not supported')); return; }
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [store, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(store)) continue;
        const os = db.createObjectStore(store, { keyPath: def.keyPath });
        if (def.index) os.createIndex(def.index, def.index);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab wants to delete or upgrade this database: step aside instead of blocking it.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database upgrade blocked by another tab'));
  });
}

/** Database name used before the app was renamed to PiCODE. */
export const LEGACY_DB_NAME = 'focusnote';

/**
 * One-time move of data from the pre-rename database into `target`.
 * Rows whose key already exists in `target` are kept as they are. Returns the number of rows copied.
 */
async function migrateLegacy(target, legacyName) {
  if (typeof indexedDB.databases !== 'function') return 0;
  const existing = await indexedDB.databases();
  if (!existing.some((d) => d.name === legacyName)) return 0;
  const legacy = await openDb(legacyName);
  let copied = 0;
  try {
    for (const store of Object.keys(STORES)) {
      if (!legacy.objectStoreNames.contains(store)) continue;
      const rows = await reqP(legacy.transaction(store, 'readonly').objectStore(store).getAll());
      if (!rows.length) continue;
      const keyPath = STORES[store].keyPath;
      const have = new Set(await reqP(target.transaction(store, 'readonly').objectStore(store).getAllKeys()));
      const tx = target.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      for (const row of rows) if (!have.has(row[keyPath])) { os.put(row); copied++; }
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    }
  } finally {
    legacy.close();
  }
  indexedDB.deleteDatabase(legacyName);   // not awaited: another open tab may block it until closed
  return copied;
}

class MemoryBackend {
  constructor() { this.data = Object.fromEntries(Object.keys(STORES).map((s) => [s, new Map()])); }
  async get(store, key) { return structuredClone(this.data[store].get(key)); }
  async put(store, value) { this.data[store].set(value[STORES[store].keyPath], structuredClone(value)); }
  async delete(store, key) { this.data[store].delete(key); }
  async byIndex(store, index, value) { return [...this.data[store].values()].filter((v) => v[index] === value).map((v) => structuredClone(v)); }
  async clear(store) { this.data[store].clear(); }
}

class IdbBackend {
  constructor(db) { this.db = db; }
  _store(store, mode) { return this.db.transaction(store, mode).objectStore(store); }
  get(store, key) { return reqP(this._store(store, 'readonly').get(key)); }
  put(store, value) { return reqP(this._store(store, 'readwrite').put(value)); }
  delete(store, key) { return reqP(this._store(store, 'readwrite').delete(key)); }
  byIndex(store, index, value) { return reqP(this._store(store, 'readonly').index(index).getAll(value)); }
  clear(store) { return reqP(this._store(store, 'readwrite').clear()); }
}

export class Store {
  constructor(name = 'picode', { migrateFrom = name === 'picode' ? LEGACY_DB_NAME : null } = {}) {
    this.name = name;
    this.migrateFrom = migrateFrom;
    this.migratedRows = 0;
    this.backend = null;
    this.persistent = false;
    this.error = null;
  }

  async open() {
    try {
      const db = await withTimeout(openDb(this.name), OPEN_TIMEOUT_MS, 'Opening local storage');
      this.backend = new IdbBackend(db);
      this.persistent = true;
      if (this.migrateFrom) {
        // Never let the one-time move hold up the app: an old tab can keep the old database
        // busy indefinitely. If it times out, it is simply tried again on the next start.
        try { this.migratedRows = await withTimeout(migrateLegacy(db, this.migrateFrom), MIGRATE_TIMEOUT_MS, 'Moving data from FocusNote'); }
        catch (e) { this.migrationError = e; console.warn('Could not migrate data from the previous database', e); }
      }
    } catch (e) {
      this.backend = new MemoryBackend();
      this.persistent = false;
      this.error = e;
    }
    return this;
  }

  close() { this.backend?.db?.close(); }

  // settings
  async getSetting(key, fallback = null) { const r = await this.backend.get('settings', key); return r ? r.value : fallback; }
  setSetting(key, value) { return this.backend.put('settings', { key, value }); }

  // documents
  getDocument(docId) { return this.backend.get('documents', docId); }
  saveDocument(doc) { return this.backend.put('documents', { ...doc, lastOpened: new Date().toISOString() }); }

  // sessions
  saveSession(session) { return this.backend.put('sessions', session); }
  async listSessions(docId) {
    return (await this.backend.byIndex('sessions', 'docId', docId)).sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  }
  deleteSession(id) { return this.backend.delete('sessions', id); }

  // notes
  async listNotes(docId) {
    return (await this.backend.byIndex('notes', 'docId', docId)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
  async saveNote(note) {
    const errs = validateNote(note);
    if (errs.length) throw new Error(`Invalid note: ${errs.join('; ')}`);
    const saved = { ...note, updatedAt: new Date().toISOString() };
    await this.backend.put('notes', saved);
    return saved;
  }
  deleteNote(id) { return this.backend.delete('notes', id); }

  // analyses (latest per document)
  getAnalysis(docId) { return this.backend.get('analyses', docId); }
  saveAnalysis(docId, data, meta) { return this.backend.put('analyses', { docId, data, meta, updatedAt: new Date().toISOString() }); }

  /** Removes everything PiCODE stored about one document. */
  async deleteDocumentData(docId) {
    for (const s of await this.backend.byIndex('sessions', 'docId', docId)) await this.backend.delete('sessions', s.id);
    for (const n of await this.backend.byIndex('notes', 'docId', docId)) await this.backend.delete('notes', n.id);
    await this.backend.delete('analyses', docId);
    await this.backend.delete('documents', docId);
  }

  /** Removes all PiCODE data in this browser, including consent and settings. */
  async deleteAll() {
    for (const store of Object.keys(STORES)) await this.backend.clear(store);
  }
}

export function createNote({ docId, text, page = null, quote = '', source = 'manual', origin = null }) {
  const now = new Date().toISOString();
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `n-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    docId, page, text: String(text ?? '').trim(), quote: String(quote ?? '').trim(),
    source, edited: false, origin, createdAt: now, updatedAt: now,
  };
}

export function validateNote(n) {
  const errs = [];
  if (!n || typeof n !== 'object') return ['not an object'];
  if (typeof n.id !== 'string' || !n.id) errs.push('id required');
  if (typeof n.docId !== 'string' || !n.docId) errs.push('docId required');
  if (typeof n.text !== 'string' || !n.text.trim()) errs.push('text required');
  if (n.page != null && !(Number.isInteger(n.page) && n.page >= 1)) errs.push('page must be a positive integer or null');
  if (!NOTE_SOURCES.includes(n.source)) errs.push(`source must be one of ${NOTE_SOURCES.join(', ')}`);
  return errs;
}
