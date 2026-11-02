'use strict';
/**
 * Pontes — fontes do perfil: currículo atual, LinkedIn e portfólios.
 *
 * - Currículo: texto colado, .txt/.md/.docx enviados (o PDF é lido no navegador e chega aqui como texto).
 * - LinkedIn: o site exige login e proíbe leitura automática, então a fonte é o texto que você cola ou o PDF do
 *   próprio perfil (LinkedIn › Mais › Salvar como PDF).
 * - Portfólios: páginas públicas (GitHub via API pública; demais sites por leitura simples), com proteção contra
 *   endereços internos.
 * A IA lê as três fontes e PROPÕE evidências; nada vira evidência sem a sua aprovação.
 */

const zlib = require('node:zlib');
const dns = require('node:dns').promises;
const net = require('node:net');
const axios = require('axios');
const llm = require('./llm');

const MAX_TEXTO = 30000;
const MAX_PORTFOLIOS = 8;
const UA = 'Mozilla/5.0 (compatible; Pontes-de-Carreira/1.0)';

function erro(status, msg) { const e = new Error(msg); e.status = status; return e; }

const decodifica = (s) => String(s)
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&');

const normaliza = (s) => String(s || '').replace(/\r/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXTO);

/* ---------- arquivos ---------- */
function lerZip(buf, alvo) {
  let fim = buf.length - 22;
  while (fim >= 0 && buf.readUInt32LE(fim) !== 0x06054b50) fim -= 1;
  if (fim < 0) throw erro(400, 'Arquivo .docx inválido.');
  const n = buf.readUInt16LE(fim + 10);
  let p = buf.readUInt32LE(fim + 16);
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10), comp = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const nome = buf.slice(p + 46, p + 46 + nl).toString('utf8');
    if (nome === alvo) {
      const ln = buf.readUInt16LE(off + 26), le = buf.readUInt16LE(off + 28);
      const bruto = buf.slice(off + 30 + ln + le, off + 30 + ln + le + comp);
      return metodo === 0 ? bruto : zlib.inflateRawSync(bruto, { maxOutputLength: 20 * 1024 * 1024 });
    }
    p += 46 + nl + el + cl;
  }
  return null;
}

function textoDeDocx(buf) {
  const xml = lerZip(buf, 'word/document.xml');
  if (!xml) throw erro(400, 'Não encontrei texto neste .docx.');
  return decodifica(xml.toString('utf8').replace(/<w:tab\s*\/>/g, '\t').replace(/<w:br\s*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, ''));
}

function textoDeArquivo(buf, nome) {
  const ext = String(nome || '').toLowerCase().split('.').pop();
  let t;
  if (ext === 'docx') t = textoDeDocx(buf);
  else if (['txt', 'md', 'markdown', 'text'].includes(ext)) t = buf.toString('utf8');
  else if (['html', 'htm'].includes(ext)) t = htmlParaTexto(buf.toString('utf8'));
  else throw erro(400, 'Formato não suportado aqui. Envie .docx, .txt ou .md (o PDF é lido pelo navegador).');
  t = normaliza(t);
  if (t.length < 30) throw erro(400, 'Não consegui extrair texto deste arquivo.');
  return t;
}

/* ---------- web ---------- */
function htmlParaTexto(html) {
  const titulo = (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const corpo = String(html).replace(/<(script|style|noscript|svg|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  return (titulo ? decodifica(titulo).trim() + '\n' : '') + decodifica(corpo);
}

function ipPrivado(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return ipPrivado(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function validarDestino(u) {
  let url;
  try { url = new URL(u); } catch { throw erro(400, 'Endereço inválido.'); }
  if (!/^https?:$/.test(url.protocol)) throw erro(400, 'Use um endereço http ou https.');
  if (/(^|\.)linkedin\.com$/i.test(url.hostname)) throw erro(400, 'O LinkedIn não pode ser lido automaticamente. Cole o texto do perfil ou envie o PDF dele no campo do LinkedIn.');
  const ips = net.isIP(url.hostname) ? [url.hostname] : (await dns.lookup(url.hostname, { all: true })).map((a) => a.address);
  if (!ips.length || ips.some(ipPrivado)) throw erro(400, 'Endereço não permitido.');
  return url;
}

async function baixar(u, opts = {}) {
  let atual = u;
  for (let i = 0; i < 4; i++) {
    const url = await validarDestino(atual);
    const r = await axios.get(url.toString(), {
      timeout: 15000, maxRedirects: 0, maxContentLength: opts.maxBytes || 2 * 1024 * 1024, responseType: 'text', validateStatus: (s) => s < 400 || (s >= 300 && s < 400),
      headers: { 'User-Agent': UA, Accept: opts.accept || 'text/html,application/json,text/plain' }, transformResponse: (x) => x,
    });
    if (r.status >= 300) { if (!r.headers.location) break; atual = new URL(r.headers.location, url).toString(); continue; }
    return { texto: String(r.data), tipo: String(r.headers['content-type'] || '') };
  }
  throw erro(502, 'Muitos redirecionamentos.');
}

async function lerGithub(url) {
  const partes = url.pathname.split('/').filter(Boolean);
  const gh = (p, accept) => axios.get('https://api.github.com' + p, { timeout: 15000, headers: { 'User-Agent': UA, Accept: accept || 'application/vnd.github+json' }, validateStatus: (s) => s < 500 });
  const [dono, repo] = partes;
  if (!dono) throw erro(400, 'Informe o endereço do seu perfil ou de um repositório no GitHub.');
  const linhas = [];
  if (repo) {
    const r = await gh(`/repos/${dono}/${repo}`);
    if (r.status !== 200) throw erro(502, `GitHub respondeu ${r.status} para este repositório.`);
    const d = r.data;
    linhas.push(`Repositório ${d.full_name}: ${d.description || 'sem descrição'} | linguagem: ${d.language || '—'} | tópicos: ${(d.topics || []).join(', ') || '—'} | estrelas: ${d.stargazers_count} | ${d.html_url}`);
    const rd = await gh(`/repos/${dono}/${repo}/readme`, 'application/vnd.github.raw+json');
    if (rd.status === 200) linhas.push('README:\n' + String(rd.data).slice(0, 5000));
  } else {
    const u = await gh(`/users/${dono}`);
    if (u.status !== 200) throw erro(502, `GitHub respondeu ${u.status} para este usuário.`);
    linhas.push(`Perfil GitHub ${u.data.login}${u.data.name ? ' (' + u.data.name + ')' : ''}: ${u.data.bio || 'sem bio'} | repositórios públicos: ${u.data.public_repos}`);
    const rs = await gh(`/users/${dono}/repos?per_page=40&sort=pushed`);
    for (const d of (rs.status === 200 ? rs.data : []).filter((x) => !x.fork).slice(0, 20)) {
      linhas.push(`- ${d.name}: ${d.description || 'sem descrição'} | ${d.language || '—'} | ${(d.topics || []).join(', ')} | ${d.html_url}`);
    }
    const rd = await gh(`/repos/${dono}/${dono}/readme`, 'application/vnd.github.raw+json');
    if (rd.status === 200) linhas.push('README do perfil:\n' + String(rd.data).slice(0, 3000));
  }
  return linhas.join('\n');
}

/** Lê uma página pública de portfólio. Nunca lança: devolve { erro } para a interface mostrar. */
async function lerPortfolio(u) {
  const base = { url: String(u).trim().slice(0, 400), lidoEm: Date.now() };
  try {
    const url = await validarDestino(base.url);
    let texto;
    if (/(^|\.)github\.com$/i.test(url.hostname)) texto = await lerGithub(url);
    else {
      const r = await baixar(url.toString());
      texto = /html/i.test(r.tipo) || /^\s*</.test(r.texto) ? htmlParaTexto(r.texto) : r.texto;
    }
    texto = normaliza(texto);
    if (texto.length < 40) return { ...base, erro: 'A página não trouxe texto legível (talvez dependa de JavaScript). Cole o conteúdo manualmente em Observações ou use o GitHub.' };
    return { ...base, texto: texto.slice(0, 12000) };
  } catch (e) {
    return { ...base, erro: e.response ? `O site respondeu ${e.response.status}.` : e.message };
  }
}

/* ---------- contexto para as análises ---------- */
/** Resumo das fontes para entrar nos prompts como CONTEXTO (nunca como prova de requisito). */
function contexto(perfil, max = 6000) {
  const f = (perfil && perfil.fontes) || {};
  const blocos = [];
  if (f.curriculo && f.curriculo.texto) blocos.push('Currículo atual:\n' + f.curriculo.texto.slice(0, 3500));
  if (f.linkedin && f.linkedin.texto) blocos.push('LinkedIn:\n' + f.linkedin.texto.slice(0, 1500));
  const ps = (f.portfolios || []).filter((p) => p.texto).map((p) => `${p.url}:\n${p.texto.slice(0, 600)}`);
  if (ps.length) blocos.push('Portfólios:\n' + ps.join('\n'));
  return blocos.join('\n\n').slice(0, max);
}

/* ---------- extração por IA ---------- */
const SYSTEM = 'Você extrai fatos de currículos e portfólios para o app Pontes. Responda somente com JSON válido, sem texto fora do JSON. Nunca invente.';

async function propor(perfil, existentes) {
  const f = (perfil && perfil.fontes) || {};
  const partes = [];
  if (f.curriculo && f.curriculo.texto) partes.push('=== CURRÍCULO ===\n' + f.curriculo.texto.slice(0, 14000));
  if (f.linkedin && f.linkedin.texto) partes.push('=== LINKEDIN ===\n' + f.linkedin.texto.slice(0, 9000));
  for (const p of f.portfolios || []) if (p.texto) partes.push(`=== PORTFÓLIO ${p.url} ===\n${p.texto.slice(0, 6000)}`);
  if (!partes.length) throw erro(400, 'Adicione ao menos o currículo, o LinkedIn ou um portfólio antes de extrair.');
  const corpus = partes.join('\n\n');
  const ja = new Set(existentes.map((e) => canon(e.skill)));
  const pedir = async (user, maxTokens) => {
    const resp = await llm.chamar({ system: SYSTEM, user, maxTokens, timeout: 180000 });
    try { return llm.extrairJson(resp); } catch (e) {
      console.error(`[PONTES] extração: resposta ilegível (${String(resp).length} caracteres): ${String(resp).slice(0, 300).replace(/\s+/g, ' ')} …`);
      throw erro(502, 'A IA não devolveu um resultado legível. Tente de novo; se persistir, veja o log do servidor (linha "[PONTES] extração").');
    }
  };

  // Duas chamadas menores: dados do currículo (falha aqui não impede as evidências) e evidências.
  const userCv = `Leia as FONTES e extraia SÓ os dados para montar o currículo, em JSON.
Regras: use somente o que está escrito; se não está, deixe vazio ("" ). Sem inventar cargos, datas, empresas, números ou links.
- experiencias: blocos separados por UMA linha em branco; primeira linha "Cargo — Empresa (mês/ano – mês/ano)"; demais linhas começam com "- " (entregas reais, números só se constarem). No máximo 6 itens por bloco.
- formacao: um curso por bloco ("Curso — Instituição (situação)").
- resumo: 3 frases baseadas nas fontes. Português do Brasil.
Formato exato: {"cv":{"nome":"","titulo":"","cidade":"","email":"","telefone":"","linkedin":"","github":"","resumo":"","experiencias":"","formacao":"","idiomas":""}}

${corpus}`;
  let jcv = {};
  try { jcv = await pedir(userCv, 4000); } catch (e) { console.error('[PONTES] extração do currículo falhou:', e.message); }

  const user = `Leia as FONTES e extraia evidências: habilidades, ferramentas e entregas que a pessoa PROVA, em JSON.

Regras:
- Use somente o que está nas fontes. Sem inventar. Uma evidência por habilidade, ferramenta ou entrega concreta (ex.: "Apache Airflow", "Pipeline medalhão no projeto X", "SAP MM").
- "prova": UMA frase curta (até 160 caracteres) dizendo ONDE e COMO foi usado (cargo, projeto, resultado) segundo a fonte.
- "nivel": "Básico", "Intermediário" ou "Avançado" só se o texto sustentar (anos de uso, responsabilidade); senão "Não definido".
- "link": só um endereço que apareça literalmente nas fontes; senão "". "fonte": "curriculo", "linkedin" ou "portfolio".
- Ignore soft skills genéricas e jargão sem prova. Não repita o que já está em JÁ CADASTRADAS.
- No máximo 30 evidências, as mais relevantes primeiro. Português do Brasil.
Formato exato: {"evidencias":[{"skill":"","nivel":"Não definido","prova":"","link":"","fonte":"curriculo"}]}

=== JÁ CADASTRADAS ===
${existentes.map((e) => e.skill).join('; ') || '(nenhuma)'}

${corpus}`;
  const j = await pedir(user, 8000);
  j.cv = (jcv && jcv.cv) || {};
  const vistos = new Set();
  const evidencias = (Array.isArray(j.evidencias) ? j.evidencias : []).map((e) => {
    const link = String((e && e.link) || '').trim();
    return {
      skill: String((e && e.skill) || '').trim().slice(0, 120), nivel: String((e && e.nivel) || 'Não definido'),
      prova: String((e && e.prova) || '').trim().slice(0, 1200),
      link: /^https?:\/\//i.test(link) && corpus.includes(link.replace(/\/$/, '')) ? link.slice(0, 400) : '',
      fonte: ['curriculo', 'linkedin', 'portfolio'].includes(e && e.fonte) ? e.fonte : 'curriculo',
    };
  }).filter((e) => {
    const k = canon(e.skill);
    if (!k || ja.has(k) || vistos.has(k)) return false;
    vistos.add(k);
    return true;
  }).slice(0, 30);
  const cv = {};
  for (const k of ['nome', 'titulo', 'cidade', 'email', 'telefone', 'linkedin', 'github', 'resumo', 'experiencias', 'formacao', 'idiomas']) {
    cv[k] = String((j.cv && j.cv[k]) || '').trim();
  }
  return { cv, evidencias };
}

const { canon } = require('./ml/text');

module.exports = { baixar, textoDeArquivo, textoDeDocx, lerPortfolio, contexto, propor, normaliza, ipPrivado, validarDestino, htmlParaTexto, MAX_PORTFOLIOS, MAX_TEXTO };
