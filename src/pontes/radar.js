'use strict';
/**
 * Pontes — radar diário de vagas.
 *
 * Todo dia (08:30, horário de Brasília) busca vagas em fontes públicas, descarta o que você já viu, pontua cada
 * anúncio contra as suas evidências (TF-IDF + cobertura de habilidades, tudo local) e importa as melhores como
 * "A avaliar". As N primeiras já são analisadas pela IA, o que gera a chance estimada de avançar (modelo aprendido).
 *
 * Fontes sem chave de API: Gupy (portal público de vagas, Brasil) e Remotive (vagas remotas, em inglês).
 * Cada fonte falha sozinha: uma fora do ar não derruba as outras. LinkedIn e Indeed não entram: os termos de uso proíbem.
 */

const axios = require('axios');
const store = require('./store');
const { canon, tokens, Tfidf, cosine } = require('./ml/text');
const paginas = require('./paginas');
const jobgether = require('./jobgether');

const PADRAO = {
  ativo: true,
  consultas: ['engenheiro de dados', 'data engineer', 'analista de dados'],
  consultasEn: ['data engineer'],
  gupy: true,
  remotive: true,
  excluir: ['estagi', 'aprendiz', 'trainee', 'jovem talento'],
  maxNovas: 15,
  analisarTop: 3,
  diasMax: 10,
  paginasExtras: [],
  jobgether: true,
};
const MAX_VISTOS = 3000;
const UA = 'Mozilla/5.0 (compatible; Pontes-de-Carreira/1.0)';

function configuracao() {
  const p = store.perfil.obter();
  return Object.assign({}, PADRAO, p.radar || {});
}

const limpaHtml = paginas.limpaHtml;

/* ---------- fontes ---------- */
const GUPY = [
  { url: 'https://portal.gupy.io/api/job-search/jobs', param: 'jobName' },
  { url: 'https://portal.api.gupy.io/api/v1/jobs', param: 'jobName' },
  { url: 'https://portal.api.gupy.io/api/job', param: 'name' },
];

async function buscarGupy(consulta) {
  let ultimo = null;
  for (const ep of GUPY) {
    try {
      const r = await axios.get(ep.url, {
        params: { [ep.param]: consulta, limit: 30, offset: 0 }, timeout: 20000, headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (!Array.isArray(r.data && r.data.data)) throw new Error('resposta sem lista de vagas');
      return r.data.data.map((j) => ({
        fonte: 'radar:gupy',
        titulo: j.name || '',
        empresa: j.careerPageName || j.companyName || '',
        url: j.jobUrl || '',
        local: [j.city, j.state].filter(Boolean).join(' - ') + (j.isRemoteWork || j.workplaceType === 'remote' ? ' (remoto)' : ''),
        publicadaEm: Date.parse(j.publishedDate) || null,
        texto: limpaHtml(j.description),
      }));
    } catch (e) { ultimo = e; }
  }
  throw ultimo;
}

async function buscarRemotive(consulta) {
  const r = await axios.get('https://remotive.com/api/remote-jobs', {
    params: { search: consulta, limit: 30 }, timeout: 20000, headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  return (r.data.jobs || []).map((j) => ({
    fonte: 'radar:remotive',
    titulo: j.title || '',
    empresa: j.company_name || '',
    url: j.url || '',
    local: j.candidate_required_location || 'Remoto',
    publicadaEm: Date.parse(j.publication_date) || null,
    texto: limpaHtml(j.description) + (j.salary ? `\nSalário: ${j.salary}` : ''),
  }));
}

const FONTES = {
  gupy: { consultas: (c) => c.consultas, buscar: buscarGupy },
  remotive: { consultas: (c) => c.consultasEn, buscar: buscarRemotive },
  jobgether: { consultas: () => ['feed'], buscar: (q, c) => jobgether.buscarJobgether(q, c), rotulo: () => 'jobgether' },
  // Páginas de busca de outros sites (Jobgether, BeBee…): lidas por JobPosting (JSON-LD), respeitando robots.txt.
  extras: { consultas: (c) => c.paginasExtras || [], buscar: (u) => paginas.buscarPagina(u), rotulo: (u) => paginas.rotuloDe(u) },
};

/* ---------- bloqueio geográfico (a pré-triagem não enxerga residência/visto) ---------- */
const RE_BLOQUEIO = /(remote|remoto|remota)\W+(from|in|de|em)\W+(portugal|europe|europa|eu|the eu|selected eu|united states|usa|u\.s\.|uk|canada|canadá|germany|spain)\b|legal(ly)?\W+(resid|authori)|resid[eê]ncia legal|work authori[sz]ation|must (live|reside|be located) in (the )?(us|usa|united states|europe|eu|uk|canada|portugal)\b|only (open )?to (residents|candidates) (in|of)/i;
const RE_REMOTO_LIVRE = /worldwide|anywhere|brazil|brasil|latam|latin america|americas/i;

function bloqueioGeografico(a) {
  if (RE_BLOQUEIO.test(`${a.titulo}\n${String(a.texto).slice(0, 4000)}`)) return true;
  if (a.restricaoLocal && !RE_REMOTO_LIVRE.test(a.restricaoLocal)) return true;
  return a.fonte === 'radar:remotive' && !!a.local && !RE_REMOTO_LIVRE.test(a.local);
}

/* ---------- pontuação local ---------- */
function pontuador(evidencias, anuncios) {
  const base = evidencias.filter((e) => !e.revisar);
  const docPerfil = base.map((e) => `${e.skill} ${e.skill} ${e.prova || ''}`).join('\n');
  const docs = anuncios.map((a) => `${a.titulo} ${a.titulo} ${a.texto}`);
  const tfidf = new Tfidf([docPerfil, ...docs]);
  const vPerfil = tfidf.vec(docPerfil);
  const habilidades = base.map((e) => String(e.skill).split(/[,;/|]| e | and /i).map((s) => tokens(s)).filter((t) => t.length));
  return (a, i) => {
    const conj = new Set(tokens(docs[i]));
    const sim = cosine(vPerfil, tfidf.vec(docs[i]));
    let acertos = 0;
    for (const segs of habilidades) if (segs.some((t) => t.every((w) => conj.has(w)))) acertos += 1;
    const cobertura = Math.min(1, acertos / 6);
    return { score: Number((0.5 * Math.min(1, sim * 2.5) + 0.5 * cobertura).toFixed(3)), acertos };
  };
}

const chaveDe = (a) => (a.url ? 'u:' + a.url.split('?')[0] : 'k:' + canon(a.titulo + '|' + a.empresa));

let rodando = false;

/**
 * @param {{manual?:boolean, fontes?:object, agora?:number}} opt `fontes` permite injetar fontes nos testes.
 */
async function executar(opt = {}) {
  if (rodando) return { ja_em_execucao: true };
  rodando = true;
  const svc = require('./service');
  const cfg = configuracao();
  const agora = opt.agora || Date.now();
  let vistosRodada = null;
  const resumo = { em: agora, manual: !!opt.manual, fontes: {}, encontradas: 0, novas: [], analisadas: [], erros: [] };
  try {
    if (!cfg.ativo && !opt.manual) return { desativado: true };
    const evidencias = store.evidencias.listar();
    if (!evidencias.filter((e) => !e.revisar).length) {
      resumo.erros.push('Cadastre ao menos uma evidência para o radar saber o que procurar.');
      return resumo;
    }
    const perfil = store.perfil.obter();
    const vistos = new Set(perfil.radarVistos || []);
    for (const v of store.vagas.listar()) vistos.add(chaveDe(v));
    vistosRodada = vistos;

    const fontes = opt.fontes || FONTES;
    const achadas = [];
    for (const [nome, f] of Object.entries(fontes)) {
      if (cfg[nome] === false) continue;
      for (const q of f.consultas(cfg)) {
        const chave = f.rotulo ? f.rotulo(q) : nome;
        const st = resumo.fontes[chave] || (resumo.fontes[chave] = { ok: 0, erro: null });
        try {
          achadas.push(...(await f.buscar(q, cfg)));
          st.ok += 1;
        } catch (e) {
          st.erro = e.response ? `HTTP ${e.response.status}` : e.message;
          console.error(`[PONTES] radar ${chave} "${q}" falhou:`, st.erro);
        }
      }
    }
    resumo.encontradas = achadas.length;

    const limite = agora - cfg.diasMax * 86400000;
    const excluir = (cfg.excluir || []).map(canon).filter(Boolean);
    const unicas = [];
    const naRodada = new Set();
    for (const a of achadas) {
      const k = chaveDe(a);
      if (vistos.has(k) || naRodada.has(k)) continue;
      naRodada.add(k);
      if (a.publicadaEm && a.publicadaEm < limite) continue;
      if (excluir.some((t) => canon(a.titulo).includes(t))) continue;
      a.texto = a.texto && a.texto.length >= 40 ? a.texto : [a.titulo, a.empresa, a.local].filter(Boolean).join(' — ') + ' (descrição não disponível na listagem; abra o anúncio)';
      a.chave = k;
      unicas.push(a);
    }

    const pontua = pontuador(evidencias, unicas);
    unicas.forEach((a, i) => {
      Object.assign(a, pontua(a, i));
      a.bloqueio = bloqueioGeografico(a);
      if (a.bloqueio) a.score = Number((a.score * 0.5).toFixed(3));
    });
    unicas.sort((a, b) => b.score - a.score);
    const escolhidas = unicas.filter((a) => a.acertos >= 1).slice(0, cfg.maxNovas); // ao menos uma habilidade sua precisa aparecer no anúncio

    for (const a of escolhidas) {
      const id = svc.criarVaga({
        texto: a.texto, titulo: a.titulo, empresa: a.empresa, url: a.url,
        fonte: a.fonte + (a.local ? ` · ${a.local}` : ''),
      });
      store.eventos.registrar('radar', id, { score: a.score, acertos: a.acertos });
      resumo.novas.push({ id, titulo: a.titulo, empresa: a.empresa, score: a.score, fonte: a.fonte, bloqueio: !!a.bloqueio });
    }
    // Marca como vistas todas as encontradas, inclusive as não importadas: não voltam amanhã.
    for (const a of unicas) vistos.add(a.chave);

    for (const n of resumo.novas.slice(0, cfg.analisarTop)) {
      const a = unicas.find((u) => u.titulo === n.titulo && u.empresa === n.empresa);
      if (!a || a.texto.length < 300) continue;
      try { await svc.analisarVaga(n.id); resumo.analisadas.push(n.id); }
      catch (e) { resumo.erros.push(`Análise da vaga ${n.id}: ${e.message}`); break; }
    }
  } catch (e) {
    resumo.erros.push(e.message);
    console.error('[PONTES] radar falhou:', e);
  } finally {
    rodando = false;
    const p = store.perfil.obter();
    p.radarUltimo = resumo;
    p.radarVistos = Array.from(new Set([...(p.radarVistos || []), ...(vistosRodada || []), ...store.vagas.listar().map(chaveDe)])).slice(-MAX_VISTOS);
    store.perfil.salvar(p);
  }
  console.log(`[PONTES] radar: ${resumo.encontradas} encontradas, ${resumo.novas.length} novas, ${resumo.analisadas.length} analisadas` + (resumo.erros.length ? `, ${resumo.erros.length} aviso(s)` : ''));
  return resumo;
}

const emExecucao = () => rodando;

module.exports = { executar, emExecucao, bloqueioGeografico, configuracao, PADRAO, chaveDe, pontuador };
