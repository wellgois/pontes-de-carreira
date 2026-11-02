'use strict';
/**
 * Pontes — modelo de desfecho: regressão logística online (SGD + L2).
 *
 * Aprende, a cada candidatura com resultado conhecido, quais características da vaga
 * (aderência, lacunas específicas, senioridade, fonte...) se associam a avançar para entrevista.
 * Começa de pesos a priori e vai se afastando deles conforme chegam evidências.
 */

const PRIOR = {
  __bias: -1.4, // ~20% de avanço como ponto de partida
  aderencia: 2.2,
  obrig_vermelho: -1.2,
  obrig_amarelo: -0.4,
  salario_baixo: -0.6,
  ingles_oral: -0.8,
};

const MIN_OBSERVACOES_CONFIAVEL = 10;
const MAX_FEATURES = 400;

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

class OutcomeModel {
  constructor(estado) {
    const e = estado || {};
    this.w = Object.assign({}, e.w || PRIOR);
    this.nf = Object.assign({}, e.nf || {}); // quantas vezes cada feature esteve ativa
    this.n = e.n || 0; // exemplos aprendidos
    this.positivos = e.positivos || 0;
    this.lr = e.lr || 0.15;
    this.l2 = e.l2 || 0.01;
  }

  toJSON() {
    return { w: this.w, nf: this.nf, n: this.n, positivos: this.positivos, lr: this.lr, l2: this.l2 };
  }

  /** x: { feature: valor }. */
  predict(x) {
    let z = this.w.__bias || 0;
    for (const [f, v] of Object.entries(x)) z += (this.w[f] || 0) * v;
    return sigmoid(z);
  }

  /** Um passo de SGD. Retorna a previsão ANTES da atualização (para avaliação prequential). */
  update(x, y, peso = 1) {
    const p = this.predict(x);
    const eta = Math.max(0.02, this.lr / (1 + 0.03 * this.n));
    const g = (p - y) * peso;
    this.w.__bias = (this.w.__bias || 0) - eta * g;
    for (const [f, v] of Object.entries(x)) {
      const wf = this.w[f] || 0;
      this.w[f] = wf - eta * (g * v + this.l2 * wf);
      this.nf[f] = (this.nf[f] || 0) + (v !== 0 ? 1 : 0);
    }
    this.n += 1;
    this.positivos += y ? 1 : 0;
    this._podar();
    return p;
  }

  _podar() {
    const chaves = Object.keys(this.w).filter((k) => k.startsWith('gap:') || k.startsWith('src:'));
    if (chaves.length <= MAX_FEATURES) return;
    chaves.sort((a, b) => Math.abs(this.w[a]) * Math.sqrt(this.nf[a] || 1) - Math.abs(this.w[b]) * Math.sqrt(this.nf[b] || 1));
    for (const k of chaves.slice(0, chaves.length - MAX_FEATURES)) {
      delete this.w[k];
      delete this.nf[k];
    }
  }

  /** 0 a 1: quanto o modelo já se baseia em dados reais e não no a priori. */
  confianca() {
    return this.n / (this.n + MIN_OBSERVACOES_CONFIAVEL);
  }

  modo() {
    return this.n >= MIN_OBSERVACOES_CONFIAVEL ? 'aprendido' : 'a-priori';
  }

  /** Incerteza do peso de uma feature (menos observações, mais incerteza). */
  incerteza(f) {
    return 1 / Math.sqrt(1 + (this.nf[f] || 0));
  }
}

/** Medidas prequential: cada previsão é avaliada antes de o modelo ver o resultado. */
function resumoPrequential(historico) {
  // historico: [{p, y, pBase}]
  let sm = 0;
  let sb = 0;
  const serie = [];
  historico.forEach((h, i) => {
    sm += (h.p - h.y) ** 2;
    sb += (h.pBase - h.y) ** 2;
    serie.push({ i: i + 1, modelo: sm / (i + 1), base: sb / (i + 1) });
  });
  const n = historico.length;
  return { n, brierModelo: n ? sm / n : null, brierBase: n ? sb / n : null, serie };
}

module.exports = { OutcomeModel, resumoPrequential, PRIOR, MIN_OBSERVACOES_CONFIAVEL, sigmoid };
