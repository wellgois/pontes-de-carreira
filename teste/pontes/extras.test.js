'use strict';
/** Currículo (docx/html/md) e radar diário, com SQLite em memória e fontes/LLM simulados. */
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const Database = require('better-sqlite3');
const dbMem = new Database(':memory:');
const dbPath = require.resolve('../../src/models/database');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => dbMem } };

const store = require('../../src/pontes/store');
const llm = require('../../src/pontes/llm');
const svc = require('../../src/pontes/service');
const radar = require('../../src/pontes/radar');
const cv = require('../../src/pontes/curriculo');

store.init(dbMem);
llm.chamar = async () => JSON.stringify({
  empresa: 'X', titulo: 'T', faixa_salarial: '', resumo: 'ok', sinais_risco: [],
  requisitos: [{ nome: 'SQL', tipo: 'obrigatorio', status: 'vermelho', evidencias: [], nota: '' }],
});

/** Lê entradas de um zip (só o necessário para validar o docx). */
function lerZip(buf) {
  const out = {};
  let fim = buf.length - 22;
  while (fim >= 0 && buf.readUInt32LE(fim) !== 0x06054b50) fim -= 1;
  const n = buf.readUInt16LE(fim + 10);
  let p = buf.readUInt32LE(fim + 16);
  for (let i = 0; i < n; i++) {
    const comp = buf.readUInt32LE(p + 20), tam = buf.readUInt32LE(p + 24), crc = buf.readUInt32LE(p + 16);
    const nl = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const nome = buf.slice(p + 46, p + 46 + nl).toString('utf8');
    const ln = buf.readUInt16LE(off + 26), le = buf.readUInt16LE(off + 28);
    const dados = zlib.inflateRawSync(buf.slice(off + 30 + ln + le, off + 30 + ln + le + comp));
    assert.equal(dados.length, tam, 'tamanho descompactado confere');
    assert.equal(cv.crc32(dados), crc, 'crc confere');
    out[nome] = dados.toString('utf8');
    p += 46 + nl;
  }
  return out;
}

test('currículo: dados, ordem por vaga, revisar fora, escape e docx íntegro', async () => {
  svc.salvarCurriculo({
    nome: 'Ana <Teste> & Cia', titulo: 'Engenheira de Dados', email: 'ana@x.com', resumo: 'Resumo curto.',
    experiencias: 'Analista — Acme (2020 – 2024)\n- Construiu pipelines\n- Reduziu custo em 30%\n\nEstagiária — Beta (2019)\n- Suporte',
    formacao: 'Pós em Engenharia de Dados — Instituto X',
  });
  const e1 = svc.criarEvidencia({ skill: 'Apache Airflow', nivel: 'Intermediário', prova: 'DAGs em produção' });
  const e2 = svc.criarEvidencia({ skill: 'SQL', nivel: 'Avançado', prova: 'Modelagem dimensional' });
  const e3 = svc.criarEvidencia({ skill: 'Rascunho de ponte', prova: 'não conferido' });
  dbMem.prepare('UPDATE pontes_evidencias SET revisar=1 WHERE id=?').run(e3.id);

  const vagaId = svc.criarVaga({ texto: 'Vaga que exige Airflow e SQL com bastante experiência prática.', titulo: 'Eng Dados', empresa: 'Acme Corp' });
  const v = store.vagas.obter(vagaId);
  store.vagas.salvarRequisitos(vagaId, [{ nome: 'Airflow', tipo: 'obrigatorio', status: 'verde', evidencias: [e1.id] }, { nome: 'SQL', tipo: 'desejavel', status: 'verde', evidencias: [e2.id] }]);
  assert.ok(v);

  const geral = cv.montar({ perfil: store.perfil.obter(), evidencias: store.evidencias.listar(), vaga: null });
  assert.equal(geral.competencias[0].startsWith('SQL'), true, 'sem vaga: maior nível primeiro');
  assert.ok(!geral.competencias.join().includes('Rascunho'), 'evidência marcada para revisar não entra');
  assert.equal(geral.ocultas, 1);

  const paraVaga = cv.montar({ perfil: store.perfil.obter(), evidencias: store.evidencias.listar(), vaga: store.vagas.obter(vagaId) });
  assert.equal(paraVaga.competencias[0].startsWith('Apache Airflow'), true, 'com vaga: o que prova requisito obrigatório sobe');
  assert.equal(paraVaga.experiencias.length, 2);
  assert.deepEqual(paraVaga.experiencias[0].itens, ['Construiu pipelines', 'Reduziu custo em 30%']);

  const r = svc.gerarCurriculo('docx', vagaId);
  assert.match(r.arquivo, /^curriculo-ana-teste-cia-acme-corp\.docx$/);
  const z = lerZip(r.corpo);
  assert.deepEqual(Object.keys(z).sort(), ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
  assert.ok(z['word/document.xml'].includes('Ana &lt;Teste&gt; &amp; Cia'), 'XML escapado');
  assert.ok(z['word/document.xml'].includes('Reduziu custo em 30%'));

  const html = svc.gerarCurriculo('html').corpo.toString();
  assert.ok(html.includes('Ana &lt;Teste&gt; &amp; Cia') && !html.includes('<Teste>'));
  assert.ok(svc.gerarCurriculo('md').corpo.toString().startsWith('# Ana <Teste> & Cia'));
  assert.throws(() => svc.gerarCurriculo('pdf'), /Formato inválido/);
  assert.throws(() => svc.gerarCurriculo('docx', 9999), /Vaga não encontrada/);
});

test('currículo: exige nome', () => {
  const p = store.perfil.obter(); p.cv = {}; store.perfil.salvar(p);
  assert.throws(() => svc.gerarCurriculo('docx'), /nome/i);
});

test('radar: importa, pontua, não repete, respeita exclusões e lixeira, falha de uma fonte não derruba a outra', async () => {
  const hoje = Date.now();
  const lote = [
    { fonte: 'radar:gupy', titulo: 'Engenheiro de Dados Pleno', empresa: 'Alfa', url: 'https://x.test/1?utm=a', local: 'Rio - RJ', publicadaEm: hoje, texto: 'Procuramos engenheiro de dados com Apache Airflow, SQL e modelagem dimensional para pipelines. ' + 'Você vai construir e manter pipelines de dados, orquestrar cargas e cuidar da qualidade. '.repeat(4) },
    { fonte: 'radar:gupy', titulo: 'Estagiário de Dados', empresa: 'Beta', url: 'https://x.test/2', local: '', publicadaEm: hoje, texto: 'Estágio em dados com SQL e Airflow para pipelines de dados na empresa.' },
    { fonte: 'radar:gupy', titulo: 'Vendedor Externo', empresa: 'Gama', url: 'https://x.test/3', local: '', publicadaEm: hoje, texto: 'Vendas de produtos de limpeza porta a porta com metas mensais e comissão atrativa.' },
    { fonte: 'radar:gupy', titulo: 'Analista de Dados Antigo', empresa: 'Delta', url: 'https://x.test/4', local: '', publicadaEm: hoje - 40 * 86400000, texto: 'Analista com SQL e Airflow, anúncio muito antigo que deve ser ignorado pelo filtro de dias.' },
  ];
  const p = store.perfil.obter(); p.cv = { nome: 'Ana' }; store.perfil.salvar(p);
  svc.salvarRadar({ consultas: 'engenheiro de dados', consultasEn: 'data engineer', excluir: 'estagi, aprendiz', maxNovas: 5, analisarTop: 1 });
  const fontes = {
    gupy: { consultas: (c) => c.consultas, buscar: async () => lote },
    remotive: { consultas: (c) => c.consultasEn, buscar: async () => { throw new Error('fora do ar'); } },
  };
  const r1 = await radar.executar({ fontes, manual: true });
  assert.equal(r1.fontes.remotive.erro, 'fora do ar');
  assert.equal(r1.fontes.gupy.ok, 1);
  const titulos = r1.novas.map((n) => n.titulo);
  assert.ok(titulos.includes('Engenheiro de Dados Pleno'));
  assert.ok(!titulos.includes('Estagiário de Dados'), 'excluído por termo');
  assert.ok(!titulos.includes('Analista de Dados Antigo'), 'excluído por data');
  assert.ok(!titulos.includes('Vendedor Externo'), 'score zero não entra');
  assert.equal(r1.novas[0].titulo, 'Engenheiro de Dados Pleno');
  assert.equal(r1.analisadas.length, 1, 'analisa as primeiras');
  assert.ok(store.vagas.obter(r1.novas[0].id).requisitos.length > 0);
  assert.match(store.vagas.obter(r1.novas[0].id).fonte, /^radar:gupy · Rio - RJ/);

  const r2 = await radar.executar({ fontes, manual: true });
  assert.equal(r2.novas.length, 0, 'segunda rodada não repete');

  svc.excluirVaga(r1.novas[0].id);
  const r3 = await radar.executar({ fontes, manual: true });
  assert.equal(r3.novas.length, 0, 'vaga apagada por você não volta');
  assert.equal(svc.estadoRadar().ultimo.manual, true);
});

test('radar: sem evidências avisa; desligado não roda no agendamento', async () => {
  dbMem.prepare('DELETE FROM pontes_evidencias').run();
  const r = await radar.executar({ fontes: {}, manual: true });
  assert.match(r.erros[0], /evidência/);
  svc.salvarRadar({ ativo: false, consultas: 'x' });
  assert.deepEqual(await radar.executar({ fontes: {} }), { desativado: true });
});

test('radar: bloqueio geográfico penaliza a pré-triagem e a tela usa a aderência real depois da análise', async () => {
  const b = radar.bloqueioGeografico;
  assert.equal(b({ titulo: 'Senior Data Engineer (remote from Portugal or selected EU countries)', texto: 'x', fonte: 'radar:gupy' }), true);
  assert.equal(b({ titulo: 'Data Engineer', texto: 'Requires legal residence in Portugal and work authorization.', fonte: 'radar:gupy' }), true);
  assert.equal(b({ titulo: 'Engenheiro de Dados', texto: 'Atuação 100% remota em todo o Brasil.', fonte: 'radar:gupy' }), false);
  assert.equal(b({ titulo: 'Data Engineer', texto: 'x', fonte: 'radar:remotive', local: 'USA Only' }), true);
  assert.equal(b({ titulo: 'Data Engineer', texto: 'x', fonte: 'radar:remotive', local: 'Worldwide' }), false);

  // estadoRadar: analisada traz aderência; não analisada traz null; apagada some
  const ev = svc.criarEvidencia({ skill: 'Apache Airflow', nivel: 'Avançado', prova: 'DAGs' });
  assert.ok(ev.id);
  svc.salvarRadar({ ativo: true, consultas: 'x', consultasEn: 'y', excluir: '', maxNovas: 5, analisarTop: 1 });
  const longo = (t) => t + ' Você vai construir e manter pipelines de dados com Apache Airflow e cuidar da qualidade. '.repeat(6);
  const fontes = { gupy: { consultas: () => ['q'], buscar: async () => [
    { fonte: 'radar:gupy', titulo: 'Eng Dados A', empresa: 'A', url: 'https://x.test/a', publicadaEm: Date.now(), texto: longo('Vaga A com Apache Airflow.') },
    { fonte: 'radar:gupy', titulo: 'Eng Dados B (remote from Portugal)', empresa: 'B', url: 'https://x.test/b', publicadaEm: Date.now(), texto: longo('Vaga B com Apache Airflow.') },
  ] } };
  const r = await radar.executar({ fontes, manual: true });
  assert.equal(r.novas.length, 2);
  const nb = r.novas.find((n) => n.empresa === 'B');
  assert.equal(nb.bloqueio, true);
  assert.ok(nb.score <= r.novas.find((n) => n.empresa === 'A').score, 'bloqueada fica abaixo');
  const est = svc.estadoRadar().ultimo.novas;
  const a = est.find((n) => n.empresa === 'A'), bb = est.find((n) => n.empresa === 'B');
  assert.equal(a.analisada, true);
  assert.equal(typeof a.aderencia, 'number', 'analisada mostra a aderência real');
  assert.equal(bb.analisada, false);
  assert.equal(bb.aderencia, null, 'não analisada não exibe número de aderência');
  svc.excluirVaga(bb.id);
  assert.ok(!svc.estadoRadar().ultimo.novas.some((n) => n.empresa === 'B'), 'vaga apagada some da lista do radar');
});
