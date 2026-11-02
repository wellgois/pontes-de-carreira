'use strict';
/**
 * Pontes — leitura do mercado: demanda com decaimento temporal, tendência e prioridade de lacunas.
 * A prioridade combina demanda recente, impacto aprendido nos desfechos e esforço da ponte,
 * com amostragem de Thompson opcional para continuar testando lacunas ainda pouco observadas.
 */

const { canon } = require('./text');

const DIA = 86400000;
const MEIA_VIDA_DIAS = 45;

const peso = (idadeDias, meiaVida = MEIA_VIDA_DIAS) => Math.pow(0.5, Math.max(0, idadeDias) / meiaVida);
const tipoPeso = (tipo) => (tipo === 'obrigatorio' ? 3 : 1);

/** Gerador pseudoaleatório com semente (testes reproduzíveis). */
function rngSemente(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng) {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * @param vagas [{criadoEm:number, status, requisitos:[{nome,tipo,status,ponte?}]}] (já filtradas: analisadas, não descartadas)
 */
function demanda(vagas, agora = Date.now(), meiaVida = MEIA_VIDA_DIAS) {
  const itens = new Map();
  let total = 0;
  let totalRecente = 0;
  let totalAntigo = 0;
  for (const v of vagas) {
    const idade = (agora - (v.criadoEm || agora)) / DIA;
    const w = peso(idade, meiaVida);
    const recente = idade <= 30;
    total += w;
    if (recente) totalRecente += 1;
    else totalAntigo += 1;
    const vistos = new Set();
    for (const r of v.requisitos || []) {
      if (r.tipo === 'ruido') continue;
      const k = canon(r.nome);
      if (!k || vistos.has(k)) continue;
      vistos.add(k);
      const it = itens.get(k) || { chave: k, nome: r.nome, peso: 0, pesoGap: 0, obrig: 0, n: 0, nGap: 0, rec: 0, ant: 0, ponte: null };
      const tw = tipoPeso(r.tipo);
      it.peso += w * tw;
      it.n += 1;
      if (r.tipo === 'obrigatorio') it.obrig += 1;
      if (recente) it.rec += 1;
      else it.ant += 1;
      if (r.status !== 'verde') {
        it.pesoGap += w * tw;
        it.nGap += 1;
        if (!it.ponte && r.ponte && r.ponte.projeto) it.ponte = r.ponte;
      }
      itens.set(k, it);
    }
  }
  for (const it of itens.values()) {
    // Tendência: diferença de participação entre vagas recentes (≤30 dias) e antigas; só com amostra mínima.
    it.tendencia = totalRecente >= 3 && totalAntigo >= 3 ? it.rec / totalRecente - it.ant / totalAntigo : null;
  }
  return { itens: [...itens.values()], total, totalRecente, totalAntigo };
}

/**
 * Ordena as lacunas pelo que mais vale fechar agora.
 * @param modelo OutcomeModel (pesos 'gap:<chave>')
 */
function prioridades(vagas, modelo, { agora = Date.now(), explorar = false, rng = Math.random } = {}) {
  const d = demanda(vagas, agora);
  if (!d.total) return [];
  const lista = [];
  for (const it of d.itens) {
    if (!it.nGap) continue;
    const f = `gap:${it.chave}`;
    const wf = modelo.w[f] || 0;
    const impacto = Math.max(0, -wf); // peso negativo = a lacuna reduz a chance de avançar
    const inc = modelo.incerteza(f);
    const amostra = explorar ? Math.max(0, impacto + gauss(rng) * inc * 0.5) : impacto;
    const fracaoGap = it.pesoGap / (d.total * 3);
    const horas = (it.ponte && it.ponte.horas) || 20;
    const facilidade = 1 / Math.sqrt(Math.max(4, horas) / 8);
    const alta = it.tendencia != null ? Math.max(0, it.tendencia) : 0;
    const score = fracaoGap * (1 + 2 * amostra) * facilidade * (1 + 2 * alta);
    lista.push({
      chave: it.chave,
      nome: it.nome,
      score,
      demanda: it.nGap / vagas.length,
      obrigatorio: it.obrig,
      impactoAprendido: impacto,
      observacoes: modelo.nf[f] || 0,
      tendencia: it.tendencia,
      horas,
      ponte: it.ponte,
    });
  }
  return lista.sort((a, b) => b.score - a.score);
}

module.exports = { demanda, prioridades, peso, rngSemente, gauss, MEIA_VIDA_DIAS };
