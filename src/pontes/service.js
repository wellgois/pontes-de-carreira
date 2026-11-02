'use strict';
/**
 * Pontes — regras de negócio e ciclo de aprendizado.
 *
 * O que aprende, e com quê:
 *  1. Casamento requisito x evidência: ajustes por par, a cada confirmação ou rejeição sua.
 *  2. Modelo de desfecho (regressão logística online): a cada candidatura com resultado conhecido.
 *  3. Demanda do mercado: recalculada com decaimento temporal a cada consulta (vagas novas pesam mais).
 *  4. Prioridade das lacunas: combina 2 e 3 com o esforço da ponte e testa lacunas pouco observadas.
 */

const store = require('./store');
const llm = require('./llm');
const curriculoMod = require('./curriculo');
const radar = require('./radar');
const fontes = require('./fontes');
const { canon } = require('./ml/text');
const { Matcher, aprender: aprenderPar } = require('./ml/matcher');
const { OutcomeModel, resumoPrequential, MIN_OBSERVACOES_CONFIAVEL } = require('./ml/outcome');
const { demanda, prioridades, rngSemente } = require('./ml/market');
const { aderencia, contagem, featuresDe } = require('./ml/features');

const STATUS = ['interesse', 'candidatado', 'entrevista', 'oferta', 'recusada', 'descartada'];
const ETAPAS = ['', 'triagem', 'rh', 'tecnica', 'final', 'sem_retorno'];
const MOTIVOS = ['', 'salario', 'tecnico', 'ingles', 'senioridade', 'cancelada', 'outro', 'desconhecido'];
const NIVEIS = ['Não definido', 'Básico', 'Intermediário', 'Avançado'];
const TIPOS = ['obrigatorio', 'desejavel', 'ruido'];
const ESTADOS_REQ = ['verde', 'amarelo', 'vermelho'];
const DIAS_SEM_RETORNO = 30;

function erro(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}
const txt = (s, max) => String(s == null ? '' : s).trim().slice(0, max);
const urlSegura = (u) => (/^https?:\/\//i.test(u || '') ? txt(u, 400) : '');

/* ---------- modelo ---------- */
const carregarModelo = () => new OutcomeModel(store.modelo.carregar() || undefined);
const salvarModelo = (m) => store.modelo.salvar(m.toJSON());

function rotulo(v) {
  if (v.status === 'entrevista' || v.status === 'oferta') return { y: 1, peso: 1 };
  if (v.status === 'recusada') {
    if (['rh', 'tecnica', 'final'].includes(v.etapaRecusa)) return { y: 1, peso: 1 };
    if (v.etapaRecusa === 'triagem') return { y: 0, peso: 1 };
    if (v.etapaRecusa === 'sem_retorno') return { y: 0, peso: 0.5 };
  }
  return null; // sem desfecho conhecido: nada a aprender ainda
}

function passoDeAprendizado(modelo, v, r) {
  const x = v.features || featuresDe(v);
  const hist = store.previsoes.todas();
  const pos = hist.filter((h) => h.y).length;
  const pBase = (pos + 1) / (hist.length + 2);
  const p = modelo.update(x, r.y, r.peso);
  store.previsoes.registrar(v.id, p, pBase, r.y);
  return { p, pBase };
}

/** Aprende com a vaga se ela acabou de ganhar um desfecho. Se o desfecho mudou, refaz o treino do zero. */
function aprenderComDesfecho(id) {
  const v = store.vagas.obter(id);
  const r = v && rotulo(v);
  if (!r || !v.requisitos.length) return null; // sem análise, as características seriam vazias
  if (v.label == null) {
    if (!v.features) store.vagas.salvarFeatures(id, featuresDe(v));
    const m = carregarModelo();
    const { p } = passoDeAprendizado(m, store.vagas.obter(id), r);
    salvarModelo(m);
    store.vagas.marcarLabel(id, r.y, Date.now());
    store.eventos.registrar('aprendeu', id, { y: r.y, previsto: Number(p.toFixed(3)) });
    return { aprendeu: true, previsto: p, y: r.y };
  }
  if (v.label !== r.y) {
    store.vagas.marcarLabel(id, r.y, v.labelEm);
    return reconstruir();
  }
  return null;
}

/** Refaz o treino do zero reproduzindo, em ordem, todos os desfechos conhecidos. */
function reconstruir() {
  const m = new OutcomeModel();
  store.previsoes.limpar();
  let n = 0;
  for (const v of store.vagas.comLabelOrdenadas()) {
    const r = rotulo(v);
    if (!r) continue;
    passoDeAprendizado(m, v, r);
    store.vagas.marcarLabel(v.id, r.y, v.labelEm);
    n += 1;
  }
  salvarModelo(m);
  store.eventos.registrar('reconstruiu', null, { exemplos: n });
  return { reconstruido: true, exemplos: n };
}

/* ---------- evidências ---------- */
function validarEvidencia(d) {
  const skill = txt(d.skill, 120);
  if (!skill) throw erro(400, 'Informe a habilidade ou entrega.');
  return {
    skill, nivel: NIVEIS.includes(d.nivel) ? d.nivel : 'Não definido',
    prova: txt(d.prova, 1200), link: urlSegura(d.link),
    origemPonte: d.origemPonte ? txt(d.origemPonte, 80) : null,
  };
}

function criarEvidencia(d) {
  const dados = validarEvidencia(d);
  const id = store.evidencias.criar(dados);
  store.eventos.registrar(dados.origemPonte ? 'ponte_concluida' : 'evidencia', null, { id, skill: dados.skill, origemPonte: dados.origemPonte });
  return { id, impacto: rematchTodas().filter((i) => i.novasSugestoes > 0) };
}

/* ---------- análise de vaga ---------- */
const SYSTEM_EXTRACAO = 'Você é o extrator do app Pontes. Responda somente com JSON válido, sem texto fora do JSON.';

function contextoFontes(perfil) {
  const c = fontes.contexto(perfil);
  return c ? `\n=== CONTEXTO DO PERFIL (não vale como prova) ===\n${c}\n` : '';
}

function promptAnalise(v, evid, perfil) {
  const evTxt = evid.map((e) => `[${e.id}] ${e.skill} | nível: ${e.nivel} | prova: ${e.prova || 'sem descrição'}`).join('\n') || '(nenhuma evidência cadastrada)';
  return `Compare a VAGA com as EVIDÊNCIAS reais da pessoa.

Regras:
- Decomponha a vaga em requisitos. tipo: "obrigatorio", "desejavel" ou "ruido" (lista inflada de tecnologias, jargão sem peso real, soft skills genéricas).
- nome: nome canônico curto e consistente entre vagas (ex.: "Apache Airflow", "Kafka", "Inglês oral", "SQL").
- status: "verde" só quando alguma evidência da lista prova o requisito, citando os ids em "evidencias". "amarelo": experiência parcial ou adjacente (explique em "nota"). "vermelho": sem evidência ou presente nas lacunas declaradas.
- Nunca invente experiência. Sem id que sustente, não use verde. O CONTEXTO DO PERFIL (currículo, LinkedIn, portfólio) serve para avaliar senioridade e adjacência, mas NÃO vale como prova: verde exige id de evidência.
- ponte: só para amarelo ou vermelho que não sejam ruído: {"projeto": menor projeto prático que fecha a lacuna, com entregável publicável, em 1 a 2 frases; "horas": inteiro}.
- sinais_risco: indícios de golpe (pedido de pagamento, contato só por mensagem, promessas irreais), faixa salarial abaixo do alvo, exigência de idioma que a pessoa declarou limitado. Lista vazia se nada.
- No máximo 16 requisitos. Português do Brasil.

Formato exato:
{"empresa":"","titulo":"","faixa_salarial":"","resumo":"duas frases","sinais_risco":[""],"requisitos":[{"nome":"","tipo":"obrigatorio","status":"verde","evidencias":[1],"nota":"","ponte":{"projeto":"","horas":0}}]}

=== PERFIL ===
Alvo salarial: ${perfil.alvo || 'não informado'}
Lacunas declaradas: ${(perfil.lacunas || []).join(', ') || 'nenhuma'}
Observações: ${perfil.obs || 'nenhuma'}

=== EVIDÊNCIAS ===
${evTxt}
${contextoFontes(perfil)}
=== VAGA ===
${v.titulo ? 'Título informado: ' + v.titulo + '\n' : ''}${v.empresa ? 'Empresa informada: ' + v.empresa + '\n' : ''}${String(v.texto).slice(0, 12000)}`;
}

function limparRequisitos(arr, evid) {
  const validos = new Set(evid.map((e) => String(e.id)));
  return (Array.isArray(arr) ? arr : []).slice(0, 20).map((r) => {
    if (!r || !r.nome) return null;
    const tipo = TIPOS.includes(r.tipo) ? r.tipo : 'desejavel';
    let status = ESTADOS_REQ.includes(r.status) ? r.status : 'vermelho';
    const ids = (Array.isArray(r.evidencias) ? r.evidencias : []).map(String).filter((i) => validos.has(i)).map(Number);
    if (status === 'verde' && !ids.length) status = 'amarelo'; // verde exige evidência real
    const out = { nome: txt(r.nome, 80), tipo, status, evidencias: ids, nota: txt(r.nota, 240) };
    if (status !== 'verde' && tipo !== 'ruido' && r.ponte && r.ponte.projeto) {
      out.ponte = { projeto: txt(r.ponte.projeto, 300), horas: Math.max(0, Math.round(Number(r.ponte.horas) || 0)) };
    }
    return out;
  }).filter(Boolean);
}

/** Anexa sugestões "provável" calculadas localmente. Nunca promove a verde sem confirmação sua. */
function anexarSugestoes(reqs, evid, corpus) {
  if (!evid.length) return 0;
  const m = new Matcher(evid, store.ajustes.todos(), corpus);
  let n = 0;
  for (const r of reqs) {
    delete r.sugestaoMl;
    if (r.status === 'verde' || r.tipo === 'ruido') continue;
    const b = m.melhor(r.nome);
    if (!b || (r.rejeitados || []).includes(b.id) || (r.evidencias || []).includes(b.id)) continue;
    r.sugestaoMl = { evidenciaId: b.id, skill: b.skill, score: Number(b.score.toFixed(2)) };
    n += 1;
  }
  return n;
}

async function analisarVaga(id) {
  const v = store.vagas.obter(id);
  if (!v) throw erro(404, 'Vaga não encontrada.');
  const evid = store.evidencias.listar();
  const perfil = store.perfil.obter();
  const bruto = await llm.chamar({ system: SYSTEM_EXTRACAO, user: promptAnalise(v, evid, perfil) });
  let out;
  try {
    out = llm.extrairJson(bruto);
  } catch {
    throw erro(502, 'A IA respondeu em formato inesperado. Tente analisar de novo.');
  }
  const reqs = limparRequisitos(out.requisitos, evid);
  if (!reqs.length) throw erro(502, 'A IA não encontrou requisitos nesta vaga.');
  anexarSugestoes(reqs, evid, reqs.map((r) => r.nome));
  store.vagas.salvarAnalise(id, {
    titulo: v.titulo || txt(out.titulo, 140), empresa: v.empresa || txt(out.empresa, 120),
    faixaSalarial: txt(out.faixa_salarial, 80), resumo: txt(out.resumo, 500),
    sinaisRisco: (Array.isArray(out.sinais_risco) ? out.sinais_risco : []).slice(0, 6).map((s) => txt(s, 240)),
    requisitos: reqs,
  });
  store.eventos.registrar('analisou', id, { requisitos: reqs.length });
  aprenderComDesfecho(id); // caso o desfecho já fosse conhecido antes da análise
  return detalhe(id);
}

/** Reavalia todas as vagas contra as evidências atuais, sem custo de IA. */
function rematchTodas() {
  const evid = store.evidencias.listar();
  const todas = store.vagas.listar().filter((v) => v.requisitos.length);
  const corpus = todas.flatMap((v) => v.requisitos.map((r) => r.nome));
  const out = [];
  for (const v of todas) {
    const antes = v.requisitos.filter((r) => r.sugestaoMl).length;
    const nova = anexarSugestoes(v.requisitos, evid, corpus);
    store.vagas.salvarRequisitos(v.id, v.requisitos);
    const prov = new Set(v.requisitos.filter((r) => r.sugestaoMl).map((r) => canon(r.nome)));
    out.push({
      vagaId: v.id, titulo: v.titulo, empresa: v.empresa,
      atual: aderencia(v), potencial: aderencia(v, prov), novasSugestoes: Math.max(0, nova - antes),
    });
  }
  return out;
}

function responderSugestao(vagaId, idx, confirmado) {
  const v = store.vagas.obter(vagaId);
  if (!v) throw erro(404, 'Vaga não encontrada.');
  const r = v.requisitos[idx];
  if (!r || !r.sugestaoMl) throw erro(400, 'Não há sugestão para este requisito.');
  const evId = r.sugestaoMl.evidenciaId;
  if (confirmado) {
    r.status = 'verde';
    r.evidencias = [...new Set([...(r.evidencias || []), evId])];
    r.confirmadoPorVoce = true;
  } else {
    r.rejeitados = [...new Set([...(r.rejeitados || []), evId])];
  }
  delete r.sugestaoMl;
  store.vagas.salvarRequisitos(vagaId, v.requisitos);
  const aj = aprenderPar(store.ajustes.todos(), r.nome, evId, confirmado);
  store.ajustes.definir(aj.chave, aj.valor);
  store.eventos.registrar(confirmado ? 'confirmou' : 'rejeitou', vagaId, { requisito: r.nome, evidenciaId: evId });
  return detalhe(vagaId);
}

/* ---------- vagas ---------- */
function criarVaga(d) {
  const texto = txt(d.texto, 20000);
  if (texto.length < 40) throw erro(400, 'Cole o texto completo da vaga (mínimo de 40 caracteres).');
  return store.vagas.criar({ texto, titulo: txt(d.titulo, 140), empresa: txt(d.empresa, 120), url: urlSegura(d.url), fonte: txt(d.fonte, 60) });
}

function atualizarVaga(id, patch) {
  const v = store.vagas.obter(id);
  if (!v) throw erro(404, 'Vaga não encontrada.');
  const status = patch.status !== undefined ? patch.status : v.status;
  const etapa = patch.etapaRecusa !== undefined ? patch.etapaRecusa : v.etapaRecusa;
  const motivo = patch.motivoRecusa !== undefined ? patch.motivoRecusa : v.motivoRecusa;
  if (!STATUS.includes(status)) throw erro(400, 'Situação inválida.');
  if (!ETAPAS.includes(etapa || '')) throw erro(400, 'Etapa inválida.');
  if (!MOTIVOS.includes(motivo || '')) throw erro(400, 'Motivo inválido.');
  const fonte = patch.fonte !== undefined ? txt(patch.fonte, 60) : v.fonte;
  const mudou = status !== v.status;
  store.vagas.atualizarCampos(id, { status, etapaRecusa: etapa, motivoRecusa: motivo, fonte, statusEm: mudou ? Date.now() : v.statusEm });
  if (mudou || etapa !== v.etapaRecusa) store.eventos.registrar('status', id, { de: v.status, para: status, etapa });
  // Congela as características no momento da candidatura: é o que o modelo deve aprender.
  if (status === 'candidatado' && !v.features && v.requisitos.length) store.vagas.salvarFeatures(id, featuresDe({ ...v, fonte }));
  const aprendizado = aprenderComDesfecho(id);
  return { vaga: detalhe(id), aprendizado };
}

function excluirVaga(id) {
  const v = store.vagas.obter(id);
  if (!v) throw erro(404, 'Vaga não encontrada.');
  store.vagas.excluir(id);
  store.eventos.registrar('excluiu', id, {});
  if (v.label != null) reconstruir();
}

/** Candidaturas sem resposta há muito tempo viram "sem retorno" (desfecho fraco, peso 0,5). */
function expirarSemRetorno(dias = DIAS_SEM_RETORNO, agora = Date.now()) {
  let n = 0;
  for (const v of store.vagas.listar()) {
    if (v.status === 'candidatado' && agora - (v.statusEm || v.criadoEm) > dias * 86400000) {
      atualizarVaga(v.id, { status: 'recusada', etapaRecusa: 'sem_retorno', motivoRecusa: 'desconhecido' });
      n += 1;
    }
  }
  if (n) console.log(`[PONTES] ${n} candidatura(s) marcadas como sem retorno`);
  return n;
}

function resumoDaVaga(v, modelo) {
  const ad = aderencia(v);
  return {
    id: v.id, titulo: v.titulo, empresa: v.empresa, faixaSalarial: v.faixaSalarial, status: v.status, fonte: v.fonte,
    etapaRecusa: v.etapaRecusa, motivoRecusa: v.motivoRecusa,
    aderencia: ad, contagem: contagem(v), analisada: v.requisitos.length > 0, criadoEm: v.criadoEm,
    pAvancar: v.requisitos.length ? Number(modelo.predict(featuresDe(v)).toFixed(3)) : null,
  };
}

function listarVagas() {
  const m = carregarModelo();
  return store.vagas.listar().map((v) => resumoDaVaga(v, m));
}

function detalhe(id) {
  const v = store.vagas.obter(id);
  if (!v) throw erro(404, 'Vaga não encontrada.');
  const m = carregarModelo();
  const res = resumoDaVaga(v, m);
  const o = { ...v, aderencia: res.aderencia, contagem: res.contagem, pAvancar: res.pAvancar };
  delete o.features;
  if (v.requisitos.length) {
    const base = m.predict(featuresDe(v));
    o.seFechar = v.requisitos
      .filter((r) => r.tipo !== 'ruido' && r.status !== 'verde')
      .map((r) => {
        const p = m.predict(featuresDe(v, new Set([canon(r.nome)])));
        return { nome: r.nome, ganho: Number((p - base).toFixed(3)), aderenciaDepois: aderencia(v, new Set([canon(r.nome)])) };
      })
      .sort((a, b) => b.ganho - a.ganho);
    o.modelo = { modo: m.modo(), confianca: Number(m.confianca().toFixed(2)) };
  }
  return o;
}

/* ---------- padrões, plano e aprendizado ---------- */
function vagasAnalisadas() {
  return store.vagas.listar().filter((v) => v.requisitos.length && v.status !== 'descartada');
}

function padroes(agora = Date.now()) {
  const vs = vagasAnalisadas();
  const m = carregarModelo();
  const d = demanda(vs, agora);
  const prio = prioridades(vs, m, { agora });
  const fortes = d.itens
    .map((i) => ({ nome: i.nome, provadoEm: i.n - i.nGap, de: vs.length }))
    .filter((i) => i.provadoEm > 0)
    .sort((a, b) => b.provadoEm - a.provadoEm)
    .slice(0, 8);
  const hoje = new Date(agora);
  const semente = hoje.getUTCFullYear() * 10000 + (hoje.getUTCMonth() + 1) * 100 + hoje.getUTCDate();
  const explorar = prioridades(vs, m, { agora, explorar: true, rng: rngSemente(semente) })[0] || null;
  return {
    totalVagas: vs.length, lacunas: prio.slice(0, 12), fortes,
    sugestaoDoDia: explorar && { nome: explorar.nome, ponte: explorar.ponte, observacoes: explorar.observacoes },
    modelo: { modo: m.modo(), n: m.n },
  };
}

function gerarPlano(agora = Date.now()) {
  const p = padroes(agora);
  if (!p.totalVagas) throw erro(400, 'Analise ao menos uma vaga antes de gerar o plano.');
  const m = carregarModelo();
  const L = [];
  L.push('TRÊS LACUNAS PARA ATACAR');
  p.lacunas.slice(0, 3).forEach((g, i) => {
    const imp = g.observacoes >= 3 ? `; nos seus desfechos, faltar isso pesou ${g.impactoAprendido.toFixed(1)}` : '; ainda sem desfechos suficientes para medir o impacto';
    const tend = g.tendencia != null && g.tendencia > 0.1 ? '; em alta nas vagas recentes' : '';
    L.push(`${i + 1}. ${g.nome}: falta prova em ${Math.round(g.demanda * 100)}% das vagas${g.obrigatorio ? `, obrigatório em ${g.obrigatorio}` : ''}${imp}${tend}.`);
  });
  const topo = p.lacunas[0];
  L.push('', 'PROJETO DA SEMANA');
  if (topo) {
    L.push(`${topo.nome}: ${topo.ponte ? topo.ponte.projeto : 'construa um projeto pequeno e publicável que use isso de ponta a ponta.'} (~${topo.horas} h)`);
    L.push('Dia 1: definir escopo e dados. Dia 2: núcleo funcionando. Dia 3: testes e caso real. Dia 4: README com decisões e limites. Dia 5: publicar no GitHub e registrar a evidência no Pontes.');
  }
  const vs = store.vagas.listar().filter((v) => v.requisitos.length && ['interesse', 'candidatado'].includes(v.status));
  const pontuadas = vs.map((v) => ({ v, ad: aderencia(v), p: m.predict(featuresDe(v)) })).sort((a, b) => b.p - a.p);
  L.push('', 'VAGAS PARA PRIORIZAR');
  pontuadas.slice(0, 3).forEach((x) => L.push(`- ${x.v.titulo || 'Vaga'} — ${x.v.empresa || '?'}: aderência ${Math.round(x.ad)}%, chance estimada de avançar ${Math.round(x.p * 100)}%.`));
  if (!pontuadas.length) L.push('- Nenhuma vaga aberta analisada.');
  const adiar = pontuadas.filter((x) => x.ad < 40).slice(-2);
  L.push('', 'VAGAS PARA ADIAR ATÉ FECHAR A LACUNA');
  adiar.forEach((x) => L.push(`- ${x.v.titulo || 'Vaga'} — ${x.v.empresa || '?'}: aderência ${Math.round(x.ad)}%.`));
  if (!adiar.length) L.push('- Nenhuma abaixo de 40% de aderência.');
  if (m.modo() === 'a-priori') L.push('', `Observação: o modelo ainda usa premissas iniciais. Faltam ${MIN_OBSERVACOES_CONFIAVEL - m.n} desfechos registrados para ele passar a aprender só com os seus dados.`);
  const plano = { texto: L.join('\n'), geradoEm: agora };
  const perfil = store.perfil.obter();
  store.perfil.salvar({ ...perfil, plano });
  return plano;
}

function efeitoPontes() {
  const vs = vagasAnalisadas();
  return store.evidencias.listar().filter((e) => e.origemPonte).map((e) => {
    const chave = canon(e.origemPonte);
    const nota = (r) => (r.status === 'verde' ? 1 : r.status === 'amarelo' ? 0.5 : 0);
    const antes = [];
    const depois = [];
    for (const v of vs) {
      const r = v.requisitos.find((q) => canon(q.nome) === chave);
      if (r) (v.criadoEm < e.criadoEm ? antes : depois).push(nota(r));
    }
    const media = (a) => (a.length ? Number((a.reduce((s, x) => s + x, 0) / a.length).toFixed(2)) : null);
    return { ponte: e.origemPonte, concluidaEm: e.criadoEm, vagasAntes: antes.length, vagasDepois: depois.length, provaAntes: media(antes), provaDepois: media(depois) };
  });
}

function aprendizado() {
  const m = carregarModelo();
  const prev = resumoPrequential(store.previsoes.todas());
  const passo = Math.max(1, Math.ceil(prev.serie.length / 60));
  const feats = Object.keys(m.w).filter((k) => k.startsWith('gap:') && (m.nf[k] || 0) >= 2)
    .map((k) => ({ nome: k.slice(4), peso: Number(m.w[k].toFixed(2)), observacoes: m.nf[k] }));
  const ev = store.eventos.recentes(200);
  return {
    modelo: {
      modo: m.modo(), n: m.n, positivos: m.positivos, confianca: Number(m.confianca().toFixed(2)),
      faltam: Math.max(0, MIN_OBSERVACOES_CONFIAVEL - m.n), atualizadoEm: store.modelo.atualizadoEm(),
    },
    avaliacao: { n: prev.n, brierModelo: prev.brierModelo, brierBase: prev.brierBase, serie: prev.serie.filter((_, i) => i % passo === 0 || i === prev.serie.length - 1) },
    lacunasQuePesam: feats.filter((f) => f.peso < 0).sort((a, b) => a.peso - b.peso).slice(0, 8),
    lacunasNeutras: feats.filter((f) => f.peso >= 0).sort((a, b) => b.peso - a.peso).slice(0, 5),
    casamento: {
      ajustes: Object.keys(store.ajustes.todos()).length,
      confirmacoes: ev.filter((e) => e.tipo === 'confirmou').length,
      rejeicoes: ev.filter((e) => e.tipo === 'rejeitou').length,
    },
    pontes: efeitoPontes(),
    eventos: ev.slice(0, 20),
  };
}

/* ---------- carta ---------- */
async function gerarCarta(id) {
  const v = store.vagas.obter(id);
  if (!v) throw erro(404, 'Vaga não encontrada.');
  if (!v.requisitos.length) throw erro(400, 'Analise a vaga antes de redigir a carta.');
  const evid = store.evidencias.listar();
  const perfil = store.perfil.obter();
  const reqs = v.requisitos.filter((r) => r.tipo !== 'ruido').map((r) => `- ${r.nome} (${r.tipo}, ${r.status})${r.evidencias.length ? ' provas: ' + r.evidencias.join(',') : ''}`).join('\n');
  const user = `Escreva uma carta de apresentação curta (até 200 palavras) para a vaga abaixo, no idioma do anúncio.
Regras: use apenas as EVIDÊNCIAS listadas, sem inventar experiência; destaque os 2 ou 3 requisitos obrigatórios que a pessoa prova melhor; se houver lacuna obrigatória, diga em uma frase honesta o que já fez de adjacente e que está fechando a lacuna; tom direto e profissional; sem clichês; só o texto da carta, sem markdown.

=== PERFIL ===
Alvo salarial: ${perfil.alvo || 'não informado'}
Lacunas declaradas: ${(perfil.lacunas || []).join(', ') || 'nenhuma'}
Observações: ${perfil.obs || 'nenhuma'}

=== EVIDÊNCIAS ===
${evid.map((e) => `[${e.id}] ${e.skill} | ${e.nivel} | ${e.prova}`).join('\n')}

${contextoFontes(perfil)}
=== ANÁLISE ===
${reqs}

=== VAGA ===
${v.titulo} — ${v.empresa}
${v.texto.slice(0, 8000)}`;
  return (await llm.chamar({ system: 'Você redige cartas de apresentação honestas e objetivas.', user, maxTokens: 1200 })).trim();
}

function salvarPerfil(d) {
  const atual = store.perfil.obter();
  const novo = {
    ...atual, alvo: txt(d.alvo, 160), obs: txt(d.obs, 800),
    lacunas: (Array.isArray(d.lacunas) ? d.lacunas : String(d.lacunas || '').split(',')).map((s) => txt(s, 60)).filter(Boolean).slice(0, 30),
  };
  store.perfil.salvar(novo);
  return novo;
}


/* ---------- fontes do perfil: currículo, LinkedIn, portfólios ---------- */
const urlFonte = (u) => { const t = txt(u, 400); return /^https?:\/\//i.test(t) ? t : (t && /^[\w.-]+\.[a-z]{2,}/i.test(t) ? 'https://' + t : ''); };

function obterFontes() {
  const f = store.perfil.obter().fontes || {};
  return {
    curriculo: f.curriculo || { texto: '', nome: '' },
    linkedin: f.linkedin || { url: '', texto: '' },
    portfolios: f.portfolios || [],
  };
}

function salvarFontes(d) {
  const p = store.perfil.obter();
  const atual = obterFontes();
  const lista = (Array.isArray(d.portfolios) ? d.portfolios : String(d.portfolios || '').split(/[\n,;]+/)).map(urlFonte).filter(Boolean);
  const unicos = Array.from(new Set(lista)).slice(0, fontes.MAX_PORTFOLIOS);
  const texto = (v) => fontes.normaliza(v);
  p.fontes = {
    curriculo: { texto: texto(d.curriculoTexto), nome: txt(d.curriculoNome, 120), em: Date.now() },
    linkedin: { url: urlFonte(d.linkedinUrl), texto: texto(d.linkedinTexto), em: Date.now() },
    // mantém o que já foi lido para os endereços que continuam na lista
    portfolios: unicos.map((url) => atual.portfolios.find((x) => x.url === url) || { url }),
  };
  store.perfil.salvar(p);
  store.eventos.registrar('fontes', null, { curriculo: p.fontes.curriculo.texto.length, linkedin: p.fontes.linkedin.texto.length, portfolios: unicos.length });
  return obterFontes();
}

function textoDeArquivo(buf, nome) {
  return { texto: fontes.textoDeArquivo(buf, nome), nome: txt(nome, 120) };
}

async function lerPortfolios() {
  const p = store.perfil.obter();
  const lista = (p.fontes && p.fontes.portfolios) || [];
  if (!lista.length) throw erro(400, 'Adicione ao menos um endereço de portfólio e salve.');
  const lidos = [];
  for (const it of lista) lidos.push(await fontes.lerPortfolio(it.url));
  p.fontes.portfolios = lidos;
  store.perfil.salvar(p);
  return obterFontes();
}

async function proporEvidencias() {
  return fontes.propor(store.perfil.obter(), store.evidencias.listar());
}

function aplicarProposta(d) {
  const lista = Array.isArray(d.evidencias) ? d.evidencias.slice(0, 60) : [];
  const existentes = new Set(store.evidencias.listar().map((e) => canon(e.skill)));
  let criadas = 0;
  for (const e of lista) {
    let dados;
    try { dados = validarEvidencia(e); } catch { continue; }
    if (existentes.has(canon(dados.skill))) continue;
    existentes.add(canon(dados.skill));
    store.evidencias.criar(dados);
    criadas += 1;
  }
  if (criadas) store.eventos.registrar('evidencias_importadas', null, { n: criadas });
  let cvPreenchido = [];
  if (d.preencherCv && d.cv && typeof d.cv === 'object') {
    const p = store.perfil.obter();
    const atual = p.cv || {};
    const lim = { nome: 120, titulo: 160, cidade: 80, email: 120, telefone: 40, linkedin: 160, github: 160, resumo: 1200, experiencias: 8000, formacao: 3000, idiomas: 300 };
    const novo = { ...atual };
    for (const k of Object.keys(lim)) {
      if (!txt(atual[k], lim[k]) && txt(d.cv[k], lim[k])) { novo[k] = txt(d.cv[k], lim[k]); cvPreenchido.push(k); }
    }
    p.cv = novo;
    store.perfil.salvar(p);
  }
  const impacto = criadas ? rematchTodas().filter((i) => i.novasSugestoes > 0) : [];
  return { criadas, cvPreenchido, impacto };
}

/* ---------- currículo e radar ---------- */
function salvarCurriculo(d) {
  const p = store.perfil.obter();
  const c = (k, n) => txt(d[k], n);
  p.cv = {
    nome: c('nome', 120), titulo: c('titulo', 160), cidade: c('cidade', 80), email: c('email', 120), telefone: c('telefone', 40),
    linkedin: c('linkedin', 160), github: c('github', 160), resumo: c('resumo', 1200),
    experiencias: c('experiencias', 8000), formacao: c('formacao', 3000), idiomas: c('idiomas', 300),
  };
  store.perfil.salvar(p);
  return p.cv;
}

function gerarCurriculo(formato, vagaId) {
  const vaga = vagaId ? store.vagas.obter(vagaId) : null;
  if (vagaId && !vaga) throw erro(404, 'Vaga não encontrada.');
  const m = curriculoMod.montar({ perfil: store.perfil.obter(), evidencias: store.evidencias.listar(), vaga });
  if (m.nome === 'Seu nome') throw erro(400, 'Preencha seu nome na aba Currículo antes de gerar o arquivo.');
  const f = String(formato || 'docx');
  if (f === 'docx') return { tipo: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', corpo: curriculoMod.docx(m), arquivo: curriculoMod.nomeDoArquivo(m, 'docx') };
  if (f === 'md') return { tipo: 'text/markdown; charset=utf-8', corpo: Buffer.from(curriculoMod.markdown(m), 'utf8'), arquivo: curriculoMod.nomeDoArquivo(m, 'md') };
  if (f === 'html') return { tipo: 'text/html; charset=utf-8', corpo: Buffer.from(curriculoMod.html(m), 'utf8'), arquivo: curriculoMod.nomeDoArquivo(m, 'html'), inline: true };
  throw erro(400, 'Formato inválido. Use docx, html ou md.');
}

const SITES_PROIBIDOS = /(^|\.)(linkedin|indeed|glassdoor)\./i;
function paginasExtras(v) {
  const urls = (Array.isArray(v) ? v : String(v || '').split(/\n+/)).map((x) => txt(x, 400)).filter(Boolean);
  const out = [];
  for (const u of urls) {
    let url;
    try { url = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u); } catch { throw erro(400, `Endereço inválido nas páginas de busca: ${u.slice(0, 60)}`); }
    if (SITES_PROIBIDOS.test(url.hostname)) throw erro(400, `${url.hostname} não é permitido: os termos de uso do site proíbem a leitura automática.`);
    out.push(url.toString());
  }
  return Array.from(new Set(out)).slice(0, 6);
}

function salvarRadar(d) {
  const p = store.perfil.obter();
  const lista = (v, max) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((x) => txt(x, 80)).filter(Boolean).slice(0, max);
  const num = (v, lo, hi, def) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
  p.radar = {
    ativo: d.ativo !== false && d.ativo !== 'false',
    consultas: lista(d.consultas, 6), consultasEn: lista(d.consultasEn, 4), excluir: lista(d.excluir, 12),
    gupy: d.gupy !== false && d.gupy !== 'false', remotive: d.remotive !== false && d.remotive !== 'false',
    paginasExtras: paginasExtras(d.paginasExtras),
    jobgether: d.jobgether !== false && d.jobgether !== 'false',
    maxNovas: num(d.maxNovas, 1, 40, radar.PADRAO.maxNovas), analisarTop: num(d.analisarTop, 0, 8, radar.PADRAO.analisarTop), diasMax: num(d.diasMax, 1, 60, radar.PADRAO.diasMax),
  };
  store.perfil.salvar(p);
  return p.radar;
}

/** Testa UMA página de busca sem importar nada: devolve as primeiras vagas ou o motivo exato da falha. */
async function testarPagina(u) {
  const [url] = paginasExtras(u);
  if (!url) throw erro(400, 'Informe o endereço da página.');
  try {
    const vagas = await require('./paginas').buscarPagina(url, { pausaMs: 500, maxDetalhes: 3 });
    return { ok: true, url, total: vagas.length, amostra: vagas.slice(0, 5).map((v) => ({ titulo: v.titulo, empresa: v.empresa, local: v.local })) };
  } catch (e) {
    return { ok: false, url, motivo: e.response ? `o site respondeu HTTP ${e.response.status}` : e.message };
  }
}

function estadoRadar() {
  const p = store.perfil.obter();
  let ultimo = p.radarUltimo || null;
  if (ultimo && (ultimo.novas || []).length) {
    // Situação atual de cada vaga importada: a aderência real (após a análise) substitui a pré-triagem na tela.
    const atual = new Map(listarVagas().map((v) => [v.id, v]));
    ultimo = { ...ultimo, novas: ultimo.novas.map((n) => {
      const v = atual.get(n.id);
      return { ...n, existe: !!v, analisada: !!(v && v.analisada), aderencia: v && v.analisada ? v.aderencia : null, pAvancar: v ? v.pAvancar : null };
    }).filter((n) => n.existe) };
  }
  return { config: radar.configuracao(), ultimo, proxima: '08:30 (horário de Brasília)', emExecucao: radar.emExecucao() };
}

function iniciar() {
  store.init();
  const cron = require('node-cron');
  cron.schedule('15 3 * * *', () => {
    try { expirarSemRetorno(); } catch (e) { console.error('[PONTES] expirar falhou:', e.message); }
  });
  cron.schedule('30 8 * * *', () => {
    radar.executar().catch((e) => console.error('[PONTES] radar falhou:', e.message));
  }, { timezone: 'America/Sao_Paulo' });
  console.log('[PONTES] Módulo iniciado (aprendizado online ativo)');
}

module.exports = {
  iniciar, STATUS, ETAPAS, MOTIVOS, NIVEIS,
  criarEvidencia, atualizarEvidencia: (id, d) => store.evidencias.atualizar(id, validarEvidencia(d)),
  criarVaga, atualizarVaga, excluirVaga, analisarVaga, listarVagas, detalhe, gerarCarta,
  responderSugestao, rematchTodas, expirarSemRetorno, reconstruir,
  padroes, gerarPlano, aprendizado, salvarPerfil, erro,
  salvarCurriculo, gerarCurriculo, salvarRadar, obterFontes, salvarFontes, textoDeArquivo, lerPortfolios, proporEvidencias, aplicarProposta, estadoRadar, testarPagina, executarRadar: (o) => radar.executar(o),
  iniciarRadarAgora() {
    if (radar.emExecucao()) return { emExecucao: true };
    radar.executar({ manual: true }).catch((e) => console.error('[PONTES] radar falhou:', e.message));
    return { emExecucao: true };
  },
};
