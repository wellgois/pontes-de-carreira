'use strict';
/**
 * Pontes — leitura de páginas de busca de outros sites de vagas (Jobgether, BeBee e semelhantes).
 *
 * Você cola o endereço da página de resultados; o radar lê as vagas pelos dados estruturados `JobPosting`
 * (JSON-LD), o padrão que os sites publicam para o Google. Não há leitor específico por site: se o site não
 * publicar esses dados, a tela mostra o motivo.
 *
 * Conduta: respeita o robots.txt de cada site, identifica-se no User-Agent, faz poucas requisições por dia
 * (1 página de busca + no máximo 15 anúncios) com pausa entre elas, e nunca acessa endereços da rede interna.
 */

const axios = require('axios');
const fontes = require('./fontes');

const UA = 'Pontes-de-Carreira/1.0 (+uso pessoal; respeita robots.txt)';
const MAX_DETALHES = 15;
const MAX_VAGAS = 30;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const limpaHtml = (s) => String(s || '')
  .replace(/<(br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

/* ---------- robots.txt ---------- */
function parseRobots(texto) {
  const grupos = [];
  let atual = null;
  let lendoAgentes = false;
  for (const bruta of String(texto || '').split(/\r?\n/)) {
    const linha = bruta.replace(/#.*/, '').trim();
    const m = linha.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') {
      if (!lendoAgentes || !atual) { atual = { agentes: [], regras: [] }; grupos.push(atual); }
      atual.agentes.push(v.toLowerCase());
      lendoAgentes = true;
    } else if (k === 'crawl-delay' && atual) {
      lendoAgentes = false;
      const n = Number.parseFloat(v);
      if (Number.isFinite(n) && n > 0) atual.atraso = Math.min(n, 30);
    } else if ((k === 'allow' || k === 'disallow') && atual) {
      lendoAgentes = false;
      if (v) atual.regras.push({ permite: k === 'allow', caminho: v });
    } else lendoAgentes = false;
  }
  return grupos;
}

function casa(caminho, padrao) {
  const re = '^' + padrao.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
  return new RegExp(re).test(caminho);
}

/** Regra mais específica (maior padrão) vence; empate favorece "Allow". */
function permitidoPorRobots(grupos, caminho) {
  const meu = grupos.filter((g) => g.agentes.some((a) => a !== '*' && UA.toLowerCase().includes(a)));
  const todos = grupos.filter((g) => g.agentes.includes('*'));
  const regras = (meu.length ? meu : todos).flatMap((g) => g.regras);
  let melhor = null;
  for (const r of regras) {
    if (!casa(caminho, r.caminho)) continue;
    if (!melhor || r.caminho.length > melhor.caminho.length || (r.caminho.length === melhor.caminho.length && r.permite)) melhor = r;
  }
  return melhor ? melhor.permite : true;
}

/** Crawl-delay do grupo que vale para o app (em segundos; 0 se não houver). */
function atrasoDeRobots(grupos) {
  const meu = grupos.filter((g) => g.agentes.some((a) => a !== '*' && UA.toLowerCase().includes(a)));
  const grupo = (meu.length ? meu : grupos.filter((g) => g.agentes.includes('*')))[0];
  return (grupo && grupo.atraso) || 0;
}

const cacheRobots = new Map();

async function robotsDe(url) {
  const origem = url.origin;
  if (cacheRobots.has(origem)) return cacheRobots.get(origem);
  await fontes.validarDestino(origem + '/robots.txt');
  let grupos = [];
  try {
    const r = await axios.get(origem + '/robots.txt', { timeout: 10000, maxRedirects: 3, responseType: 'text', validateStatus: (s) => s < 500, headers: { 'User-Agent': UA }, transformResponse: (x) => x });
    if (r.status === 200) grupos = parseRobots(String(r.data));
  } catch (e) {
    throw new Error(`Não consegui ler o robots.txt de ${url.hostname}: ${e.message}`);
  }
  cacheRobots.set(origem, grupos);
  setTimeout(() => cacheRobots.delete(origem), 10 * 60 * 1000).unref();
  return grupos;
}

async function liberado(u) {
  const url = new URL(u);
  return permitidoPorRobots(await robotsDe(url), url.pathname + url.search);
}

/* ---------- JSON-LD ---------- */
function blocosJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1].trim())); } catch { /* bloco inválido: ignora */ }
  }
  return out;
}

const tipos = (n) => [].concat(n && n['@type'] ? n['@type'] : []).map(String);

/** Percorre o JSON-LD coletando JobPosting e endereços de itens de listas (ItemList). */
function coletar(nos) {
  const vagas = [];
  const links = [];
  const ande = (n, prof) => {
    if (!n || typeof n !== 'object' || prof > 8) return;
    if (Array.isArray(n)) { n.forEach((x) => ande(x, prof + 1)); return; }
    const t = tipos(n);
    if (t.includes('JobPosting')) { vagas.push(n); return; }
    if (t.includes('ItemList') && Array.isArray(n.itemListElement)) {
      for (const el of n.itemListElement) {
        const item = el && (el.item || el);
        if (item && typeof item === 'object' && tipos(item).includes('JobPosting')) vagas.push(item);
        else { const u = (item && (item.url || item['@id'])) || (el && el.url); if (typeof u === 'string') links.push(u); }
      }
      return;
    }
    Object.values(n).forEach((x) => ande(x, prof + 1));
  };
  ande(nos, 0);
  return { vagas, links };
}

const nomeDe = (o) => (typeof o === 'string' ? o : (o && o.name) || '');

function mapear(j, paginaUrl, fonte) {
  const locais = [].concat(j.jobLocation || []).map((l) => {
    const a = (l && l.address) || {};
    return [a.addressLocality, a.addressRegion, typeof a.addressCountry === 'string' ? a.addressCountry : nomeDe(a.addressCountry)].filter(Boolean).join(' - ');
  }).filter(Boolean);
  const restricao = [].concat(j.applicantLocationRequirements || []).map(nomeDe).filter(Boolean).join(', ');
  const remoto = String(j.jobLocationType || '').toUpperCase() === 'TELECOMMUTE';
  const local = [locais.join(' / '), remoto ? 'remoto' : '', restricao ? `candidatos de: ${restricao}` : ''].filter(Boolean).join(' · ');
  const validade = Date.parse(j.validThrough);
  if (validade && validade < Date.now()) return null;
  const titulo = limpaHtml(j.title).slice(0, 160);
  if (!titulo) return null;
  return {
    fonte, titulo, empresa: nomeDe(j.hiringOrganization).slice(0, 120),
    url: typeof j.url === 'string' && /^https?:\/\//i.test(j.url) ? j.url : paginaUrl,
    local, restricaoLocal: restricao, publicadaEm: Date.parse(j.datePosted) || null,
    texto: limpaHtml(j.description) + (j.baseSalary && j.baseSalary.value ? '\nSalário informado no anúncio.' : ''),
  };
}

const rotuloDe = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').split('.').slice(-3).filter((p) => !['br', 'com', 'co', 'io'].includes(p)).pop() || new URL(u).hostname; } catch { return 'site'; } };

/**
 * @param {string} u página de resultados de busca
 * @param {{pausaMs?:number}} opt
 */
async function buscarPagina(u, opt = {}) {
  const pausa = opt.pausaMs == null ? 1200 : opt.pausaMs;
  const maxDetalhes = opt.maxDetalhes || MAX_DETALHES;
  const fonte = 'radar:' + rotuloDe(u);
  if (!(await liberado(u))) throw new Error('o robots.txt do site não permite ler esta página');
  const atraso = Math.max(pausa, 1000 * atrasoDeRobots(await robotsDe(new URL(u))));
  const pag = await fontes.baixar(u);
  const { vagas: diretas, links } = coletar(blocosJsonLd(pag.texto));
  let achadas = diretas.map((j) => mapear(j, u, fonte)).filter(Boolean);

  if (!achadas.length) {
    // Página de listagem sem dados completos: abre alguns anúncios (mesmo site) e lê o JobPosting de cada um.
    const base = new URL(u);
    const candidatos = new Set(links.map((l) => { try { return new URL(l, base).toString(); } catch { return null; } }).filter(Boolean));
    for (const m of pag.texto.matchAll(/href=["']([^"'#\s]+)["']/gi)) {
      try {
        const a = new URL(m[1], base);
        if (a.hostname === base.hostname && /(job|vaga|emprego|empleo|oferta|position|opening)/i.test(a.pathname) && a.pathname !== base.pathname && a.pathname.length > 8) candidatos.add(a.toString());
      } catch { /* link inválido */ }
    }
    let n = 0;
    for (const link of candidatos) {
      if (n >= maxDetalhes) break;
      n += 1;
      try {
        if (new URL(link).hostname !== base.hostname || !(await liberado(link))) continue;
        if (atraso) await dormir(atraso);
        const d = await fontes.baixar(link);
        for (const j of coletar(blocosJsonLd(d.texto)).vagas.slice(0, 1)) { const v = mapear(j, link, fonte); if (v) achadas.push(v); }
      } catch { /* anúncio individual indisponível: segue */ }
    }
  }
  if (!achadas.length) throw new Error('nenhum dado de vaga (JobPosting) encontrado nesta página; o site pode carregar as vagas só com JavaScript ou exigir login');
  return achadas.slice(0, MAX_VAGAS);
}

module.exports = { liberado, robotsDe, atrasoDeRobots, buscarPagina, rotuloDe, parseRobots, permitidoPorRobots, coletar, blocosJsonLd, mapear, limpaHtml };
