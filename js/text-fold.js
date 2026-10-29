// Length-preserving, language-tolerant text folding used for search,
// highlighting and quote matching.
//
// Why: "İ".toLowerCase() is two characters in JavaScript ("i" + combining
// dot), which breaks index-based matching, and models sometimes drop or add
// Turkish diacritics. foldChar maps every character to exactly one character:
// lowercase, diacritics removed (ğ→g, ş→s, ç→c, ö→o, ü→u, â→a) and ı/İ/I→i.

const cache = new Map();

export function foldChar(c) {
  let f = cache.get(c);
  if (f === undefined) {
    f = c.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    f = f === 'ı' ? 'i' : (f[0] ?? c);
    cache.set(c, f);
  }
  return f;
}

/** Folds a string; the result has the same length (in UTF-16 code units for BMP text). */
export function foldText(s) {
  let out = '';
  for (const c of String(s ?? '')) out += foldChar(c);
  return out;
}

/** Guesses the document language from its text. Only distinguishes Turkish from "other". */
export function detectLanguage(text) {
  const t = String(text ?? '').slice(0, 20000);
  const tr = (t.match(/[ğşıİĞŞ]/g) ?? []).length;
  const words = (t.match(/(?<![\p{L}])(ve|bir|bu|için|ile|olarak|daha|çok|değil)(?![\p{L}])/giu) ?? []).length;
  return tr >= 5 || words >= 15 ? 'tr' : 'en';
}
