'use strict';
/**
 * Pontes — chamada não-streaming a LLM, usando as chaves das variáveis de ambiente (ver src/services/aiProvider.js).
 * Suporta Anthropic e provedores compatíveis com OpenAI; cai para o próximo se um falhar.
 */

const axios = require('axios');

function provedores() {
  const ai = require('../services/aiProvider');
  return { ai, ordem: ai.getPriorityOrder().filter((p) => p !== 'google') };
}

async function chamar({ system, user, maxTokens = 3500, timeout = 120000 }) {
  const { ai, ordem } = provedores();
  if (!ordem.length) {
    const e = new Error('Nenhum provedor de IA configurado. Adicione uma chave em Configurações.');
    e.status = 503;
    throw e;
  }
  let ultimo = null;
  for (const nome of ordem) {
    const cfg = ai.providers[nome];
    const chave = ai.getApiKey(nome);
    if (!cfg || !chave) continue;
    try {
      if (nome === 'anthropic') {
        const r = await axios.post(cfg.endpoint, {
          model: cfg.model, max_tokens: maxTokens, system,
          messages: [{ role: 'user', content: user }],
        }, { headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout });
        const texto = (r.data.content || []).map((b) => b.text || '').join('');
        if (texto.trim()) return texto;
      } else {
        const r = await axios.post(cfg.endpoint, {
          model: cfg.model, max_tokens: maxTokens,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }, { headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' }, timeout });
        const texto = r.data.choices?.[0]?.message?.content || '';
        if (texto.trim()) return texto;
      }
    } catch (err) {
      ultimo = err;
      console.error(`[PONTES] ${nome} falhou:`, err.message);
    }
  }
  const e = new Error('Todos os provedores de IA falharam' + (ultimo ? `: ${ultimo.message}` : '.'));
  e.status = 502;
  throw e;
}

/**
 * Recupera um JSON cortado (resposta que bateu no limite de tamanho): volta ao último ponto em que um objeto ou
 * lista foi fechado por inteiro e completa os fechamentos. O item cortado ao meio é descartado.
 */
function repararJson(t) {
  const ini = t.indexOf('{');
  if (ini < 0) return null;
  const s = t.slice(ini);
  const pilha = [];
  let emStr = false, esc = false, ultimo = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (emStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') emStr = false; continue; }
    if (c === '"') emStr = true;
    else if (c === '{' || c === '[') pilha.push(c);
    else if (c === '}' || c === ']') { pilha.pop(); ultimo = { i, pilha: pilha.slice() }; }
  }
  if (!ultimo) return null;
  const fecha = ultimo.pilha.reverse().map((c) => (c === '{' ? '}' : ']')).join('');
  return s.slice(0, ultimo.i + 1) + fecha;
}

/** Extrai o primeiro objeto JSON de uma resposta, tolerando cercas de código, texto ao redor e resposta cortada. */
function extrairJson(texto) {
  const t = String(texto || '');
  const cerca = t.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
  const candidato = cerca ? cerca[1] : t;
  const ini = candidato.indexOf('{');
  const fim = candidato.lastIndexOf('}');
  if (ini < 0 || fim <= ini) throw new Error('A IA não devolveu JSON.');
  try {
    return JSON.parse(candidato.slice(ini, fim + 1));
  } catch (e) {
    const r = repararJson(candidato);
    if (r) { try { return JSON.parse(r); } catch (e2) { /* cai no erro abaixo */ } }
    throw e;
  }
}

module.exports = { chamar, extrairJson, repararJson };
