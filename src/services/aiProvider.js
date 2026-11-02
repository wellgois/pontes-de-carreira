'use strict';
/**
 * Provedores de IA por variável de ambiente. Anthropic e APIs compatíveis com OpenAI.
 * Ordem de prioridade: AI_PRIORITY (ex.: "anthropic,openai,deepseek") ou a ordem padrão abaixo.
 */
const providers = {
  anthropic: { endpoint: 'https://api.anthropic.com/v1/messages', model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514' },
  openai: { endpoint: 'https://api.openai.com/v1/chat/completions', model: process.env.OPENAI_MODEL || 'gpt-4o' },
  deepseek: { endpoint: 'https://api.deepseek.com/v1/chat/completions', model: process.env.DEEPSEEK_MODEL || 'deepseek-chat' },
};

const getApiKey = (p) => process.env[`${p.toUpperCase()}_API_KEY`] || '';

function getPriorityOrder() {
  const ordem = (process.env.AI_PRIORITY || 'anthropic,openai,deepseek').split(',').map((s) => s.trim()).filter(Boolean);
  return ordem.filter((p) => providers[p] && getApiKey(p));
}

module.exports = { providers, getApiKey, getPriorityOrder };
