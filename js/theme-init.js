// Apply the saved theme before first paint. localStorage holds only this UI preference.
// (The key used before the rename to PiCODE is read once and migrated.)
try {
  let t = localStorage.getItem('picode-theme');
  const legacy = localStorage.getItem('fn-theme');
  if (!t && legacy) { t = legacy; localStorage.setItem('picode-theme', legacy); }
  if (legacy) localStorage.removeItem('fn-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch { /* storage unavailable: follow the system theme */ }
