'use strict';
/**
 * Pontes — persistência (SQLite, SQLite local). Todas as consultas são parametrizadas.
 */

const { getDb } = require('../models/database');

const J = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

function init(db = getDb()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pontes_evidencias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill TEXT NOT NULL,
      nivel TEXT DEFAULT 'Não definido',
      prova TEXT DEFAULT '',
      link TEXT DEFAULT '',
      revisar INTEGER DEFAULT 0,
      origem_ponte TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pontes_vagas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo TEXT DEFAULT '',
      empresa TEXT DEFAULT '',
      url TEXT DEFAULT '',
      fonte TEXT DEFAULT '',
      texto TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'interesse',
      faixa_salarial TEXT DEFAULT '',
      resumo TEXT DEFAULT '',
      sinais_risco TEXT DEFAULT '[]',
      requisitos TEXT DEFAULT '[]',
      etapa_recusa TEXT DEFAULT '',
      motivo_recusa TEXT DEFAULT '',
      features TEXT,
      label INTEGER,
      label_em INTEGER,
      analisada_em INTEGER,
      status_em INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pontes_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      vaga_id INTEGER,
      dados TEXT
    );
    CREATE TABLE IF NOT EXISTS pontes_modelo (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      estado TEXT NOT NULL,
      atualizado_em INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pontes_previsoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vaga_id INTEGER,
      ts INTEGER NOT NULL,
      p REAL NOT NULL,
      p_base REAL NOT NULL,
      y INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pontes_ajustes (
      chave TEXT PRIMARY KEY,
      valor REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pontes_perfil (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      dados TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pontes_vagas_status ON pontes_vagas(status);
    CREATE INDEX IF NOT EXISTS idx_pontes_eventos_vaga ON pontes_eventos(vaga_id);
  `);
}

/* ---------- evidências ---------- */
const evidFrom = (r) => r && ({
  id: r.id, skill: r.skill, nivel: r.nivel, prova: r.prova, link: r.link, revisar: !!r.revisar,
  origemPonte: r.origem_ponte || null, criadoEm: r.created_at, atualizadoEm: r.updated_at,
});

const evidencias = {
  listar: () => getDb().prepare('SELECT * FROM pontes_evidencias ORDER BY skill COLLATE NOCASE').all().map(evidFrom),
  obter: (id) => evidFrom(getDb().prepare('SELECT * FROM pontes_evidencias WHERE id = ?').get(id)),
  criar(d) {
    const t = Date.now();
    const r = getDb().prepare(
      'INSERT INTO pontes_evidencias (skill, nivel, prova, link, revisar, origem_ponte, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(d.skill, d.nivel || 'Não definido', d.prova || '', d.link || '', d.revisar ? 1 : 0, d.origemPonte || null, t, t);
    return Number(r.lastInsertRowid);
  },
  atualizar(id, d) {
    getDb().prepare('UPDATE pontes_evidencias SET skill=?, nivel=?, prova=?, link=?, revisar=0, updated_at=? WHERE id=?')
      .run(d.skill, d.nivel || 'Não definido', d.prova || '', d.link || '', Date.now(), id);
  },
  excluir: (id) => getDb().prepare('DELETE FROM pontes_evidencias WHERE id = ?').run(id),
};

/* ---------- vagas ---------- */
const vagaFrom = (r) => r && ({
  id: r.id, titulo: r.titulo, empresa: r.empresa, url: r.url, fonte: r.fonte, texto: r.texto, status: r.status,
  faixaSalarial: r.faixa_salarial, resumo: r.resumo, sinaisRisco: J(r.sinais_risco, []), requisitos: J(r.requisitos, []),
  etapaRecusa: r.etapa_recusa, motivoRecusa: r.motivo_recusa, features: J(r.features, null), label: r.label,
  labelEm: r.label_em, analisadaEm: r.analisada_em, statusEm: r.status_em, criadoEm: r.created_at,
});

const vagas = {
  listar: () => getDb().prepare('SELECT * FROM pontes_vagas ORDER BY created_at DESC').all().map(vagaFrom),
  obter: (id) => vagaFrom(getDb().prepare('SELECT * FROM pontes_vagas WHERE id = ?').get(id)),
  criar(d) {
    const t = Date.now();
    const r = getDb().prepare(
      'INSERT INTO pontes_vagas (titulo, empresa, url, fonte, texto, status, status_em, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(d.titulo || '', d.empresa || '', d.url || '', d.fonte || '', d.texto, 'interesse', t, t);
    return Number(r.lastInsertRowid);
  },
  salvarAnalise(id, a) {
    getDb().prepare(
      'UPDATE pontes_vagas SET titulo=?, empresa=?, faixa_salarial=?, resumo=?, sinais_risco=?, requisitos=?, analisada_em=? WHERE id=?'
    ).run(a.titulo, a.empresa, a.faixaSalarial, a.resumo, JSON.stringify(a.sinaisRisco), JSON.stringify(a.requisitos), Date.now(), id);
  },
  salvarRequisitos: (id, reqs) => getDb().prepare('UPDATE pontes_vagas SET requisitos=? WHERE id=?').run(JSON.stringify(reqs), id),
  atualizarCampos(id, c) {
    getDb().prepare('UPDATE pontes_vagas SET status=?, etapa_recusa=?, motivo_recusa=?, fonte=?, status_em=? WHERE id=?')
      .run(c.status, c.etapaRecusa || '', c.motivoRecusa || '', c.fonte || '', c.statusEm || Date.now(), id);
  },
  salvarFeatures: (id, f) => getDb().prepare('UPDATE pontes_vagas SET features=? WHERE id=?').run(JSON.stringify(f), id),
  marcarLabel: (id, y, t) => getDb().prepare('UPDATE pontes_vagas SET label=?, label_em=? WHERE id=?').run(y, t, id),
  excluir: (id) => getDb().prepare('DELETE FROM pontes_vagas WHERE id = ?').run(id),
  comLabelOrdenadas: () => getDb().prepare('SELECT * FROM pontes_vagas WHERE label IS NOT NULL ORDER BY label_em, id').all().map(vagaFrom),
};

/* ---------- eventos, modelo, previsões, ajustes, perfil ---------- */
const eventos = {
  registrar: (tipo, vagaId, dados) =>
    getDb().prepare('INSERT INTO pontes_eventos (ts, tipo, vaga_id, dados) VALUES (?,?,?,?)').run(Date.now(), tipo, vagaId || null, JSON.stringify(dados || {})),
  recentes: (n = 50) => getDb().prepare('SELECT * FROM pontes_eventos ORDER BY id DESC LIMIT ?').all(n).map((e) => ({ id: e.id, ts: e.ts, tipo: e.tipo, vagaId: e.vaga_id, dados: J(e.dados, {}) })),
};

const modelo = {
  carregar: () => {
    const r = getDb().prepare('SELECT estado FROM pontes_modelo WHERE id = 1').get();
    return r ? J(r.estado, null) : null;
  },
  salvar: (estado) => getDb().prepare(
    'INSERT INTO pontes_modelo (id, estado, atualizado_em) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET estado=excluded.estado, atualizado_em=excluded.atualizado_em'
  ).run(JSON.stringify(estado), Date.now()),
  atualizadoEm: () => (getDb().prepare('SELECT atualizado_em FROM pontes_modelo WHERE id = 1').get() || {}).atualizado_em || null,
};

const previsoes = {
  registrar: (vagaId, p, pBase, y) => getDb().prepare('INSERT INTO pontes_previsoes (vaga_id, ts, p, p_base, y) VALUES (?,?,?,?,?)').run(vagaId, Date.now(), p, pBase, y),
  todas: () => getDb().prepare('SELECT vaga_id, ts, p, p_base, y FROM pontes_previsoes ORDER BY id').all().map((r) => ({ vagaId: r.vaga_id, ts: r.ts, p: r.p, pBase: r.p_base, y: r.y })),
  limpar: () => getDb().prepare('DELETE FROM pontes_previsoes').run(),
};

const ajustes = {
  todos() {
    const o = {};
    for (const r of getDb().prepare('SELECT chave, valor FROM pontes_ajustes').all()) o[r.chave] = r.valor;
    return o;
  },
  definir: (chave, valor) => getDb().prepare(
    'INSERT INTO pontes_ajustes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor'
  ).run(chave, valor),
};

const PERFIL_PADRAO = { alvo: '', lacunas: [], obs: '', plano: null };
const perfil = {
  obter: () => {
    const r = getDb().prepare('SELECT dados FROM pontes_perfil WHERE id = 1').get();
    return Object.assign({}, PERFIL_PADRAO, r ? J(r.dados, {}) : {});
  },
  salvar: (p) => getDb().prepare(
    'INSERT INTO pontes_perfil (id, dados) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET dados=excluded.dados'
  ).run(JSON.stringify(p)),
};

module.exports = { init, evidencias, vagas, eventos, modelo, previsoes, ajustes, perfil };
