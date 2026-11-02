'use strict';
/** Páginas de busca de outros sites (Jobgether, BeBee…): robots.txt, JobPosting (JSON-LD), segurança e integração ao radar. */
const test = require('node:test');
const assert = require('node:assert/strict');

const Database = require('better-sqlite3');
const dbMem = new Database(':memory:');
const dbPath = require.resolve('../../src/models/database');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => dbMem } };

const axios = require('axios');
const store = require('../../src/pontes/store');
const svc = require('../../src/pontes/service');
const radar = require('../../src/pontes/radar');
const pg = require('../../src/pontes/paginas');
store.init(dbMem);

const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const vaga = (t, extra = {}) => ({ '@context': 'https://schema.org', '@type': 'JobPosting', title: t, description: `<p>${t}: pipelines com Apache Airflow e SQL em produção.</p>`.repeat(3), datePosted: new Date().toISOString(), hiringOrganization: { '@type': 'Organization', name: 'Acme' }, ...extra });

function mockarWeb(rotas) {
  const orig = axios.get;
  axios.get = async (url) => {
    for (const [re, fn] of rotas) if (re.test(url)) return fn(url);
    const e = new Error('404'); e.response = { status: 404 }; throw e;
  };
  return () => { axios.get = orig; };
}
const ok = (data, tipo = 'text/html') => ({ status: 200, headers: { 'content-type': tipo }, data });

test('robots.txt: regra mais específica vence, curingas, agente do app e ausência de regras', () => {
  const g = pg.parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.json$\n\nUser-agent: BadBot\nDisallow: /\n');
  assert.equal(pg.permitidoPorRobots(g, '/jobs?q=dados'), true);
  assert.equal(pg.permitidoPorRobots(g, '/private/x'), false);
  assert.equal(pg.permitidoPorRobots(g, '/private/ok/1'), true);
  assert.equal(pg.permitidoPorRobots(g, '/api/a.json'), false);
  assert.equal(pg.permitidoPorRobots(pg.parseRobots('User-agent: *\nDisallow: /\n'), '/qualquer'), false);
  assert.equal(pg.permitidoPorRobots(pg.parseRobots('User-agent: *\nDisallow:\n'), '/qualquer'), true);
  assert.equal(pg.permitidoPorRobots(pg.parseRobots(''), '/x'), true);
});

test('rótulo do site a partir do endereço', () => {
  assert.equal(pg.rotuloDe('https://jobgether.com/search?q=x'), 'jobgether');
  assert.equal(pg.rotuloDe('https://br.bebee.com/jobs/dados'), 'bebee');
  assert.equal(pg.rotuloDe('https://www.bebee.com/'), 'bebee');
});

test('lista com JobPosting direto e com ItemList; vaga expirada e remota com restrição', async () => {
  const fim = mockarWeb([
    [/10\.9\.9\.9/, () => { throw new Error('não deveria chegar'); }],
    [/robots\.txt/, () => ok('User-agent: *\nDisallow: /admin\n', 'text/plain')],
    [/93\.184\.216\.1\/busca/, () => ok('<html>' + ld({ '@graph': [vaga('Engenheiro de Dados A'), vaga('Engenheiro B', { validThrough: '2020-01-01' }), vaga('Data Engineer C', { jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: { '@type': 'Country', name: 'Portugal' } })] }) + '</html>')],
  ]);
  try {
    const r = await pg.buscarPagina('http://93.184.216.1/busca?q=dados', { pausaMs: 0 });
    assert.deepEqual(r.map((v) => v.titulo), ['Engenheiro de Dados A', 'Data Engineer C']);
    assert.equal(r[0].empresa, 'Acme');
    assert.ok(r[0].texto.includes('Apache Airflow') && !r[0].texto.includes('<p>'));
    assert.equal(r[1].restricaoLocal, 'Portugal');
    assert.equal(radar.bloqueioGeografico(r[1]), true, 'restrição de país fora do Brasil vira aviso');
    assert.equal(radar.bloqueioGeografico(r[0]), false);
  } finally { fim(); }
});

test('listagem sem dados completos: abre anúncios do mesmo site, pausa e respeita robots dos detalhes', async () => {
  const visitados = [];
  const fim = mockarWeb([
    [/robots\.txt/, () => ok('User-agent: *\nDisallow: /vaga/bloqueada\n', 'text/plain')],
    [/93\.184\.216\.2\/lista/, () => ok('<a href="/vaga/1-dados">1</a><a href="/vaga/bloqueada-2">2</a><a href="https://outro.test/vaga/3">3</a><a href="/sobre">s</a>')],
    [/93\.184\.216\.2\/vaga\//, (u) => { visitados.push(u); return ok(ld(vaga('Vaga detalhe ' + u.split('/').pop()))); }],
  ]);
  try {
    const r = await pg.buscarPagina('http://93.184.216.2/lista', { pausaMs: 0 });
    assert.deepEqual(visitados, ['http://93.184.216.2/vaga/1-dados'], 'só o permitido e do mesmo site');
    assert.equal(r.length, 1);
    assert.ok(r[0].url.endsWith('/vaga/1-dados'));
  } finally { fim(); }
});

test('erros claros: robots proíbe, sem JobPosting, HTTP 403 e rede interna', async () => {
  const fim = mockarWeb([
    [/93\.184\.216\.3\/robots/, () => ok('User-agent: *\nDisallow: /busca\n', 'text/plain')],
    [/93\.184\.216\.4\/robots/, () => ok('', 'text/plain')],
    [/93\.184\.216\.4\/vazio/, () => ok('<html><body>só JavaScript</body></html>')],
    [/93\.184\.216\.5\/robots/, () => ok('', 'text/plain')],
    [/93\.184\.216\.5\/bloq/, () => { const e = new Error('403'); e.response = { status: 403 }; throw e; }],
  ]);
  try {
    await assert.rejects(pg.buscarPagina('http://93.184.216.3/busca?q=x', { pausaMs: 0 }), /robots\.txt/);
    await assert.rejects(pg.buscarPagina('http://93.184.216.4/vazio', { pausaMs: 0 }), /JobPosting/);
    await assert.rejects(pg.buscarPagina('http://93.184.216.5/bloq', { pausaMs: 0 }), (e) => e.response && e.response.status === 403);
    await assert.rejects(pg.buscarPagina('http://10.9.9.9/x', { pausaMs: 0 }), /não permitido/);
  } finally { fim(); }
});

test('configuração: valida endereços, recusa LinkedIn/Indeed/Glassdoor, limita a 6 e remove repetidos', () => {
  const r = svc.salvarRadar({ consultas: 'x', paginasExtras: 'jobgether.com/search?q=data\nhttps://br.bebee.com/jobs\nhttps://br.bebee.com/jobs' });
  assert.deepEqual(r.paginasExtras, ['https://jobgether.com/search?q=data', 'https://br.bebee.com/jobs']);
  assert.throws(() => svc.salvarRadar({ paginasExtras: 'https://www.linkedin.com/jobs/search' }), /não é permitido/);
  assert.throws(() => svc.salvarRadar({ paginasExtras: 'https://br.indeed.com/jobs?q=x' }), /não é permitido/);
  assert.throws(() => svc.salvarRadar({ paginasExtras: 'http://' }), /inválido/);
  assert.equal(svc.salvarRadar({ paginasExtras: Array.from({ length: 9 }, (_, i) => `https://s${i}.example.com/j`).join('\n') }).paginasExtras.length, 6);
});

test('radar: cada site extra aparece com o seu próprio status; um falhar não afeta o outro', async () => {
  svc.criarEvidencia({ skill: 'Apache Airflow', nivel: 'Avançado', prova: 'DAGs' });
  svc.salvarRadar({ consultas: 'x', consultasEn: 'y', gupy: false, remotive: false, excluir: '', maxNovas: 5, analisarTop: 0, paginasExtras: 'http://93.184.216.10/busca\nhttp://93.184.216.11/busca' });
  const fim = mockarWeb([
    [/robots\.txt/, () => ok('', 'text/plain')],
    [/93\.184\.216\.10\/busca/, () => ok(ld(vaga('Engenheiro de Dados Remoto')))],
    [/93\.184\.216\.11\/busca/, () => { const e = new Error('x'); e.response = { status: 403 }; throw e; }],
  ]);
  try {
    const r = await radar.executar({ manual: true });
    assert.equal(r.fontes['10'].ok, 1);
    assert.equal(r.fontes['11'].erro, 'HTTP 403');
    assert.equal(r.novas.length, 1);
    assert.match(store.vagas.obter(r.novas[0].id).fonte, /^radar:10/);
  } finally { fim(); }
});

test('Crawl-delay do robots.txt é respeitado entre as requisições aos anúncios', async () => {
  assert.equal(pg.atrasoDeRobots(pg.parseRobots('User-agent: *\nCrawl-delay: 2\nAllow: /\n')), 2);
  assert.equal(pg.atrasoDeRobots(pg.parseRobots('User-agent: Googlebot\nCrawl-delay: 9\n\nUser-agent: *\nAllow: /\n')), 0);
  assert.equal(pg.permitidoPorRobots(pg.parseRobots('User-agent: *\nDisallow: /*?*\nAllow: /astroapi/ai/jobs.json?*\nAllow: /astroapi/ai/jobs.json\n'), '/astroapi/ai/jobs.json?q=a'), true);
  assert.equal(pg.permitidoPorRobots(pg.parseRobots('User-agent: *\nDisallow: /*?*\nAllow: /astroapi/ai/jobs.json?*\n'), '/search?q=data'), false);

  const t0 = Date.now();
  const fim = mockarWeb([
    [/robots\.txt/, () => ok('User-agent: *\nCrawl-delay: 0.25\n', 'text/plain')],
    [/93\.184\.216\.20\/lista/, () => ok('<a href="/vaga/aaa-1">1</a><a href="/vaga/bbb-2">2</a>')],
    [/93\.184\.216\.20\/vaga\//, (u) => ok(ld(vaga('Detalhe ' + u.split('/').pop())))],
  ]);
  try {
    const r = await pg.buscarPagina('http://93.184.216.20/lista', { pausaMs: 0 });
    assert.equal(r.length, 2);
    assert.ok(Date.now() - t0 >= 450, 'duas pausas de 0,25 s');
  } finally { fim(); }
});

test('Jobgether: feed liberado no robots; filtra por título e por abertura ao Brasil; descrição vem da página da vaga quando existe', async () => {
  const jg = require('../../src/pontes/jobgether');
  const feed = { jobs: [
    { id: '1', title: 'Senior Data Engineer', company: 'US Corp', url: 'http://93.184.216.30/offer/1-senior-data-engineer', location: 'United States, Illinois (USA)', remote: 'Full Remote', experience: 'Senior (5-10 years)', jobFunctions: ['Data Engineer'], postedAt: new Date().toISOString() },
    { id: '2', title: 'Data Engineer', company: 'Br Co', url: 'http://93.184.216.30/offer/2-data-engineer', location: 'Brazil', remote: 'Full Remote', contractType: 'Full time', salaryRange: '5000-7000 USD', jobFunctions: ['Data Engineer'], postedAt: new Date().toISOString() },
    { id: '3', title: 'Analytics Data Engineer', company: 'Latam Co', url: 'http://93.184.216.30/offer/3-analytics', location: 'LATAM', remote: 'Full Remote', jobFunctions: ['Data Engineer'], postedAt: new Date().toISOString() },
    { id: '4', title: 'Marketing Manager', company: 'X', url: 'http://93.184.216.30/offer/4-mkt', location: 'Worldwide', remote: 'Full Remote', jobFunctions: ['Marketing'] },
  ] };
  const visitados = [];
  const fim = mockarWeb([
    [/93\.184\.216\.30\/robots/, () => ok('User-agent: *\nDisallow: /*?*\nDisallow: /offer/{*}\nAllow: /astroapi/ai/jobs.json\nAllow: /astroapi/ai/jobs.json?*\n', 'text/plain')],
    [/93\.184\.216\.30\/astroapi\/ai\/jobs\.json/, () => ok(JSON.stringify(feed), 'application/json')],
    [/93\.184\.216\.30\/offer\/2-/, (u) => { visitados.push(u); return ok(ld(vaga('Data Engineer', { description: '<p>Construir pipelines de dados com Airflow e dbt para clientes globais.</p>' }))); }],
    [/93\.184\.216\.30\/offer\/3-/, (u) => { visitados.push(u); const e = new Error('404'); e.response = { status: 404 }; throw e; }],
  ]);
  try {
    const r = await jg.buscarJobgether('feed', { consultasEn: ['data engineer'], consultas: ['engenheiro de dados'] }, { feed: 'http://93.184.216.30/astroapi/ai/jobs.json', pausaMs: 0 });
    assert.deepEqual(r.map((v) => v.titulo), ['Data Engineer', 'Analytics Data Engineer'], 'EUA e título fora do filtro ficam de fora');
    assert.equal(visitados.length, 2, 'páginas de vaga (permitidas) consultadas só para as selecionadas');
    assert.ok(r[0].texto.includes('Faixa salarial: 5000-7000 USD') && r[0].texto.includes('pipelines de dados com Airflow'), 'metadados + descrição');
    assert.ok(r[1].texto.includes('Local: LATAM') && !r[1].texto.includes('pipelines'), 'sem descrição: só metadados');
    assert.equal(r[0].fonte, 'radar:jobgether');
    assert.equal(jg.combina({ title: 'Senior Data Engineer', jobFunctions: [] }, ['data engineer']), true);
    assert.equal(jg.combina({ title: 'Data Analyst', jobFunctions: [] }, ['data engineer']), false);
  } finally { fim(); }
});

test('testarPagina: devolve amostra ou o motivo, sem importar nada', async () => {
  const antes = store.vagas.listar().length;
  const fim = mockarWeb([
    [/robots\.txt/, () => ok('User-agent: *\nDisallow: /busca\n', 'text/plain')],
    [/93\.184\.216\.40\/ok/, () => ok(ld(vaga('Engenheiro de Dados Teste')))],
  ]);
  try {
    const bom = await svc.testarPagina('http://93.184.216.40/ok');
    assert.equal(bom.ok, true); assert.equal(bom.total, 1); assert.equal(bom.amostra[0].titulo, 'Engenheiro de Dados Teste');
    const ruim = await svc.testarPagina('http://93.184.216.40/busca?q=x');
    assert.equal(ruim.ok, false); assert.match(ruim.motivo, /robots\.txt/);
    const proibido = await assert.rejects(svc.testarPagina('https://www.linkedin.com/jobs'), /não é permitido/);
    assert.equal(proibido, undefined);
    assert.equal(store.vagas.listar().length, antes, 'nada foi importado');
  } finally { fim(); }
});

test('radar: jobgether entra como fonte própria e pode ser desligado', async () => {
  svc.salvarRadar({ consultas: 'x', consultasEn: 'data engineer', paginasExtras: '', jobgether: false, gupy: false, remotive: false });
  assert.equal(svc.estadoRadar().config.jobgether, false);
  const r = await radar.executar({ manual: true, fontes: { jobgether: { consultas: () => ['feed'], buscar: async () => [], rotulo: () => 'jobgether' } } });
  assert.equal(r.fontes.jobgether, undefined, 'desligado: nem tenta');
});
