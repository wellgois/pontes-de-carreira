'use strict';
/**
 * Pontes — casamento requisito x evidência, local e barato.
 *
 * Pontuação = similaridade TF-IDF (documento inteiro ou trecho da habilidade) + ajuste aprendido.
 * Ajustes aprendem com a confirmação/rejeição do usuário e valem também para requisitos de nome parecido.
 */

const { canon, Tfidf, cosine } = require('./text');

const LIMIAR_SUGESTAO = 0.5; // acima disso o sistema sugere "provável" (nunca marca verde sozinho)
const AJUSTE_MAX = 0.6;
const PASSO_CONFIRMA = 0.25;
const PASSO_REJEITA = 0.35;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function segmentos(skill) {
  return String(skill || '')
    .split(/[,;/|]| e | and /i)
    .map((s) => s.trim())
    .filter(Boolean);
}

class Matcher {
  /**
   * @param {{id:any, skill:string, prova?:string}[]} evidencias
   * @param {Record<string, number>} ajustes chave "nome_canonico|idEvidencia" -> delta aprendido
   * @param {string[]} corpusExtra textos de requisitos já vistos (melhora o IDF)
   */
  constructor(evidencias, ajustes = {}, corpusExtra = []) {
    this.ev = evidencias;
    this.ajustes = ajustes;
    const docs = evidencias.map((e) => `${e.skill} ${e.skill} ${e.prova || ''}`);
    const segs = evidencias.map((e) => segmentos(e.skill));
    this.tfidf = new Tfidf([...docs, ...segs.flat(), ...corpusExtra]);
    this.docVec = docs.map((d) => this.tfidf.vec(d));
    this.segVec = segs.map((list) => list.map((s) => this.tfidf.vec(s)));
  }

  _ajuste(chave, id) {
    let total = this.ajustes[`${chave}|${id}`] || 0;
    const sufixo = `|${id}`;
    const v = this.tfidf.vec(chave);
    for (const k of Object.keys(this.ajustes)) {
      if (!k.endsWith(sufixo)) continue;
      const nome = k.slice(0, -sufixo.length);
      if (nome === chave) continue;
      const sim = cosine(v, this.tfidf.vec(nome));
      if (sim >= 0.8) total += 0.5 * sim * this.ajustes[k];
    }
    return clamp(total, -AJUSTE_MAX, AJUSTE_MAX);
  }

  /** Evidências ordenadas por pontuação para um requisito. */
  rank(nomeRequisito) {
    const chave = canon(nomeRequisito);
    const v = this.tfidf.vec(nomeRequisito);
    return this.ev
      .map((e, i) => {
        const doc = cosine(v, this.docVec[i]) * 0.9;
        const seg = this.segVec[i].reduce((m, sv) => Math.max(m, cosine(v, sv)), 0);
        const base = Math.max(doc, seg);
        const ajuste = this._ajuste(chave, e.id);
        return { id: e.id, skill: e.skill, base, ajuste, score: clamp(base + ajuste, 0, 1) };
      })
      .sort((a, b) => b.score - a.score);
  }

  /** Melhor evidência acima do limiar, ou null. */
  melhor(nomeRequisito, limiar = LIMIAR_SUGESTAO) {
    const r = this.rank(nomeRequisito)[0];
    return r && r.score >= limiar ? r : null;
  }
}

/** Novo valor de ajuste após o usuário confirmar ou rejeitar um par. */
function aprender(ajustes, nomeRequisito, idEvidencia, confirmado) {
  const chave = `${canon(nomeRequisito)}|${idEvidencia}`;
  const atual = ajustes[chave] || 0;
  const novo = clamp(atual + (confirmado ? PASSO_CONFIRMA : -PASSO_REJEITA), -AJUSTE_MAX, AJUSTE_MAX);
  return { chave, valor: novo };
}

module.exports = { Matcher, aprender, LIMIAR_SUGESTAO };
