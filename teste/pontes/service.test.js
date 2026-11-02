'use strict';
/**
 * Teste de integração do ciclo completo com SQLite em memória e LLM simulado.
 * Requer better-sqlite3 e express resolvíveis (NODE_PATH ou node_modules).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

const Database = require('better-sqlite3');
const dbMem = new Database(':memory:');
const dbPath = require.resolve('../../src/models/database');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => dbMem } };

const store = require('../../src/pontes/store');
const llm = require('../../src/pontes/llm');
const svc = require('../../src/pontes/service');

store.init(dbMem);

// LLM simulado: lê o texto da vaga e devolve requisitos conforme palavras-chave presentes.
llm.chamar = async ({ user }) => {
  const texto = user.split('=== VAGA ===')[1] || '';
  const catalogo = [
    ['Apache Airflow', /airflow/i, 'obrigatorio'],
    ['Kafka', /kafka/i, 'obrigatorio'],
    ['PySpark', /pyspark|spark/i, 'obrigatorio'],
    ['SQL', /\bsql\b/i, 'obrigatorio'],
    ['Soft skills', /proativ/i, 'ruido'],
  ];
  const requisitos = catalogo.filter(([, re]) => re.test(texto)).map(([nome, , tipo]) => ({
    nome, tipo, status: 'vermelho', evidencias: [], nota: '',
    ...(tipo === 'ruido' ? {} : { ponte: { projeto: `Mini projeto de ${nome}`, horas: 8 } }),
  }));
  return JSON.stringify({ empresa: 'Acme', titulo: 'Engenheiro de Dados Pleno', faixa_salarial: '', resumo: 'ok', sinais_risco: [], requisitos });
};

test('ciclo: evidência -> vaga -> análise -> sugestão local -> confirmação -> desfecho -> aprendizado', async () => {
  const ev = svc.criarEvidencia({ skill: 'PySpark e Delta Lake', prova: 'Pipelines no projeto da pós', nivel: 'Intermediário' });
  assert.ok(ev.id > 0);
  const vagaId = svc.criarVaga({ texto: 'Buscamos engenheiro com PySpark, Apache Airflow, Kafka e SQL. Proativo e comunicativo.', fonte: 'Gupy' });
  const d = await svc.analisarVaga(vagaId);
  assert.equal(d.requisitos.length, 5);
  assert.equal(d.requisitos.find((r) => r.nome === 'PySpark').status, 'vermelho', 'nada vira verde sem confirmação');
  const idxSpark = d.requisitos.findIndex((r) => r.nome === 'PySpark');
  assert.ok(d.requisitos[idxSpark].sugestaoMl, 'o casamento local deve sugerir a evidência de Spark');
  assert.equal(d.requisitos.find((r) => r.nome === 'Kafka').sugestaoMl, undefined);

  const antes = d.aderencia;
  const conf = svc.responderSugestao(vagaId, idxSpark, true);
  assert.equal(conf.requisitos[idxSpark].status, 'verde');
  assert.ok(conf.aderencia > antes);
  assert.ok(Object.keys(require('../../src/pontes/store').ajustes.todos()).length === 1);

  // Candidatura congela as características; recusa na triagem é um desfecho negativo.
  svc.atualizarVaga(vagaId, { status: 'candidatado' });
  assert.equal(svc.aprendizado().modelo.n, 0);
  const r = svc.atualizarVaga(vagaId, { status: 'recusada', etapaRecusa: 'triagem', motivoRecusa: 'tecnico' });
  assert.equal(r.aprendizado.aprendeu, true);
  assert.equal(r.aprendizado.y, 0);
  assert.equal(svc.aprendizado().modelo.n, 1);
  assert.equal(svc.aprendizado().avaliacao.n, 1);

  // Repetir o mesmo desfecho não aprende duas vezes.
  svc.atualizarVaga(vagaId, { motivoRecusa: 'tecnico' });
  assert.equal(svc.aprendizado().modelo.n, 1);

  // Corrigir o desfecho (a recusa foi na etapa técnica, ou seja, houve entrevista) refaz o treino.
  svc.atualizarVaga(vagaId, { etapaRecusa: 'tecnica' });
  const ap = svc.aprendizado();
  assert.equal(ap.modelo.n, 1);
  assert.equal(ap.modelo.positivos, 1);
});

test('nova evidência reavalia as vagas existentes sem custo de IA e informa o ganho potencial', async () => {
  const id = svc.criarVaga({ texto: 'Precisamos de alguém com Apache Airflow para orquestração. SQL avançado.' });
  await svc.analisarVaga(id);
  const antes = svc.detalhe(id);
  assert.equal(antes.requisitos.find((r) => r.nome === 'Apache Airflow').sugestaoMl, undefined);
  const novo = svc.criarEvidencia({ skill: 'Apache Airflow', prova: 'DAGs de ingestão', origemPonte: 'Apache Airflow' });
  const mudou = novo.impacto.find((i) => i.vagaId === id);
  assert.ok(mudou && mudou.potencial > mudou.atual, 'o potencial de aderência deve subir');
  assert.ok(svc.detalhe(id).requisitos.find((r) => r.nome === 'Apache Airflow').sugestaoMl);
  assert.equal(svc.aprendizado().pontes.length, 1);
});

test('rejeitar uma sugestão a remove e ela não volta', async () => {
  const id = svc.criarVaga({ texto: 'Vaga que exige Apache Airflow e Kafka em produção, com SQL.' });
  await svc.analisarVaga(id);
  const idx = svc.detalhe(id).requisitos.findIndex((r) => r.nome === 'Apache Airflow');
  svc.responderSugestao(id, idx, false);
  svc.rematchTodas();
  assert.equal(svc.detalhe(id).requisitos[idx].sugestaoMl, undefined);
});

test('o modelo passa a priorizar a lacuna que os desfechos mostram ser decisiva', async () => {
  // 24 vagas: quem tem Kafka em vermelho é recusado na triagem; as demais avançam.
  for (let i = 0; i < 24; i++) {
    const comKafka = i % 2 === 0;
    const id = svc.criarVaga({ texto: `Vaga ${i}: SQL e PySpark${comKafka ? ' e Kafka' : ''} para engenharia de dados.` });
    await svc.analisarVaga(id);
    svc.atualizarVaga(id, { status: 'candidatado' });
    if (comKafka) svc.atualizarVaga(id, { status: 'recusada', etapaRecusa: 'triagem', motivoRecusa: 'tecnico' });
    else svc.atualizarVaga(id, { status: 'entrevista' });
  }
  const ap = svc.aprendizado();
  assert.equal(ap.modelo.modo, 'aprendido');
  assert.ok(ap.lacunasQuePesam.some((f) => f.nome === 'kafka' && f.peso < -0.3), JSON.stringify(ap.lacunasQuePesam));
  const p = svc.padroes();
  assert.ok(p.lacunas.length > 0);
  const plano = svc.gerarPlano();
  assert.match(plano.texto, /TRÊS LACUNAS PARA ATACAR/);
  assert.match(plano.texto, /Kafka/i);
});

test('sem retorno por muito tempo vira desfecho fraco; reconstruir reproduz o mesmo modelo', async () => {
  const id = svc.criarVaga({ texto: 'Mais uma vaga com SQL e PySpark e Airflow para o time de dados.' });
  await svc.analisarVaga(id);
  svc.atualizarVaga(id, { status: 'candidatado' });
  const nAntes = svc.aprendizado().modelo.n;
  const marcou = svc.expirarSemRetorno(30, Date.now() + 40 * 86400000);
  assert.ok(marcou >= 1);
  assert.equal(svc.aprendizado().modelo.n, nAntes + marcou);
  const m1 = JSON.stringify(store.modelo.carregar().w);
  svc.reconstruir();
  const m2 = JSON.stringify(store.modelo.carregar().w);
  assert.equal(m1, m2, 'reproduzir os desfechos em ordem deve dar o mesmo modelo');
});

test('API HTTP exige autenticação e valida entradas', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { authenticated: req.headers['x-teste'] === 'ok' }; next(); });
  app.use('/api/pontes', require('../../src/routes/pontes'));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/api/pontes`;
  const get = (p, h = {}) => fetch(base + p, { headers: { accept: 'application/json', ...h } });
  try {
    assert.equal((await get('/vagas')).status, 401);
    const ok = await get('/vagas', { 'x-teste': 'ok' });
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(await ok.json()));
    const ruim = await fetch(base + '/vagas', { method: 'POST', headers: { 'content-type': 'application/json', 'x-teste': 'ok' }, body: JSON.stringify({ texto: 'curto' }) });
    assert.equal(ruim.status, 400);
    const idRuim = await get('/vagas/abc', { 'x-teste': 'ok' });
    assert.equal(idRuim.status, 400);
    const status = await fetch(base + '/vagas/1', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-teste': 'ok' }, body: JSON.stringify({ status: 'hackeado' }) });
    assert.equal(status.status, 400);
  } finally {
    srv.close();
  }
});
