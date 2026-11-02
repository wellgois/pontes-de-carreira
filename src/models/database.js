'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db;

/** Banco SQLite local (data/pontes.db; troque com PONTES_DB). */
function getDb() {
  if (!db) {
    const arquivo = process.env.PONTES_DB || path.join(__dirname, '../../data/pontes.db');
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    db = new Database(arquivo);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

module.exports = { getDb };
