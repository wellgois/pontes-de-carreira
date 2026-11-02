'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Matcher, aprender } = require('../../src/pontes/ml/matcher');
const { OutcomeModel, resumoPrequential, sigmoid } = require('../../src/pontes/ml/outcome');
const { demanda, prioridades, rngSemente } = require('../../src/pontes/ml/market');
const { featuresDe, aderencia } = require('../../src/pontes/ml/features');

const EVID = [
  { id: 1, skill: 'Azure Databricks, PySpark, Delta Lake, ADF', prova: 'Pipelines medalhão no projeto X' },
  { id: 2, skill: 'SAP MM e PM', prova: 'Contratos com a Petrobras' },
  { id: 3, skill: 'Desenho de avaliações e rubricas', prova: 'Professor de Matemática' },
];

test('matcher sugere a evidência certa e não inventa para o que não existe', () => {
  const m = new Matcher(EVID);
  assert.equal(m.melhor('PySpark').id, 1);
  assert.equal(m.melhor('SAP').id, 2);
  assert.equal(m.melhor('Kafka'), null);
  assert.equal(m.melhor('Terraform'), null);
});

test('matcher aprende com confirmação e rejeição, e generaliza para nomes parecidos', () => {
  let ajustes = {};
  const antes = new Matcher(EVID, ajustes).rank('Spark SQL').find((r) => r.id === 1).score;
  const conf = aprender(ajustes, 'Spark SQL', 1, true);
  ajustes = { [conf.chave]: conf.valor };
  const depois = new Matcher(EVID, ajustes).rank('Spark SQL').find((r) => r.id === 1).score;
  assert.ok(depois > antes, 'confirmar deve aumentar a pontuação');
  const parecido = new Matcher(EVID, ajustes).rank('Spark  SQL ').find((r) => r.id === 1).score;
  assert.ok(parecido >= depois - 1e-9);
  const rej = aprender(ajustes, 'Spark SQL', 1, false);
  const apos = new Matcher(EVID, { [rej.chave]: rej.valor }).rank('Spark SQL').find((r) => r.id === 1).score;
  assert.ok(apos < depois, 'rejeitar deve reduzir');
  assert.ok(Math.abs(rej.valor) <= 0.6);
});

function vagaSim(rng, lacunas) {
  const nomes = ['Apache Airflow', 'Kafka', 'SQL', 'Python', 'dbt', 'Terraform'];
  const reqs = nomes.map((n) => ({
    nome: n,
    tipo: 'obrigatorio',
    status: lacunas.includes(n) ? 'vermelho' : 'verde',
  }));
  return { titulo: 'Engenheiro de Dados Pleno', requisitos: reqs, sinaisRisco: [], texto: '' };
}

test('modelo online descobre qual lacuna realmente pesa e melhora frente à linha de base', () => {
  const rng = rngSemente(42);
  const m = new OutcomeModel();
  const hist = [];
  let pos = 0;
  for (let i = 0; i < 400; i++) {
    const lac = ['Apache Airflow', 'Kafka', 'dbt', 'Terraform'].filter(() => rng() < 0.4);
    const v = vagaSim(rng, lac);
    // Mundo escondido: faltar Airflow derruba muito a chance; Kafka e os demais são irrelevantes.
    const z = -0.2 - 3.0 * (lac.includes('Apache Airflow') ? 1 : 0);
    const y = rng() < sigmoid(z) ? 1 : 0;
    const x = featuresDe(v);
    const pBase = (pos + 1) / (i + 2);
    const p = m.update(x, y);
    pos += y;
    hist.push({ p, y, pBase });
  }
  const wAir = m.w['gap:apache airflow'];
  const wKaf = m.w['gap:kafka'];
  assert.ok(wAir < -0.8, `peso de Airflow deveria ser claramente negativo (foi ${wAir})`);
  assert.ok(Math.abs(wKaf) < Math.abs(wAir) / 2, 'Kafka deve pesar bem menos que Airflow');
  const fim = resumoPrequential(hist.slice(-150));
  assert.ok(fim.brierModelo < fim.brierBase, `Brier ${fim.brierModelo} deveria vencer a base ${fim.brierBase}`);
  assert.equal(m.modo(), 'aprendido');
  assert.ok(m.confianca() > 0.9);
});

test('modelo serializa e restaura o mesmo estado', () => {
  const m = new OutcomeModel();
  m.update({ aderencia: 0.7, 'gap:x': 1 }, 1);
  const r = new OutcomeModel(JSON.parse(JSON.stringify(m.toJSON())));
  assert.equal(r.predict({ aderencia: 0.7, 'gap:x': 1 }), m.predict({ aderencia: 0.7, 'gap:x': 1 }));
});

test('demanda dá menos peso a vagas antigas e calcula tendência só com amostra mínima', () => {
  const agora = Date.UTC(2026, 10, 2);
  const dia = 86400000;
  const mk = (idade, nomes) => ({
    criadoEm: agora - idade * dia,
    requisitos: nomes.map((n) => ({ nome: n, tipo: 'obrigatorio', status: 'vermelho' })),
  });
  const vagas = [mk(1, ['dbt']), mk(3, ['dbt']), mk(5, ['dbt']), mk(80, ['Kafka']), mk(90, ['Kafka']), mk(100, ['Kafka'])];
  const d = demanda(vagas, agora);
  const dbt = d.itens.find((i) => i.chave === 'dbt');
  const kaf = d.itens.find((i) => i.chave === 'kafka');
  assert.ok(dbt.peso > kaf.peso * 3, 'o que é recente deve pesar bem mais');
  assert.ok(dbt.tendencia > 0.9 && kaf.tendencia < -0.9);
  assert.equal(demanda(vagas.slice(0, 2), agora).itens[0].tendencia, null);
});

test('prioridade põe no topo a lacuna que o modelo aprendeu que prejudica', () => {
  const agora = Date.now();
  const m = new OutcomeModel();
  m.w['gap:airflow'] = -2.5;
  m.nf['gap:airflow'] = 30;
  const mk = (nomes) => ({
    criadoEm: agora - 2 * 86400000,
    requisitos: nomes.map((n) => ({ nome: n, tipo: 'obrigatorio', status: 'vermelho', ponte: { projeto: 'p', horas: 8 } })),
  });
  const vagas = [mk(['Airflow', 'Kafka']), mk(['Kafka']), mk(['Airflow', 'Kafka']), mk(['Kafka'])];
  const sem = prioridades(vagas, new OutcomeModel(), { agora });
  assert.equal(sem[0].chave, 'kafka', 'sem aprendizado, vence quem aparece mais');
  const com = prioridades(vagas, m, { agora });
  assert.equal(com[0].chave, 'airflow', 'com aprendizado, vence quem mais prejudica');
});

test('exploração (Thompson) é reproduzível com a mesma semente e favorece o pouco observado', () => {
  const m = new OutcomeModel();
  const vagas = [{ criadoEm: Date.now(), requisitos: [{ nome: 'dbt', tipo: 'obrigatorio', status: 'vermelho' }] }];
  const a = prioridades(vagas, m, { explorar: true, rng: rngSemente(7) })[0].score;
  const b = prioridades(vagas, m, { explorar: true, rng: rngSemente(7) })[0].score;
  assert.equal(a, b);
});

test('aderência desconsidera ruído e simula lacuna fechada', () => {
  const v = {
    requisitos: [
      { nome: 'SQL', tipo: 'obrigatorio', status: 'verde' },
      { nome: 'Kafka', tipo: 'obrigatorio', status: 'vermelho' },
      { nome: 'Soft skills', tipo: 'ruido', status: 'vermelho' },
    ],
  };
  assert.equal(aderencia(v), 50);
  assert.equal(aderencia(v, new Set(['kafka'])), 100);
  assert.ok(featuresDe(v)['gap:kafka'] === 1 && !('gap:soft skills' in featuresDe(v)));
});
