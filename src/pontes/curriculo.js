'use strict';
/**
 * Pontes — currículo a partir do perfil e das evidências.
 *
 * Determinístico e sem IA: nada é inventado. Só entra o que você cadastrou (dados do currículo + evidências
 * revisadas). Para uma vaga, as evidências que provam os requisitos dela sobem na ordem; o conteúdo não muda.
 * Saídas: .docx (zip escrito à mão, sem dependências), HTML pronto para "salvar como PDF" e Markdown.
 */

const zlib = require('node:zlib');

const NIVEL_PESO = { Avançado: 3, Intermediário: 2, Básico: 1 };
const LIMITE_COMPETENCIAS = 24;
const LIMITE_PROJETOS = 10;

const txt = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);

/** Blocos separados por linha em branco; 1ª linha = título do bloco, demais = itens. */
function blocos(texto) {
  return String(texto || '').split(/\n\s*\n/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean)).filter((l) => l.length)
    .map((l) => ({ titulo: l[0], itens: l.slice(1).map((i) => i.replace(/^[-•*–]\s*/, '')) }));
}

function relevancia(vaga) {
  const peso = new Map();
  if (!vaga) return peso;
  for (const r of vaga.requisitos || []) {
    if (r.tipo === 'ruido' || r.status === 'vermelho') continue;
    const w = r.tipo === 'obrigatorio' ? 3 : 1;
    for (const id of r.evidencias || []) peso.set(id, (peso.get(id) || 0) + w);
  }
  return peso;
}

/** Monta o modelo do currículo. Evidências marcadas "revisar" ficam de fora: ainda não foram conferidas por você. */
function montar({ perfil, evidencias, vaga }) {
  const cv = (perfil && perfil.cv) || {};
  const rel = relevancia(vaga);
  const ok = evidencias.filter((e) => !e.revisar);
  const ordem = (a, b) => (rel.get(b.id) || 0) - (rel.get(a.id) || 0)
    || (NIVEL_PESO[b.nivel] || 0) - (NIVEL_PESO[a.nivel] || 0)
    || a.skill.localeCompare(b.skill, 'pt-BR');
  const ord = [...ok].sort(ordem);
  const contatos = [cv.cidade, cv.email, cv.telefone, cv.linkedin, cv.github].map((c) => txt(c, 120)).filter(Boolean);
  return {
    nome: txt(cv.nome, 120) || 'Seu nome',
    titulo: txt(cv.titulo, 160),
    contatos,
    resumo: txt(cv.resumo, 1200),
    competencias: ord.slice(0, LIMITE_COMPETENCIAS).map((e) => (e.nivel && e.nivel !== 'Não definido' ? `${e.skill} (${e.nivel})` : e.skill)),
    experiencias: blocos(cv.experiencias),
    projetos: ord.filter((e) => e.prova).slice(0, LIMITE_PROJETOS).map((e) => ({ titulo: e.skill, texto: e.prova, link: /^https?:\/\//i.test(e.link || '') ? e.link : '' })),
    formacao: blocos(cv.formacao),
    idiomas: txt(cv.idiomas, 300),
    paraVaga: vaga ? { titulo: vaga.titulo || '', empresa: vaga.empresa || '' } : null,
    ocultas: evidencias.length - ok.length,
  };
}

/* ---------- Markdown ---------- */
function markdown(m) {
  const o = [`# ${m.nome}`];
  if (m.titulo) o.push(`**${m.titulo}**`);
  if (m.contatos.length) o.push(m.contatos.join(' · '));
  if (m.resumo) o.push('## Resumo', m.resumo);
  if (m.competencias.length) o.push('## Competências', m.competencias.join(' · '));
  if (m.experiencias.length) {
    o.push('## Experiência');
    for (const b of m.experiencias) o.push(`### ${b.titulo}`, ...b.itens.map((i) => `- ${i}`));
  }
  if (m.projetos.length) o.push('## Projetos e provas', ...m.projetos.map((p) => `- **${p.titulo}:** ${p.texto}${p.link ? ` (${p.link})` : ''}`));
  if (m.formacao.length) o.push('## Formação', ...m.formacao.flatMap((b) => [`- ${b.titulo}`, ...b.itens.map((i) => `  - ${i}`)]));
  if (m.idiomas) o.push('## Idiomas', m.idiomas);
  return o.join('\n\n') + '\n';
}

/* ---------- HTML (A4, pronto para imprimir/salvar em PDF) ---------- */
const h = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function html(m) {
  const sec = (t, corpo) => (corpo ? `<section><h2>${h(t)}</h2>${corpo}</section>` : '');
  const exp = m.experiencias.map((b) => `<div class="b"><h3>${h(b.titulo)}</h3>${b.itens.length ? `<ul>${b.itens.map((i) => `<li>${h(i)}</li>`).join('')}</ul>` : ''}</div>`).join('');
  const proj = m.projetos.length ? `<ul>${m.projetos.map((p) => `<li><b>${h(p.titulo)}:</b> ${h(p.texto)}${p.link ? ` <a href="${h(p.link)}">${h(p.link)}</a>` : ''}</li>`).join('')}</ul>` : '';
  const form = m.formacao.map((b) => `<div class="b"><h3>${h(b.titulo)}</h3>${b.itens.length ? `<ul>${b.itens.map((i) => `<li>${h(i)}</li>`).join('')}</ul>` : ''}</div>`).join('');
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Currículo — ${h(m.nome)}</title>
<style>
@page{size:A4;margin:16mm 16mm}
*{box-sizing:border-box}body{font:11pt/1.45 Calibri,'Segoe UI',Arial,sans-serif;color:#111;margin:0;background:#eee}
.folha{max-width:210mm;margin:0 auto;background:#fff;padding:16mm;min-height:297mm}
h1{font-size:22pt;margin:0}.tit{font-size:12pt;color:#333;margin:2px 0}.cont{color:#444;font-size:10pt;margin:4px 0 10px}
h2{font-size:11pt;letter-spacing:.08em;text-transform:uppercase;border-bottom:1px solid #999;margin:14px 0 6px;padding-bottom:2px}
h3{font-size:11pt;margin:8px 0 2px}ul{margin:2px 0 6px;padding-left:18px}li{margin:1px 0}p{margin:4px 0}
a{color:#111;word-break:break-all}.b{break-inside:avoid}
@media print{body{background:#fff}.folha{padding:0;min-height:0}.nao-imprimir{display:none}}
.nao-imprimir{max-width:210mm;margin:0 auto;padding:10px 16mm;font:13px sans-serif;color:#333}
</style></head><body>
<div class="nao-imprimir">Para gerar o PDF: Imprimir (Ctrl+P ou menu do navegador) e escolher “Salvar como PDF”.</div>
<div class="folha">
<h1>${h(m.nome)}</h1>
${m.titulo ? `<div class="tit">${h(m.titulo)}</div>` : ''}
${m.contatos.length ? `<div class="cont">${m.contatos.map(h).join(' · ')}</div>` : ''}
${sec('Resumo', m.resumo ? `<p>${h(m.resumo)}</p>` : '')}
${sec('Competências', m.competencias.length ? `<p>${m.competencias.map(h).join(' · ')}</p>` : '')}
${sec('Experiência', exp)}
${sec('Projetos e provas', proj)}
${sec('Formação', form)}
${sec('Idiomas', m.idiomas ? `<p>${h(m.idiomas)}</p>` : '')}
</div></body></html>`;
}

/* ---------- DOCX (zip "stored" escrito à mão) ---------- */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zip(arquivos) {
  const locais = [];
  const centrais = [];
  let pos = 0;
  for (const [nome, conteudo] of arquivos) {
    const nomeB = Buffer.from(nome, 'utf8');
    const dados = Buffer.from(conteudo, 'utf8');
    const comp = zlib.deflateRawSync(dados);
    const crc = crc32(dados);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x0800, 6); loc.writeUInt16LE(8, 8);
    loc.writeUInt16LE(0, 10); loc.writeUInt16LE(0x21, 12); // 1980-01-01
    loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(dados.length, 22);
    loc.writeUInt16LE(nomeB.length, 26); loc.writeUInt16LE(0, 28);
    locais.push(loc, nomeB, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(dados.length, 24);
    cen.writeUInt16LE(nomeB.length, 28); cen.writeUInt32LE(pos, 42);
    centrais.push(cen, nomeB);
    pos += 30 + nomeB.length + comp.length;
  }
  const cd = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(arquivos.length, 8); fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(cd.length, 12); fim.writeUInt32LE(pos, 16);
  return Buffer.concat([...locais, cd, fim]);
}

const x = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function docx(m) {
  const run = (t, o = {}) => `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>${o.b ? '<w:b/>' : ''}${o.cor ? `<w:color w:val="${o.cor}"/>` : ''}<w:sz w:val="${o.sz || 21}"/></w:rPr><w:t xml:space="preserve">${x(t)}</w:t></w:r>`;
  const par = (runs, o = {}) => `<w:p><w:pPr>${o.borda ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr>' : ''}${o.manter ? '<w:keepNext/>' : ''}<w:spacing w:before="${o.antes || 0}" w:after="${o.depois == null ? 40 : o.depois}"/>${o.recuo ? `<w:ind w:left="${o.recuo}" w:hanging="220"/>` : ''}</w:pPr>${runs}</w:p>`;
  const titulo = (t) => par(run(t.toUpperCase(), { b: true, sz: 22 }), { borda: true, antes: 220, depois: 80, manter: true });
  const item = (t, nivel = 0) => par(run('•  ' + t), { recuo: 360 + nivel * 360 });
  const p = [];
  p.push(par(run(m.nome, { b: true, sz: 44 }), { depois: 20 }));
  if (m.titulo) p.push(par(run(m.titulo, { sz: 24, cor: '333333' }), { depois: 20 }));
  if (m.contatos.length) p.push(par(run(m.contatos.join('  ·  '), { sz: 20, cor: '444444' }), { depois: 60 }));
  if (m.resumo) p.push(titulo('Resumo'), par(run(m.resumo)));
  if (m.competencias.length) p.push(titulo('Competências'), par(run(m.competencias.join('  ·  '))));
  if (m.experiencias.length) {
    p.push(titulo('Experiência'));
    for (const b of m.experiencias) { p.push(par(run(b.titulo, { b: true }), { antes: 80, manter: true })); b.itens.forEach((i) => p.push(item(i))); }
  }
  if (m.projetos.length) {
    p.push(titulo('Projetos e provas'));
    for (const pr of m.projetos) p.push(par(run('•  ') + run(pr.titulo + ': ', { b: true }) + run(pr.texto + (pr.link ? ` (${pr.link})` : '')), { recuo: 360 }));
  }
  if (m.formacao.length) {
    p.push(titulo('Formação'));
    for (const b of m.formacao) { p.push(item(b.titulo)); b.itens.forEach((i) => p.push(item(i, 1))); }
  }
  if (m.idiomas) p.push(titulo('Idiomas'), par(run(m.idiomas)));
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="900" w:right="900" w:bottom="900" w:left="900" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', doc],
  ]);
}

function nomeDoArquivo(m, ext) {
  const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40);
  const partes = ['curriculo', slug(m.nome), m.paraVaga ? slug(m.paraVaga.empresa) : ''].filter(Boolean);
  return `${partes.join('-')}.${ext}`;
}

module.exports = { montar, markdown, html, docx, nomeDoArquivo, blocos, zip, crc32 };
