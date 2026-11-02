'use strict';
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const store = require('./src/pontes/store');
const service = require('./src/pontes/service');

const SENHA = process.env.PONTES_PASSWORD;
if (!SENHA || SENHA.length < 8) {
  console.error('Defina PONTES_PASSWORD (mínimo 8 caracteres) no .env. Não há senha padrão.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: 7 * 24 * 3600 * 1000 },
}));

const igual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

app.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), (req, res) => {
  if (igual(req.body.senha || '', SENHA)) { req.session.authenticated = true; return res.redirect('/'); }
  res.redirect('/login?erro=1');
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.use('/css', express.static(path.join(__dirname, 'public/css')));
app.use('/js', express.static(path.join(__dirname, 'public/js')));
app.use('/api/pontes', require('./src/routes/pontes'));
app.get('/', (req, res) => {
  if (!req.session.authenticated) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

store.init();
const porta = Number(process.env.PORT) || 3000;
app.listen(porta, '127.0.0.1', () => {
  console.log(`Pontes de Carreira em http://127.0.0.1:${porta}`);
  service.iniciar();
});
