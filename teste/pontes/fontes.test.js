'use strict';
/** Fontes do perfil: arquivos, portfólios (com proteção SSRF), proposta de evidências pela IA e aplicação. */
const test = require('node:test');
const assert = require('node:assert/strict');

const Database = require('better-sqlite3');
const dbMem = new Database(':memory:');
const dbPath = require.resolve('../../src/models/database');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => dbMem } };

const axios = require('axios');
const store = require('../../src/pontes/store');
const llm = require('../../src/pontes/llm');
const svc = require('../../src/pontes/service');
const fontes = require('../../src/pontes/fontes');
const cv = require('../../src/pontes/curriculo');
store.init(dbMem);

test('arquivos: docx gerado pelo próprio app volta como texto; txt/md ok; formato inválido recusado', () => {
  const m = cv.montar({ perfil: { cv: { nome: 'Ana Souza', resumo: 'Engenheira de dados com acentuação: ação.', experiencias: 'Analista — Acme (2020)\n- Pipelines Airflow' } }, evidencias: [], vaga: null });
  const t = fontes.textoDeArquivo(cv.docx(m), 'cv.docx');
  assert.ok(t.includes('Ana Souza') && t.includes('acentuação: ação.') && t.includes('Pipelines Airflow'));
  assert.ok(fontes.textoDeArquivo(Buffer.from('# Meu perfil\nTrabalho com SQL e Python há 5 anos em dados.'), 'x.md').includes('SQL'));
  assert.throws(() => fontes.textoDeArquivo(Buffer.from('abc'), 'x.exe'), /não suportado/);
  assert.throws(() => fontes.textoDeArquivo(Buffer.from('curto'), 'x.txt'), /extrair texto/);
  assert.throws(() => fontes.textoDeArquivo(Buffer.from('não é zip'), 'x.docx'), /inválido/);
});

test('segurança: endereços internos, protocolos e LinkedIn são recusados sem derrubar nada', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.equal(fontes.ipPrivado(ip), true, ip);
  assert.equal(fontes.ipPrivado('93.184.216.34'), false);
  await assert.rejects(fontes.validarDestino('http://localhost:3000/'), /não permitido|ENOTFOUND|EAI/i);
  await assert.rejects(fontes.validarDestino('http://127.0.0.1:3000/'), /não permitido/);
  await assert.rejects(fontes.validarDestino('http://169.254.169.254/latest/meta-data'), /não permitido/);
  await assert.rejects(fontes.validarDestino('ftp://x.com/a'), /http/);
  await assert.rejects(fontes.validarDestino('https://www.linkedin.com/in/fulano'), /LinkedIn/);
  const r = await fontes.lerPortfolio('http://10.1.1.1/admin');
  assert.ok(r.erro && !r.texto, 'erro devolvido, não lançado');
});

test('portfólio: site comum vira texto; GitHub usa a API; redirecionamento para rede interna é barrado', async () => {
  const orig = axios.get;
  try {
    axios.get = async (url) => {
      if (url.startsWith('https://api.github.com/users/ana/repos')) return { status: 200, data: [{ name: 'pipeline-delta', description: 'Pipeline medalhão com Delta Lake', language: 'Python', topics: ['spark'], html_url: 'https://github.com/ana/pipeline-delta', fork: false }, { name: 'fork', fork: true }] };
      if (url.startsWith('https://api.github.com/users/ana')) return { status: 200, data: { login: 'ana', name: 'Ana', bio: 'Dados', public_repos: 7 } };
      if (url.includes('/readme')) return { status: 404, data: '' };
      if (url === 'http://93.184.216.34/') return { status: 200, headers: { 'content-type': 'text/html' }, data: '<html><title>Portfólio da Ana</title><script>x=1</script><body><h1>Projetos</h1><p>Construí pipelines com Airflow e Spark em produção.</p></body></html>' };
      if (url === 'http://93.184.216.34/redir') return { status: 302, headers: { location: 'http://10.0.0.9/segredo' }, data: '' };
      throw new Error('inesperado ' + url);
    };
    const site = await fontes.lerPortfolio('http://93.184.216.34/');
    assert.ok(site.texto.includes('Portfólio da Ana') && site.texto.includes('pipelines com Airflow') && !site.texto.includes('x=1'));
    const gh = await fontes.lerPortfolio('https://github.com/ana');
    assert.ok(gh.texto.includes('pipeline-delta: Pipeline medalhão com Delta Lake') && !gh.texto.includes('fork'));
    const redir = await fontes.lerPortfolio('http://93.184.216.34/redir');
    assert.match(redir.erro, /não permitido/);
  } finally { axios.get = orig; }
});

test('fontes: salvar mantém leituras, contexto entra na análise (sem valer como prova)', async () => {
  const f = svc.salvarFontes({ curriculoTexto: 'Engenheira de dados com 6 anos de SQL, Airflow e Spark em bancos.', curriculoNome: 'cv.pdf', linkedinUrl: 'linkedin.com/in/ana', linkedinTexto: 'Sobre: dados e pipelines.', portfolios: 'github.com/ana\nhttps://github.com/ana\nsite.com/x' });
  assert.deepEqual(f.portfolios.map((p) => p.url), ['https://github.com/ana', 'https://site.com/x']);
  assert.equal(f.linkedin.url, 'https://linkedin.com/in/ana');
  const p = store.perfil.obter(); p.fontes.portfolios[0].texto = 'Perfil GitHub ana: repositórios de pipelines'; store.perfil.salvar(p);
  const f2 = svc.salvarFontes({ curriculoTexto: f.curriculo.texto, linkedinTexto: f.linkedin.texto, portfolios: 'https://github.com/ana' });
  assert.ok(f2.portfolios[0].texto, 'leitura anterior preservada para o mesmo endereço');

  let visto = '';
  const antes = llm.chamar;
  llm.chamar = async ({ user }) => { visto = user; return JSON.stringify({ empresa: 'X', titulo: 'T', requisitos: [{ nome: 'SQL', tipo: 'obrigatorio', status: 'verde', evidencias: [], nota: '' }] }); };
  const vaga = svc.criarVaga({ texto: 'Vaga que exige SQL e Airflow com experiência comprovada em produção de dados.' });
  const d = await svc.analisarVaga(vaga);
  llm.chamar = antes;
  assert.ok(visto.includes('CONTEXTO DO PERFIL') && visto.includes('6 anos de SQL'));
  assert.notEqual(d.requisitos[0].status, 'verde', 'contexto não vira prova: sem id de evidência não há verde');
});

test('proposta por IA: filtra repetidas, links inventados e níveis inválidos; aplicar cria só o aprovado e preenche só o vazio', async () => {
  svc.criarEvidencia({ skill: 'SQL', nivel: 'Avançado', prova: 'já existe' });
  const pf = store.perfil.obter();
  pf.fontes = { curriculo: { texto: 'Currículo da Ana com Airflow e Delta Lake.' }, linkedin: { texto: '' }, portfolios: [{ url: 'https://github.com/ana', texto: '- pipeline-delta: medalhão | https://github.com/ana/pipeline-delta' }] };
  store.perfil.salvar(pf);
  const antes = llm.chamar;
  llm.chamar = async () => '```json\n' + JSON.stringify({
    cv: { nome: 'Ana Souza', titulo: 'Engenheira de Dados', resumo: 'Resumo da IA', experiencias: 'Analista — Acme (2020 – 2024)\n- Pipelines', formacao: '', idiomas: 'Inglês técnico' },
    evidencias: [
      { skill: 'sql', nivel: 'Avançado', prova: 'repetida' },
      { skill: 'Apache Airflow', nivel: 'Mestre', prova: 'DAGs em produção na Acme', link: 'https://github.com/ana/pipeline-delta', fonte: 'portfolio' },
      { skill: 'Delta Lake', nivel: 'Intermediário', prova: 'Medalhão', link: 'https://inventado.example/x', fonte: 'curriculo' },
      { skill: 'Delta Lake', prova: 'duplicada na resposta' },
      { skill: '', prova: 'sem nome' },
    ],
  }) + '\n```';
  try {
    const prop = await svc.proporEvidencias();
    assert.deepEqual(prop.evidencias.map((e) => e.skill), ['Apache Airflow', 'Delta Lake']);
    assert.equal(prop.evidencias[0].link, 'https://github.com/ana/pipeline-delta', 'link presente na fonte é mantido');
    assert.equal(prop.evidencias[1].link, '', 'link que não está nas fontes é descartado');
    assert.equal(prop.cv.nome, 'Ana Souza');

    const pc = store.perfil.obter(); pc.cv = { nome: '', titulo: 'Título que já escrevi' }; store.perfil.salvar(pc);
    const r = svc.aplicarProposta({ evidencias: [prop.evidencias[0], { skill: 'sql' }, { skill: '' }], preencherCv: true, cv: prop.cv });
    assert.equal(r.criadas, 1, 'só a nova; a repetida e a vazia ficam de fora');
    assert.ok(r.cvPreenchido.includes('nome') && !r.cvPreenchido.includes('titulo'));
    assert.equal(store.perfil.obter().cv.titulo, 'Título que já escrevi', 'o que você escreveu não é sobrescrito');
    assert.ok(store.evidencias.listar().some((e) => e.skill === 'Apache Airflow' && e.nivel === 'Não definido'), 'nível inválido vira Não definido');
  } finally { llm.chamar = antes; }
});

test('proposta: exige ao menos uma fonte', async () => {
  const p = store.perfil.obter(); p.fontes = { curriculo: { texto: '' }, linkedin: { texto: '' }, portfolios: [] }; store.perfil.salvar(p);
  await assert.rejects(svc.proporEvidencias(), /Adicione ao menos/);
});

test('JSON cortado pela IA: recupera os itens completos e descarta o que ficou pela metade', () => {
  const cortado = '```json\n{"evidencias":[{"skill":"Airflow","nivel":"Básico","prova":"DAGs na Acme"},{"skill":"Spark","nivel":"Inter';
  const j = llm.extrairJson(cortado);
  assert.deepEqual(j.evidencias.map((e) => e.skill), ['Airflow']);
  assert.deepEqual(llm.extrairJson('{"a":[1,2,{"b":"x\\"y"}],"c":"truncad').a.length, 3);
  assert.throws(() => llm.extrairJson('sem json nenhum'), /JSON/);
  assert.equal(llm.repararJson('{"a":"sem fechamento'), null);
});

test('proposta: resposta cortada ainda rende as evidências completas; falha no currículo não derruba as evidências', async () => {
  const pf = store.perfil.obter();
  pf.fontes = { curriculo: { texto: 'Trabalho com Airflow e Spark em bancos há anos.' }, linkedin: { texto: '' }, portfolios: [] };
  store.perfil.salvar(pf);
  const antes = llm.chamar;
  let chamadas = 0;
  llm.chamar = async ({ user }) => {
    chamadas += 1;
    if (user.includes('SÓ os dados para montar o currículo')) return 'isto não é json';
    return '{"evidencias":[{"skill":"Terraform","nivel":"Básico","prova":"IaC em projeto"},{"skill":"Spark","nivel":"Inter';
  };
  try {
    const prop = await svc.proporEvidencias();
    assert.equal(chamadas, 2, 'duas chamadas menores');
    assert.deepEqual(prop.evidencias.map((e) => e.skill), ['Terraform']);
    assert.equal(prop.cv.nome, '', 'currículo ilegível vira campos vazios, sem erro');
    llm.chamar = async () => 'lixo';
    await assert.rejects(svc.proporEvidencias(), /legível/);
  } finally { llm.chamar = antes; }
});
