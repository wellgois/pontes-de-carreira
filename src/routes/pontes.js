/**
 * Rotas do Pontes (/api/pontes). Todas exigem sessão autenticada.
 */
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const svc = require('../pontes/service');
const store = require('../pontes/store');

const router = express.Router();
router.use(requireAuth);

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    const status = err.status && err.status < 600 ? err.status : 500;
    if (status === 500) console.error('[PONTES]', err);
    res.status(status).json({ error: status === 500 ? 'Erro interno no Pontes.' : err.message });
  }
};

const idDe = (req) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) throw svc.erro(400, 'Identificador inválido.');
  return id;
};

router.get('/meta', wrap(() => ({ status: svc.STATUS, etapas: svc.ETAPAS, motivos: svc.MOTIVOS, niveis: svc.NIVEIS })));

/* perfil */
router.get('/perfil', wrap(() => store.perfil.obter()));
router.put('/perfil', wrap((req) => svc.salvarPerfil(req.body || {})));

/* evidências */
router.get('/evidencias', wrap(() => store.evidencias.listar()));
router.post('/evidencias', wrap((req) => svc.criarEvidencia(req.body || {})));
router.put('/evidencias/:id', wrap((req) => {
  const id = idDe(req);
  if (!store.evidencias.obter(id)) throw svc.erro(404, 'Evidência não encontrada.');
  svc.atualizarEvidencia(id, req.body || {});
  return { ok: true, impacto: svc.rematchTodas().filter((i) => i.novasSugestoes > 0) };
}));
router.delete('/evidencias/:id', wrap((req) => {
  store.evidencias.excluir(idDe(req));
  svc.rematchTodas();
  return { ok: true };
}));

/* vagas */
router.get('/vagas', wrap(() => svc.listarVagas()));
router.post('/vagas', wrap((req) => ({ id: svc.criarVaga(req.body || {}) })));
router.get('/vagas/:id', wrap((req) => svc.detalhe(idDe(req))));
router.patch('/vagas/:id', wrap((req) => svc.atualizarVaga(idDe(req), req.body || {})));
router.delete('/vagas/:id', wrap((req) => { svc.excluirVaga(idDe(req)); return { ok: true }; }));
router.post('/vagas/:id/analisar', wrap((req) => svc.analisarVaga(idDe(req))));
router.post('/vagas/:id/carta', wrap(async (req) => ({ texto: await svc.gerarCarta(idDe(req)) })));
router.post('/vagas/:id/requisitos/:idx/:acao', wrap((req) => {
  const idx = Number.parseInt(req.params.idx, 10);
  const { acao } = req.params;
  if (!Number.isInteger(idx) || idx < 0 || !['confirmar', 'rejeitar'].includes(acao)) throw svc.erro(400, 'Pedido inválido.');
  return svc.responderSugestao(idDe(req), idx, acao === 'confirmar');
}));

/* fontes do perfil */
router.get('/fontes', wrap(() => svc.obterFontes()));
router.put('/fontes', wrap((req) => svc.salvarFontes(req.body || {})));
router.post('/fontes/arquivo', express.raw({ type: () => true, limit: '8mb' }), wrap((req) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw svc.erro(400, 'Arquivo vazio.');
  return svc.textoDeArquivo(req.body, decodeURIComponent(String(req.query.nome || 'arquivo')));
}));
router.post('/fontes/portfolios/ler', wrap(() => svc.lerPortfolios()));
router.post('/fontes/propor', wrap(() => svc.proporEvidencias()));
router.post('/fontes/aplicar', wrap((req) => svc.aplicarProposta(req.body || {})));

/* currículo (download autenticado) */
router.put('/curriculo', wrap((req) => svc.salvarCurriculo(req.body || {})));
router.get('/curriculo', (req, res) => {
  try {
    const vaga = req.query.vaga ? Number.parseInt(req.query.vaga, 10) : null;
    if (req.query.vaga && !(vaga > 0)) throw svc.erro(400, 'Vaga inválida.');
    const r = svc.gerarCurriculo(req.query.formato, vaga);
    res.setHeader('Content-Type', r.tipo);
    res.setHeader('Content-Disposition', `${r.inline ? 'inline' : 'attachment'}; filename="${r.arquivo}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(r.corpo);
  } catch (err) {
    const status = err.status && err.status < 600 ? err.status : 500;
    if (status === 500) console.error('[PONTES]', err);
    res.status(status).json({ error: status === 500 ? 'Erro interno no Pontes.' : err.message });
  }
});

/* radar diário */
router.get('/radar', wrap(() => svc.estadoRadar()));
router.put('/radar', wrap((req) => svc.salvarRadar(req.body || {})));
router.post('/radar/testar', wrap((req) => svc.testarPagina((req.body || {}).url)));
router.post('/radar/executar', wrap(() => svc.iniciarRadarAgora()));

/* inteligência */
router.get('/padroes', wrap(() => svc.padroes()));
router.get('/aprendizado', wrap(() => svc.aprendizado()));
router.post('/plano', wrap(() => svc.gerarPlano()));
router.post('/rematch', wrap(() => svc.rematchTodas()));
router.post('/modelo/reconstruir', wrap(() => svc.reconstruir()));

module.exports = router;
