'use strict';
/**
 * Pontes — texto: normalização, tokens e TF-IDF com n-gramas de caracteres.
 * Sem dependências externas.
 */

const STOP = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'as', 'os', 'em', 'no', 'na', 'com', 'para', 'por', 'um', 'uma', 'ou',
  'the', 'of', 'and', 'in', 'to', 'with', 'for', 'or', 'an', 'experiencia', 'experience', 'conhecimento', 'knowledge',
  'avancado', 'advanced', 'basico', 'basic', 'solido', 'forte', 'strong', 'skills', 'habilidades', 'nivel', 'level',
]);

function strip(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Nome canônico para chaves: minúsculo, sem acento, espaços colapsados. */
function canon(s) {
  return strip(s).replace(/\s+/g, ' ').trim();
}

function tokens(s) {
  return strip(s)
    .replace(/[^a-z0-9+#.\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length > 0 && !STOP.has(t));
}

/** Mapa termo -> peso. Palavras valem 1; trigramas de caracteres valem 0,35 (tolerância a variações). */
function termCounts(s) {
  const m = new Map();
  const add = (k, w) => m.set(k, (m.get(k) || 0) + w);
  for (const t of tokens(s)) {
    add('w:' + t, 1);
    if (t.length >= 4) for (let i = 0; i + 3 <= t.length; i++) add('c:' + t.slice(i, i + 3), 0.35);
  }
  return m;
}

class Tfidf {
  constructor(corpus) {
    this.n = corpus.length;
    this.df = new Map();
    for (const doc of corpus) {
      for (const k of termCounts(doc).keys()) this.df.set(k, (this.df.get(k) || 0) + 1);
    }
  }

  idf(k) {
    return Math.log((this.n + 1) / ((this.df.get(k) || 0) + 1)) + 1;
  }

  vec(text) {
    const out = new Map();
    let norm = 0;
    for (const [k, c] of termCounts(text)) {
      const v = (1 + Math.log(c + 1)) * this.idf(k);
      out.set(k, v);
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [k, v] of out) out.set(k, v / norm);
    return out;
  }
}

function cosine(a, b) {
  if (a.size > b.size) [a, b] = [b, a];
  let s = 0;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w) s += v * w;
  }
  return s;
}

module.exports = { strip, canon, tokens, termCounts, Tfidf, cosine };
