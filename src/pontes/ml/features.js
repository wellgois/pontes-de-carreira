'use strict';
/**
 * Pontes — placar de aderência e vetor de características de uma vaga.
 */

const { canon } = require('./text');

const NAO_RUIDO = (r) => r.tipo !== 'ruido';
const PESO_STATUS = { verde: 1, amarelo: 0.5, vermelho: 0 };

/** Aderência 0–100. Obrigatórios pesam 3, desejáveis 1, ruído não conta. `fechar` = chaves tratadas como provadas. */
function aderencia(vaga, fechar = null) {
  const rs = (vaga.requisitos || []).filter(NAO_RUIDO);
  if (!rs.length) return null;
  let num = 0;
  let den = 0;
  for (const r of rs) {
    const w = r.tipo === 'obrigatorio' ? 3 : 1;
    const st = fechar && fechar.has(canon(r.nome)) ? 'verde' : r.status;
    den += w;
    num += w * (PESO_STATUS[st] != null ? PESO_STATUS[st] : 0);
  }
  return den ? (num / den) * 100 : null;
}

function contagem(vaga) {
  const c = { verde: 0, amarelo: 0, vermelho: 0 };
  for (const r of (vaga.requisitos || []).filter(NAO_RUIDO)) if (c[r.status] != null) c[r.status] += 1;
  return c;
}

function senioridade(titulo) {
  const t = canon(titulo);
  if (/\b(lead|staff|principal|especialista|coordenador)\b/.test(t)) return 'lead';
  if (/\b(senior|sr)\b/.test(t)) return 'sr';
  if (/\b(pleno|pl|mid)\b/.test(t)) return 'pl';
  if (/\b(junior|jr|estagio|trainee)\b/.test(t)) return 'jr';
  return null;
}

function remoto(texto) {
  return /\b(remot[oa]|home ?office|anywhere|100% remote)\b/i.test(texto || '');
}

/** Vetor esparso de características. `fechar` permite perguntar "e se eu fechasse esta lacuna?". */
function featuresDe(vaga, fechar = null) {
  const rs = (vaga.requisitos || []).filter(NAO_RUIDO);
  const todos = vaga.requisitos || [];
  const obrig = rs.filter((r) => r.tipo === 'obrigatorio');
  const st = (r) => (fechar && fechar.has(canon(r.nome)) ? 'verde' : r.status);
  const x = {};
  const ad = aderencia(vaga, fechar);
  x.aderencia = ad == null ? 0 : ad / 100;
  if (obrig.length) {
    x.obrig_vermelho = obrig.filter((r) => st(r) === 'vermelho').length / obrig.length;
    x.obrig_amarelo = obrig.filter((r) => st(r) === 'amarelo').length / obrig.length;
  }
  x.n_req = Math.min(rs.length, 20) / 20;
  if (todos.length) x.ruido = (todos.length - rs.length) / todos.length;
  if ((vaga.sinaisRisco || []).some((s) => /sal[aá]rio|faixa/i.test(s))) x.salario_baixo = 1;
  const ingOral = rs.some((r) => {
    const c = canon(r.nome);
    return c.includes('ingles') && /(oral|speaking|conversa|fluen)/.test(c) && st(r) !== 'verde';
  });
  if (ingOral) x.ingles_oral = 1;
  const sen = senioridade(vaga.titulo);
  if (sen) x['sen:' + sen] = 1;
  if (vaga.fonte) x['src:' + canon(vaga.fonte).slice(0, 30)] = 1;
  if (remoto(vaga.texto)) x.remoto = 1;
  for (const r of rs) {
    if (st(r) === 'verde') continue;
    x['gap:' + canon(r.nome)] = r.tipo === 'obrigatorio' ? 1 : 0.5;
  }
  return x;
}

module.exports = { aderencia, contagem, featuresDe, senioridade };
