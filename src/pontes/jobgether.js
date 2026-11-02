'use strict';
/**
 * Pontes — Jobgether pelo feed que o próprio site libera no robots.txt para uso por IA
 * (/astroapi/ai/jobs.json). O feed traz só metadados; para as vagas que combinam com as suas buscas e são abertas
 * ao Brasil, a descrição é buscada na página da vaga (permitida pelo robots.txt), respeitando o Crawl-delay.
 */

const fontes = require('./fontes');
const paginas = require('./paginas');
const { canon } = require('./ml/text');

const FEED = 'https://jobgether.com/astroapi/ai/jobs.json';
const ABERTA_AO_BRASIL = /brazil|brasil|latam|latin america|americas|worldwide|anywhere|global/i;
const MAX_VAGAS = 40;
const MAX_DESCRICOES = 8;

const palavras = (s) => canon(s).split(/[^a-z0-9+#.]+/).filter(Boolean);

function combina(j, consultas) {
  const alvo = new Set(palavras(`${j.title} ${(j.jobFunctions || []).join(' ')}`));
  return consultas.some((q) => { const w = palavras(q); return w.length && w.every((x) => alvo.has(x)); });
}

function metadados(j) {
  return [
    `${j.title} — ${j.company}`, `Local: ${j.location || 'não informado'}`, j.remote ? `Modelo: ${j.remote}` : '', j.contractType ? `Contrato: ${j.contractType}` : '',
    j.experience ? `Experiência: ${j.experience}` : '', (j.jobFunctions || []).length ? `Funções: ${j.jobFunctions.join(', ')}` : '', j.salaryRange ? `Faixa salarial: ${j.salaryRange}` : '',
  ].filter(Boolean).join('\n');
}

async function descricao(url, atrasoMs) {
  try {
    if (!(await paginas.liberado(url))) return '';
    if (atrasoMs) await new Promise((r) => setTimeout(r, atrasoMs));
    const pag = await fontes.baixar(url);
    const { vagas } = paginas.coletar(paginas.blocosJsonLd(pag.texto));
    return vagas[0] ? paginas.limpaHtml(vagas[0].description) : '';
  } catch { return ''; }
}

/** @param {object} cfg configuração do radar (usa consultasEn e consultas como filtro de título) */
async function buscarJobgether(_q, cfg, opt = {}) {
  const feed = opt.feed || FEED;
  if (!(await paginas.liberado(feed))) throw new Error('o robots.txt do Jobgether não permite o feed');
  const r = await fontes.baixar(feed, { accept: 'application/json', maxBytes: 8 * 1024 * 1024 });
  let lista;
  try { lista = JSON.parse(r.texto).jobs; } catch { throw new Error('o feed do Jobgether não veio em JSON'); }
  if (!Array.isArray(lista)) throw new Error('formato inesperado do feed do Jobgether');

  const consultas = [...(cfg.consultasEn || []), ...(cfg.consultas || [])];
  const casadas = lista.filter((j) => j && j.title && j.url && combina(j, consultas) && ABERTA_AO_BRASIL.test(`${j.location || ''} ${j.remote || ''}`)).slice(0, MAX_VAGAS);
  const atraso = opt.pausaMs != null ? opt.pausaMs : 1000 * paginas.atrasoDeRobots(await paginas.robotsDe(new URL(feed)));
  const out = [];
  let n = 0;
  for (const j of casadas) {
    let texto = metadados(j);
    if (n < MAX_DESCRICOES) { n += 1; const d = await descricao(j.url, atraso); if (d) texto += '\n\n' + d; }
    out.push({
      fonte: 'radar:jobgether', titulo: String(j.title).slice(0, 160), empresa: String(j.company || '').trim().slice(0, 120),
      url: j.url, local: String(j.location || ''), publicadaEm: Date.parse(j.postedAt) || null, texto,
    });
  }
  return out;
}

module.exports = { buscarJobgether, combina, FEED };
