/* Pontes de Carreira — interface. Dados vêm de /api/pontes (sessão autenticada). */
(function () {
  'use strict';
  var $ = function (s, el) { return (el || document).querySelector(s); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var STATUS = [['interesse', 'A avaliar'], ['candidatado', 'Candidatado'], ['entrevista', 'Entrevista'], ['oferta', 'Oferta'], ['recusada', 'Recusada'], ['descartada', 'Descartada']];
  var ETAPAS = [['triagem', 'Triagem do currículo'], ['rh', 'Conversa com RH'], ['tecnica', 'Etapa técnica'], ['final', 'Etapa final'], ['sem_retorno', 'Sem retorno']];
  var MOTIVOS = [['salario', 'Faixa salarial'], ['tecnico', 'Lacuna técnica'], ['ingles', 'Inglês oral'], ['senioridade', 'Senioridade'], ['cancelada', 'Vaga cancelada'], ['outro', 'Outro'], ['desconhecido', 'Não informado']];
  var NIVEIS = ['Não definido', 'Básico', 'Intermediário', 'Avançado'];
  var TIPOS = { obrigatorio: 'obrigatório', desejavel: 'desejável', ruido: 'ruído' };
  function lbl(list, k) { for (var i = 0; i < list.length; i++) if (list[i][0] === k) return list[i][1]; return k; }
  function pct(n) { return n == null ? '—' : Math.round(n) + '%'; }
  function safeUrl(u) { return /^https?:\/\//i.test(u || '') ? u : ''; }
  function fmtData(ts) { return ts ? new Date(ts).toLocaleDateString('pt-BR') : ''; }

  var state = { proposta: null, filtro: 'todas', sort: 'recentes', busy: {}, confirm: '', textoAberto: {}, erro: '' };
  var toastTimer, radarTimer, ctl = null;

  function toast(msg) { var t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 5000); }

  function api(method, path, body) {
    return fetch('/api/pontes' + path, {
      method: method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      if (r.status === 401) { location.href = '/login'; throw new Error('Sessão expirada'); }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || 'Falha na requisição'); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  function meter(c) {
    var t = c.verde + c.amarelo + c.vermelho;
    if (!t) return '<div class="meter" aria-hidden="true"></div>';
    return '<div class="meter" role="img" aria-label="' + c.verde + ' provados, ' + c.amarelo + ' parciais, ' + c.vermelho + ' ausentes">' +
      '<i class="g" style="width:' + (c.verde / t * 100) + '%"></i><i class="y" style="width:' + (c.amarelo / t * 100) + '%"></i><i class="r" style="width:' + (c.vermelho / t * 100) + '%"></i></div>';
  }

  /* ---------- rotas ---------- */
  function route() {
    var h = location.hash.replace(/^#/, '');
    if (h.indexOf('vaga-') === 0) return { name: 'vaga', id: parseInt(h.slice(5), 10) };
    if (['vagas', 'evidencias', 'padroes', 'aprendizado', 'funil', 'curriculo', 'radar', 'perfil'].indexOf(h) >= 0) return { name: h };
    return { name: 'vagas' };
  }
  var TABS = [['vagas', 'Vagas'], ['perfil', 'Meu perfil'], ['evidencias', 'Evidências'], ['padroes', 'Padrões e pontes'], ['aprendizado', 'Aprendizado'], ['funil', 'Funil'], ['curriculo', 'Currículo'], ['radar', 'Radar']];
  function renderTabs() {
    var r = route().name === 'vaga' ? 'vagas' : route().name;
    $('#tabs').innerHTML = TABS.map(function (t) { return '<a href="#' + t[0] + '"' + (t[0] === r ? ' aria-current="page"' : '') + '>' + t[1] + '</a>'; }).join('');
  }

  /* ---------- views ---------- */
  function vagasView(vagas) {
    var h = '<div class="pt-head"><div><h1>Vagas</h1><p class="lede">Cole o texto de cada vaga. A IA separa exigência real de ruído; o casamento com suas evidências e a chance estimada de avançar são calculados e aprendidos aqui.</p></div><button class="pt-btn primary" data-act="nova-vaga">Nova vaga</button></div>';
    if (!vagas.length) return h + '<div class="empty"><h3>Nenhuma vaga ainda</h3><p>Cole o texto de uma vaga para ver o que você já prova, o que falta e qual projeto curto fecha a lacuna.</p><button class="pt-btn primary" data-act="nova-vaga">Adicionar a primeira vaga</button></div>';
    var cnt = { todas: vagas.length };
    STATUS.forEach(function (s) { cnt[s[0]] = vagas.filter(function (v) { return v.status === s[0]; }).length; });
    var chips = '<div class="chips" role="group" aria-label="Filtrar por situação">' + [['todas', 'Todas']].concat(STATUS).filter(function (s) { return s[0] === 'todas' || cnt[s[0]] > 0; }).map(function (s) {
      return '<button class="chip" data-act="filtro" data-k="' + s[0] + '" aria-pressed="' + (state.filtro === s[0]) + '">' + s[1] + '<span class="mono">' + cnt[s[0]] + '</span></button>';
    }).join('') + '</div>';
    var list = vagas.filter(function (v) { return state.filtro === 'todas' || v.status === state.filtro; });
    list.sort(function (a, b) {
      if (state.sort === 'aderencia') return (b.aderencia == null ? -1 : b.aderencia) - (a.aderencia == null ? -1 : a.aderencia);
      if (state.sort === 'chance') return (b.pAvancar == null ? -1 : b.pAvancar) - (a.pAvancar == null ? -1 : a.pAvancar);
      return (b.criadoEm || 0) - (a.criadoEm || 0);
    });
    var sort = '<label class="check" style="font-weight:400">Ordenar por <select class="inl" id="sort">' +
      [['recentes', 'Mais recentes'], ['aderencia', 'Maior aderência'], ['chance', 'Maior chance estimada']].map(function (o) { return '<option value="' + o[0] + '"' + (state.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>';
    var rows = list.map(function (v) {
      var sub = [v.empresa, v.faixaSalarial].filter(Boolean).map(esc).join(' · ');
      return '<a class="vaga" href="#vaga-' + v.id + '"><div><div class="v-title">' + esc(v.titulo || 'Vaga sem título') + '</div><div class="small muted">' + (sub || 'Sem empresa informada') + '</div></div>' +
        (v.analisada ? meter(v.contagem) : '<div class="small muted">Sem análise</div>') +
        '<div class="v-score">' + pct(v.aderencia) + '</div><div class="v-p" title="Chance estimada de chegar à entrevista">' + (v.pAvancar == null ? '' : Math.round(v.pAvancar * 100) + '%') + '</div>' +
        '<span class="pill st-' + v.status + '">' + esc(lbl(STATUS, v.status)) + '</span></a>';
    }).join('');
    return h + '<div class="row" style="justify-content:space-between">' + chips + sort + '</div><div class="vagas">' + (rows || '<div class="empty" style="border:0">Nenhuma vaga nesta situação.</div>') + '</div>';
  }

  function reqHtml(r, idx, vagaId, evid) {
    var cls = r.status === 'verde' ? 'g' : r.status === 'amarelo' ? 'y' : 'r';
    var nomes = (r.evidencias || []).map(function (id) { var e = evid[id]; return e ? e.skill : null; }).filter(Boolean);
    var ev = nomes.length ? 'Provado por: ' + nomes.map(esc).join(', ') + (r.confirmadoPorVoce ? ' (confirmado por você)' : '') : (r.status === 'vermelho' ? 'Sem evidência registrada' : '');
    if (r.nota) ev += (ev ? ' — ' : '') + esc(r.nota);
    var sug = r.sugestaoMl ? '<div class="sugestao"><b>Provável:</b> “' + esc(r.sugestaoMl.skill) + '” pode provar este requisito <span class="mono">(' + Math.round(r.sugestaoMl.score * 100) + '%)</span>. Só vale como prova depois que você confirmar.' +
      '<div class="row"><button class="pt-btn sm primary" data-act="sug" data-v="' + vagaId + '" data-i="' + idx + '" data-a="confirmar">Confirmar</button><button class="pt-btn sm" data-act="sug" data-v="' + vagaId + '" data-i="' + idx + '" data-a="rejeitar">Não é isso</button></div></div>' : '';
    var ponte = (r.ponte && r.ponte.projeto) ? '<div class="ponte"><b>Ponte</b> ' + esc(r.ponte.projeto) + (r.ponte.horas ? ' <span class="mono">~' + esc(r.ponte.horas) + ' h</span>' : '') + '</div>' : '';
    return '<li class="req"><i class="dot ' + cls + '" title="' + esc(r.status) + '"></i><div><div class="req-head"><strong>' + esc(r.nome) + '</strong><span class="tag">' + (TIPOS[r.tipo] || esc(r.tipo)) + '</span></div>' +
      (ev ? '<div class="req-ev">' + ev + '</div>' : '') + sug + ponte + '</div></li>';
  }

  function vagaView(v, evid) {
    var back = '<a class="back" href="#vagas">← Todas as vagas</a>';
    var busy = state.busy[v.id], url = safeUrl(v.url), rs = v.requisitos || [];
    var h = back + '<div class="pt-head"><div><h1>' + esc(v.titulo || 'Vaga sem título') + '</h1><p class="lede">' +
      [v.empresa, v.faixaSalarial].filter(Boolean).map(esc).join(' · ') + (url ? ((v.empresa || v.faixaSalarial) ? ' · ' : '') + '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Abrir anúncio</a>' : '') + '</p></div>' +
      '<span class="pill st-' + v.status + '">' + esc(lbl(STATUS, v.status)) + '</span></div>';
    h += '<div class="row"><label class="check">Situação <select class="inl" id="status-sel" data-id="' + v.id + '">' + STATUS.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === v.status ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></label>' +
      '<button class="pt-btn primary" data-act="analisar" data-id="' + v.id + '"' + (busy ? ' disabled' : '') + '>' + (rs.length ? 'Analisar de novo' : 'Analisar com IA') + '</button>' +
      (rs.length ? '<button class="pt-btn" data-act="carta" data-id="' + v.id + '">Redigir carta</button>' : '') +
      '<button class="pt-btn danger' + (state.confirm === 'v:' + v.id ? ' armed' : '') + '" data-act="del-vaga" data-id="' + v.id + '">' + (state.confirm === 'v:' + v.id ? 'Confirmar exclusão' : 'Excluir') + '</button></div>';
    if (busy) h += '<div class="card"><b>Analisando a vaga…</b><div class="small muted">A IA está separando os requisitos e cruzando com suas evidências. Pode levar cerca de um minuto.</div><div class="progress"><i></i></div></div>';
    if (v.status === 'recusada') {
      h += '<div class="card"><div class="row"><label style="min-width:200px;flex:1">Onde parou<select id="etapa-sel" data-id="' + v.id + '"><option value="">Selecione</option>' + ETAPAS.map(function (x) { return '<option value="' + x[0] + '"' + (v.etapaRecusa === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></label>' +
        '<label style="min-width:200px;flex:1">Motivo provável<select id="motivo-sel" data-id="' + v.id + '"><option value="">Selecione</option>' + MOTIVOS.map(function (x) { return '<option value="' + x[0] + '"' + (v.motivoRecusa === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></label></div>' +
        '<p class="small muted" style="margin:10px 0 0">A etapa onde a recusa aconteceu é o que o modelo aprende: parar na triagem conta como “não avançou”; chegar a RH ou técnica conta como “avançou”.</p></div>';
    }
    if (!rs.length && !busy) h += '<div class="empty"><h3>Ainda sem análise</h3><p>Clique em “Analisar com IA” para ver sua aderência e as lacunas.</p></div>';
    if (rs.length) {
      var c = v.contagem;
      var modoAp = v.modelo && v.modelo.modo === 'a-priori';
      h += '<div class="card score-card"><div class="big">' + Math.round(v.aderencia == null ? 0 : v.aderencia) + '<small>%</small></div><div>' + meter(c) +
        '<div class="legend"><span><i class="dot g"></i><b>' + c.verde + '</b> provados</span><span><i class="dot y"></i><b>' + c.amarelo + '</b> parciais</span><span><i class="dot r"></i><b>' + c.vermelho + '</b> ausentes</span></div>' +
        (v.resumo ? '<p style="margin:10px 0 0">' + esc(v.resumo) + '</p>' : '') + '</div></div>';
      if (v.pAvancar != null) {
        h += '<div class="card"><div class="sec-title"><h3>Chance estimada de chegar à entrevista: <span class="mono">' + Math.round(v.pAvancar * 100) + '%</span></h3><span class="small muted">' +
          (modoAp ? 'Ainda baseada em premissas iniciais; melhora conforme você registra desfechos.' : 'Aprendida com ' + esc((v.modelo && v.modelo.confianca != null) ? Math.round(v.modelo.confianca * 100) + '% de confiança' : '') + '.') + '</span></div>';
        var sf = (v.seFechar || []).filter(function (x) { return x.ganho > 0.005; }).slice(0, 3);
        if (sf.length) h += '<div class="small muted">Se você fechasse esta lacuna, a chance estimada subiria:</div><ul class="whatif">' + sf.map(function (x) { return '<li><span>' + esc(x.nome) + '</span><span class="mono">+' + Math.round(x.ganho * 100) + ' pontos · aderência ' + Math.round(x.aderenciaDepois) + '%</span></li>'; }).join('') + '</ul>';
        h += '</div>';
      }
      if ((v.sinaisRisco || []).length) h += '<div role="alert">' + v.sinaisRisco.map(function (a) { return '<div class="alert">' + esc(a) + '</div>'; }).join('') + '</div>';
      var ord = { obrigatorio: 0, desejavel: 1, ruido: 2 }, so = { vermelho: 0, amarelo: 1, verde: 2 };
      var idxs = rs.map(function (r, i) { return i; }).sort(function (a, b) { return ord[rs[a].tipo] - ord[rs[b].tipo] || so[rs[a].status] - so[rs[b].status]; });
      h += '<div><div class="sec-title"><h2>Requisitos</h2><span class="small muted">Obrigatórios pesam 3 vezes mais que desejáveis. Ruído não entra na conta.</span></div><ul class="reqs">' + idxs.map(function (i) { return reqHtml(rs[i], i, v.id, evid); }).join('') + '</ul></div>';
    }
    h += '<details class="orig card" data-id="' + v.id + '"' + (state.textoAberto[v.id] ? ' open' : '') + '><summary>Texto original da vaga</summary><pre>' + esc(v.texto || '') + '</pre></details>';
    return h;
  }

  function evidenciasView(evid, perfil) {
    var p = perfil || {};
    var h = '<div class="pt-head"><div><h1>Evidências</h1><p class="lede">Só entra aqui o que você consegue provar: um projeto, um cargo, um link. É a base de toda análise. Ao adicionar uma, as vagas já analisadas são reavaliadas na hora, sem custo de IA.</p></div><button class="pt-btn primary" data-act="nova-evid">Nova evidência</button></div>';
    h += '<div class="card perfil"><div class="sec-title"><h3>Seu perfil de busca</h3><button class="pt-btn sm" data-act="edit-perfil">Editar</button></div><dl>' +
      '<dt>Alvo salarial</dt><dd>' + (esc(p.alvo) || '<span class="muted">Não informado</span>') + '</dd>' +
      '<dt>Lacunas declaradas</dt><dd>' + ((p.lacunas || []).length ? p.lacunas.map(function (x) { return '<span class="lvl">' + esc(x) + '</span>'; }).join(' ') : '<span class="muted">Nenhuma</span>') + '</dd>' +
      '<dt>Observações</dt><dd>' + (esc(p.obs) || '<span class="muted">Nenhuma</span>') + '</dd></dl></div>';
    if (!evid.length) return h + '<div class="empty"><h3>Sem evidências cadastradas</h3><p>Adicione projetos, cargos e estudos com o que cada um prova.</p></div>';
    h += '<div class="grid">' + evid.map(function (e) {
      var link = safeUrl(e.link);
      return '<div class="card ev"><div class="ev-top"><h3>' + esc(e.skill) + '</h3><span>' + (e.revisar ? '<span class="rev">revisar</span> ' : '') + '<span class="lvl">' + esc(e.nivel || 'Não definido') + '</span></span></div>' +
        '<p>' + (esc(e.prova) || 'Sem descrição da prova.') + '</p>' + (link ? '<a class="small" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">Ver link</a>' : '') +
        '<div class="acts"><button class="pt-btn sm" data-act="edit-evid" data-id="' + e.id + '">Editar</button><button class="pt-btn sm danger' + (state.confirm === 'e:' + e.id ? ' armed' : '') + '" data-act="del-evid" data-id="' + e.id + '">' + (state.confirm === 'e:' + e.id ? 'Confirmar' : 'Excluir') + '</button></div></div>';
    }).join('') + '</div>';
    return h;
  }

  function padroesView(P, plano) {
    var h = '<div class="pt-head"><div><h1>Padrões e pontes</h1><p class="lede">O que se repete nas vagas analisadas, com peso maior para as recentes, e o menor projeto que fecha cada lacuna. A ordem combina demanda, impacto aprendido nos seus desfechos e esforço.</p></div></div>';
    if (!P.totalVagas) return h + '<div class="empty"><h3>Nada para comparar ainda</h3><p>Analise pelo menos duas vagas e os padrões aparecem aqui.</p></div>';
    h += '<div class="stats"><div class="card stat"><div class="n mono">' + P.totalVagas + '</div><div class="small muted">vagas analisadas</div></div><div class="card stat"><div class="n mono">' + P.lacunas.length + '</div><div class="small muted">lacunas ou pontos parciais</div></div><div class="card stat"><div class="n mono">' + P.fortes.length + '</div><div class="small muted">requisitos já provados</div></div></div>';
    if (P.sugestaoDoDia) h += '<div class="card"><h3>Sugestão para testar hoje</h3><p style="margin:6px 0 0">' + esc(P.sugestaoDoDia.nome) + (P.sugestaoDoDia.ponte ? ': ' + esc(P.sugestaoDoDia.ponte.projeto) : '') + '</p><p class="small muted" style="margin:6px 0 0">O sistema reserva uma parte da atenção para lacunas ainda pouco observadas, para não ficar preso só ao que já sabe.</p></div>';
    h += '<div><div class="sec-title"><h2>Lacunas por prioridade</h2><span class="small muted">barra = % das vagas em que o requisito aparece sem prova completa</span></div>';
    h += P.lacunas.length ? '<ol class="rank">' + P.lacunas.slice(0, 10).map(function (g) {
      var f = g.demanda * 100;
      var extra = [];
      if (g.obrigatorio) extra.push('obrigatório em ' + g.obrigatorio);
      if (g.observacoes >= 3) extra.push('impacto aprendido ' + g.impactoAprendido.toFixed(1)); else extra.push('impacto ainda sem dados');
      if (g.tendencia != null && Math.abs(g.tendencia) > 0.1) extra.push(g.tendencia > 0 ? 'em alta' : 'em queda');
      return '<li><div><strong>' + esc(g.nome) + '</strong> <span class="small muted">' + esc(extra.join(' · ')) + '</span>' +
        (g.ponte ? '<div class="ponte"><b>Ponte</b> ' + esc(g.ponte.projeto) + (g.ponte.horas ? ' <span class="mono">~' + esc(g.ponte.horas) + ' h</span>' : '') + '</div>' : '') +
        '<div style="margin-top:8px"><button class="pt-btn sm" data-act="concluir-ponte" data-nome="' + esc(g.nome) + '">Concluí esta ponte</button></div></div>' +
        '<div><div class="bar" role="img" aria-label="' + Math.round(f) + '% das vagas"><i style="width:' + Math.min(100, f) + '%"></i></div><div class="pct">' + Math.round(f) + '% das vagas</div></div></li>';
    }).join('') + '</ol>' : '<div class="empty">Nenhuma lacuna nas vagas analisadas.</div>';
    h += '</div>';
    if (P.fortes.length) h += '<div><div class="sec-title"><h2>Seus pontos fortes mais pedidos</h2></div><ol class="rank">' + P.fortes.slice(0, 6).map(function (g) {
      return '<li><div><strong>' + esc(g.nome) + '</strong></div><div><div class="bar ok"><i style="width:' + Math.min(100, g.provadoEm / g.de * 100) + '%"></i></div><div class="pct">provado em ' + g.provadoEm + ' de ' + g.de + ' vagas</div></div></li>';
    }).join('') + '</ol></div>';
    h += '<div class="card"><div class="sec-title"><h2>Plano da semana</h2><button class="pt-btn primary" data-act="plano">' + (plano ? 'Gerar de novo' : 'Gerar plano') + '</button></div><div class="out">' +
      (plano && plano.texto ? esc(plano.texto) : '<span class="muted">O plano diz quais 3 lacunas atacar, qual projeto fazer e quais vagas priorizar. É calculado com os dados acima, sem custo de IA.</span>') + '</div>' +
      (plano && plano.geradoEm ? '<div class="small muted" style="margin-top:8px">Gerado em ' + fmtData(plano.geradoEm) + '</div>' : '') + '</div>';
    return h;
  }

  function grafico(serie) {
    if (!serie || serie.length < 2) return '<p class="small muted">São precisos pelo menos 2 desfechos registrados para desenhar a curva.</p>';
    var W = 600, H = 190, L = 40, R = 12, T = 12, B = 26;
    var max = 0.4;
    serie.forEach(function (s) { max = Math.max(max, s.modelo, s.base); });
    max = Math.ceil(max * 10) / 10;
    var x = function (i) { return L + (W - L - R) * (serie.length === 1 ? 0 : i / (serie.length - 1)); };
    var y = function (v) { return T + (H - T - B) * (1 - v / max); };
    var pts = function (k) { return serie.map(function (s, i) { return x(i).toFixed(1) + ',' + y(s[k]).toFixed(1); }).join(' '); };
    var ticks = [0, max / 2, max].map(function (v) { return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--border)"/><text x="' + (L - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v.toFixed(2) + '</text>'; }).join('');
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Erro de previsão do modelo e da linha de base ao longo dos desfechos">' + ticks +
      '<polyline points="' + pts('base') + '" fill="none" stroke="var(--text-muted)" stroke-width="2" stroke-dasharray="5 4"/>' +
      '<polyline points="' + pts('modelo') + '" fill="none" stroke="var(--accent-light)" stroke-width="2.5"/>' +
      '<text x="' + L + '" y="' + (H - 6) + '">1</text><text x="' + (W - R) + '" y="' + (H - 6) + '" text-anchor="end">' + serie[serie.length - 1].i + ' desfechos</text></svg>' +
      '<div class="legend"><span><i class="dot" style="background:var(--accent-light)"></i>Modelo</span><span><i class="dot" style="background:var(--text-muted)"></i>Linha de base (taxa média até então)</span><span>menor é melhor</span></div>';
  }

  function aprendizadoView(A) {
    var m = A.modelo;
    var h = '<div class="pt-head"><div><h1>Aprendizado</h1><p class="lede">O que o Pontes já aprendeu com você e se está realmente melhorando. Cada previsão é conferida antes de o modelo ver o resultado.</p></div><button class="pt-btn" data-act="reconstruir">Reconstruir modelo</button></div>';
    h += '<div class="stats"><div class="card stat"><div class="n mono">' + m.n + '</div><div class="small muted">desfechos aprendidos (' + m.positivos + ' avançaram)</div></div>' +
      '<div class="card stat"><div class="n mono">' + Math.round(m.confianca * 100) + '%</div><div class="small muted">confiança nos dados reais</div><div class="bar ac" style="margin-top:8px"><i style="width:' + Math.round(m.confianca * 100) + '%"></i></div></div>' +
      '<div class="card stat"><div class="n" style="font-size:20px;padding-top:6px">' + (m.modo === 'aprendido' ? 'Aprendido' : 'Premissas iniciais') + '</div><div class="small muted">' + (m.modo === 'aprendido' ? 'o modelo já se apoia nos seus resultados' : 'faltam ' + m.faltam + ' desfechos para ele aprender só com os seus dados') + '</div></div></div>';
    h += '<div class="card"><div class="sec-title"><h2>O modelo está melhorando?</h2>' + (A.avaliacao.n >= 5 ? '<span class="small muted mono">erro atual: modelo ' + A.avaliacao.brierModelo.toFixed(3) + ' · base ' + A.avaliacao.brierBase.toFixed(3) + '</span>' : '') + '</div>' + grafico(A.avaliacao.serie) +
      '<p class="small muted" style="margin:10px 0 0">Com poucos desfechos a curva oscila bastante. Só confie na tendência depois de umas 20 candidaturas com resultado.</p></div>';
    h += '<div class="two"><div class="card"><h3 style="margin-bottom:10px">Lacunas que mais pesaram nos resultados</h3>' +
      (A.lacunasQuePesam.length ? '<div class="funnel">' + A.lacunasQuePesam.map(function (f) { return '<div class="f-row neg"><span title="' + esc(f.nome) + '" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(f.nome) + '</span><div class="bar"><i style="width:' + Math.min(100, Math.abs(f.peso) * 40) + '%"></i></div><span class="mono">' + f.peso.toFixed(1) + '</span></div>'; }).join('') + '</div><p class="small muted" style="margin:10px 0 0">Peso negativo maior = faltar isso mais se associou a não avançar. Observações por lacuna: ' + A.lacunasQuePesam.map(function (f) { return esc(f.nome) + ' ' + f.observacoes; }).join(', ') + '.</p>' : '<p class="small muted">Ainda sem dados suficientes por lacuna (mínimo de 2 observações).</p>') + '</div>' +
      '<div class="card"><h3 style="margin-bottom:10px">Casamento com evidências</h3><p style="margin:0">' + A.casamento.ajustes + ' ajuste(s) aprendido(s)</p><p class="small muted" style="margin:6px 0 0">' + A.casamento.confirmacoes + ' confirmação(ões) e ' + A.casamento.rejeicoes + ' rejeição(ões) recentes. Cada resposta sua melhora as próximas sugestões.</p>' +
      '<h3 style="margin:16px 0 8px">Efeito das pontes concluídas</h3>' + (A.pontes.length ? '<ul class="log">' + A.pontes.map(function (p) { return '<li><span>' + esc(p.ponte) + ': prova ' + (p.provaAntes == null ? '—' : Math.round(p.provaAntes * 100) + '%') + ' → ' + (p.provaDepois == null ? '—' : Math.round(p.provaDepois * 100) + '%') + ' <span class="muted">(' + p.vagasAntes + ' vagas antes, ' + p.vagasDepois + ' depois)</span></span></li>'; }).join('') + '</ul>' : '<p class="small muted">Quando você registrar uma ponte como concluída, o efeito nas vagas seguintes aparece aqui.</p>') + '</div></div>';
    var nomes = { aprendeu: 'Aprendeu com um desfecho', confirmou: 'Você confirmou um casamento', rejeitou: 'Você rejeitou um casamento', analisou: 'Vaga analisada', status: 'Mudança de situação', ponte_concluida: 'Ponte concluída', evidencia: 'Evidência adicionada', reconstruiu: 'Modelo reconstruído', excluiu: 'Vaga excluída' };
    h += '<div class="card"><h3 style="margin-bottom:10px">Atividade recente</h3>' + (A.eventos.length ? '<ul class="log">' + A.eventos.map(function (e) { return '<li><time>' + new Date(e.ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + '</time><span>' + esc(nomes[e.tipo] || e.tipo) + '</span></li>'; }).join('') + '</ul>' : '<p class="small muted">Nada ainda.</p>') + '</div>';
    return h;
  }

  function funilView(vagas) {
    var h = '<div class="pt-head"><div><h1>Funil</h1><p class="lede">Em que situação estão as candidaturas e onde as recusas acontecem.</p></div></div>';
    if (!vagas.length) return h + '<div class="empty"><h3>Sem candidaturas</h3><p>Adicione vagas e atualize a situação de cada uma.</p></div>';
    var cnt = {}, max = 1;
    STATUS.forEach(function (s) { cnt[s[0]] = vagas.filter(function (v) { return v.status === s[0]; }).length; if (cnt[s[0]] > max) max = cnt[s[0]]; });
    h += '<div class="card"><h3 style="margin-bottom:12px">Por situação</h3><div class="funnel">' + STATUS.map(function (s) {
      return '<div class="f-row' + (s[0] === 'recusada' || s[0] === 'descartada' ? ' neg' : '') + '"><span>' + s[1] + '</span><div class="bar"><i style="width:' + (cnt[s[0]] / max * 100) + '%"></i></div><span class="mono">' + cnt[s[0]] + '</span></div>';
    }).join('') + '</div></div>';
    var rec = vagas.filter(function (v) { return v.status === 'recusada'; });
    function grupo(campo, lista) {
      var m = {}; rec.forEach(function (v) { var k = v[campo] || 'desconhecido'; m[k] = (m[k] || 0) + 1; });
      var ks = Object.keys(m).sort(function (a, b) { return m[b] - m[a]; }), mx = ks.length ? m[ks[0]] : 1;
      return ks.map(function (k) { return '<div class="f-row neg"><span>' + esc(k === 'desconhecido' ? 'Não informado' : lbl(lista, k)) + '</span><div class="bar"><i style="width:' + (m[k] / mx * 100) + '%"></i></div><span class="mono">' + m[k] + '</span></div>'; }).join('');
    }
    h += rec.length ? '<div class="two"><div class="card"><h3 style="margin-bottom:12px">Onde as recusas aconteceram</h3><div class="funnel">' + grupo('etapaRecusa', ETAPAS) + '</div></div><div class="card"><h3 style="margin-bottom:12px">Motivos prováveis</h3><div class="funnel">' + grupo('motivoRecusa', MOTIVOS) + '</div></div></div>'
      : '<div class="empty">Quando você marcar uma vaga como recusada, o funil mostra etapa e motivo.</div>';
    return h;
  }


  /* ---------- currículo ---------- */
  function campo(nome, rot, v, o) {
    o = o || {};
    var cls = o.w ? ' style="flex:' + o.w + ';min-width:' + (o.min || 180) + 'px"' : '';
    if (o.area) return '<label' + cls + '>' + rot + '<textarea name="' + nome + '" style="min-height:' + (o.alt || 100) + 'px" maxlength="' + (o.max || 1200) + '" placeholder="' + esc(o.ph || '') + '">' + esc(v || '') + '</textarea></label>';
    return '<label' + cls + '>' + rot + '<input name="' + nome + '" maxlength="' + (o.max || 160) + '" value="' + esc(v || '') + '" placeholder="' + esc(o.ph || '') + '"></label>';
  }
  function curriculoView(perfil, evid, vagas) {
    var c = (perfil && perfil.cv) || {};
    var rev = evid.filter(function (e) { return e.revisar; }).length;
    var h = '<div class="pt-head"><div><h1>Currículo</h1><p class="lede">Montado com os seus dados e as evidências que você já conferiu. Nada é inventado: a IA não escreve o currículo. Para uma vaga, as evidências que provam os requisitos dela sobem na ordem.</p></div></div>';
    h += '<div class="card"><div class="sec-title"><h3>Baixar</h3></div><div class="row">' +
      '<label style="flex:2;min-width:220px">Ajustar para uma vaga (opcional)<select id="cv-vaga"><option value="">Versão geral</option>' +
      vagas.filter(function (v) { return v.analisada; }).map(function (v) { return '<option value="' + v.id + '">' + esc((v.titulo || 'Vaga') + (v.empresa ? ' — ' + v.empresa : '')) + '</option>'; }).join('') + '</select></label>' +
      '<button class="pt-btn primary" data-act="baixar" data-f="docx">Word (.docx)</button>' +
      '<button class="pt-btn" data-act="baixar" data-f="html">PDF (abrir e imprimir)</button>' +
      '<button class="pt-btn" data-act="baixar" data-f="md">Texto (.md)</button></div>' +
      '<p class="small muted" style="margin:10px 0 0">' + evid.filter(function (e) { return !e.revisar; }).length + ' evidência(s) entram como competências e provas.' + (rev ? ' ' + rev + ' marcada(s) para revisar ficam de fora até você editá-las.' : '') + ' No celular, o PDF sai pelo menu Compartilhar › Imprimir.</p></div>';
    h += '<form class="card" data-form="cv" style="display:grid;gap:12px"><div class="sec-title"><h3>Dados do currículo</h3></div>' +
      '<div class="row">' + campo('nome', 'Nome completo', c.nome, { w: 2, ph: 'Como deve aparecer no topo' }) + campo('titulo', 'Título profissional', c.titulo, { w: 2, ph: 'Ex.: Engenheiro de Dados' }) + '</div>' +
      '<div class="row">' + campo('cidade', 'Cidade', c.cidade, { w: 1, min: 140 }) + campo('email', 'E-mail', c.email, { w: 1, min: 160 }) + campo('telefone', 'Telefone', c.telefone, { w: 1, min: 140 }) + '</div>' +
      '<div class="row">' + campo('linkedin', 'LinkedIn', c.linkedin, { w: 1, ph: 'linkedin.com/in/…' }) + campo('github', 'GitHub', c.github, { w: 1, ph: 'github.com/…' }) + '</div>' +
      campo('resumo', 'Resumo profissional', c.resumo, { area: true, alt: 110, ph: '3 a 4 linhas: quem você é, o que entrega, em que contexto.' }) +
      campo('experiencias', 'Experiência', c.experiencias, { area: true, alt: 220, max: 8000, ph: 'Cargo — Empresa (mês/ano – mês/ano)\n- o que você fez, com resultado\n- outra entrega\n\n(linha em branco separa um cargo do outro)' }) +
      campo('formacao', 'Formação', c.formacao, { area: true, alt: 110, max: 3000, ph: 'Pós-graduação em Engenharia de Dados e IA — Anhanguera (em andamento)\n\nLicenciatura em Matemática — Instituição' }) +
      campo('idiomas', 'Idiomas', c.idiomas, { ph: 'Ex.: Português (nativo) · Inglês (técnico)' }) +
      '<div class="row" style="justify-content:flex-end"><button class="pt-btn primary">Salvar dados</button></div></form>';
    return h;
  }


  /* ---------- meu perfil: currículo, LinkedIn e portfólios ---------- */
  function perfilFontesView(F, evid) {
    var cur = F.curriculo || {}, li = F.linkedin || {}, ps = F.portfolios || [];
    var n = function (t) { return t ? String(t.length).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' caracteres salvos' : 'Nada salvo ainda'; };
    var h = '<div class="pt-head"><div><h1>Meu perfil</h1><p class="lede">É aqui que você entrega o material para a IA avaliar o seu perfil: currículo atual, LinkedIn e portfólios. Ela lê tudo, <b>propõe evidências</b> e só entram na sua base as que você aprovar.</p></div></div>';
    h += '<form data-form="fontes" style="display:grid;gap:16px">';
    h += '<div class="card" style="display:grid;gap:10px"><div class="sec-title"><h3>1. Currículo atual</h3><span class="small muted">' + n(cur.texto) + (cur.nome ? ' · ' + esc(cur.nome) : '') + '</span></div>' +
      '<label>Enviar arquivo (PDF, Word .docx, .txt ou .md)<input type="file" data-alvo="curriculoTexto" data-nome="curriculoNome" accept=".pdf,.docx,.txt,.md,application/pdf"></label>' +
      '<input type="hidden" name="curriculoNome" value="' + esc(cur.nome || '') + '">' +
      '<label>Ou cole o texto do currículo aqui<textarea name="curriculoTexto" style="min-height:200px" maxlength="30000" placeholder="O texto do arquivo enviado aparece aqui para você conferir. Pode editar.">' + esc(cur.texto || '') + '</textarea></label></div>';
    h += '<div class="card" style="display:grid;gap:10px"><div class="sec-title"><h3>2. LinkedIn</h3><span class="small muted">' + n(li.texto) + '</span></div>' +
      '<label>Endereço do seu perfil<input name="linkedinUrl" maxlength="400" value="' + esc(li.url || '') + '" placeholder="https://www.linkedin.com/in/seu-nome"></label>' +
      '<label>Enviar o PDF do seu perfil<input type="file" data-alvo="linkedinTexto" accept=".pdf,.docx,.txt,.md,application/pdf"></label>' +
      '<label>Ou cole o texto do perfil (Sobre, Experiência, Competências)<textarea name="linkedinTexto" style="min-height:160px" maxlength="30000">' + esc(li.texto || '') + '</textarea></label>' +
      '<p class="small muted" style="margin:0">O LinkedIn não permite que programas leiam o perfil pelo endereço (exige login e proíbe a coleta). Por isso a leitura vem do PDF do próprio perfil: no LinkedIn, abra seu perfil › <b>Mais</b> › <b>Salvar como PDF</b>, e envie aqui.</p></div>';
    h += '<div class="card" style="display:grid;gap:10px"><div class="sec-title"><h3>3. Portfólios e projetos</h3><span class="small muted">' + ps.length + ' endereço(s)</span></div>' +
      '<label>Um endereço por linha (GitHub, site pessoal, repositórios, artigos)<textarea name="portfolios" style="min-height:110px" maxlength="2000" placeholder="https://github.com/seu-usuario\nhttps://seu-site.com">' + esc(ps.map(function (x) { return x.url; }).join('\n')) + '</textarea></label>' +
      (ps.length ? '<div class="vagas">' + ps.map(function (x) {
        return '<div class="vaga" style="grid-template-columns:1fr auto"><div><div class="v-title" style="word-break:break-all">' + esc(x.url) + '</div><div class="small muted">' + (x.erro ? '<span style="color:var(--pt-red,#f87171)">' + esc(x.erro) + '</span>' : x.texto ? 'Lido em ' + esc(fmtData(x.lidoEm)) + ' · ' + x.texto.length + ' caracteres' : 'Ainda não lido') + '</div></div></div>';
      }).join('') + '</div>' : '') +
      '<div class="row"><button type="button" class="pt-btn" data-act="ler-portfolios">Ler portfólios agora</button></div>' +
      '<p class="small muted" style="margin:0">GitHub é lido pela API pública (perfil, repositórios e README). Sites comuns são lidos como texto; páginas que só aparecem com JavaScript podem vir vazias.</p></div>';
    h += '<div class="row" style="justify-content:flex-end"><button class="pt-btn primary">Salvar fontes</button></div></form>';
    var prop = state.proposta;
    h += '<div class="card" id="extrair" style="display:grid;gap:10px"><div class="sec-title"><h3>4. Ler as três fontes e extrair evidências</h3></div>' +
      '<p class="small muted" style="margin:0">A IA lê o que está salvo acima e sugere habilidades e entregas com a prova de cada uma. Nada é salvo até você aprovar. Hoje você tem ' + evid.length + ' evidência(s).</p>' +
      '<div class="row"><button type="button" class="pt-btn primary" data-act="propor" id="btn-propor">Extrair evidências com IA</button></div></div>';
    if (prop) {
      var cvVazios = Object.keys(prop.cv || {}).filter(function (k) { return prop.cv[k]; });
      h += '<form class="card" data-form="proposta" style="display:grid;gap:10px"><div class="sec-title"><h3>Revise as sugestões (' + prop.evidencias.length + ')</h3>' +
        '<div class="row"><button type="button" class="pt-btn sm" data-act="marcar" data-v="1">Marcar todas</button><button type="button" class="pt-btn sm" data-act="marcar" data-v="0">Desmarcar</button></div></div>' +
        (prop.evidencias.length ? '<div class="grid">' + prop.evidencias.map(function (e, i) {
          return '<label class="card ev" style="cursor:pointer;display:block;font-weight:400;color:inherit"><div class="ev-top"><h3><input type="checkbox" name="sel" value="' + i + '" checked> ' + esc(e.skill) + '</h3><span><span class="lvl">' + esc(e.nivel) + '</span> <span class="tag">' + esc(e.fonte) + '</span></span></div><p>' + (esc(e.prova) || 'Sem descrição.') + '</p>' + (e.link ? '<div class="small muted" style="word-break:break-all">' + esc(e.link) + '</div>' : '') + '</label>';
        }).join('') + '</div>' : '<div class="empty" style="border:0">Nenhuma evidência nova: o que a IA encontrou já está cadastrado.</div>') +
        (cvVazios.length ? '<label class="check"><input type="checkbox" name="preencherCv" checked> Preencher os dados do currículo que estão vazios (' + cvVazios.map(function (k) { return esc(k); }).join(', ') + ')</label>' : '') +
        '<div class="row" style="justify-content:flex-end"><button type="button" class="pt-btn" data-act="descartar-proposta">Descartar</button><button class="pt-btn primary">Adicionar selecionadas</button></div></form>';
    }
    return h;
  }

  function salvarDoForm() {
    var f = $('form[data-form="fontes"]'); if (!f) return Promise.resolve(null);
    var fd = new FormData(f);
    return api('PUT', '/fontes', { curriculoTexto: fd.get('curriculoTexto'), curriculoNome: fd.get('curriculoNome'), linkedinUrl: fd.get('linkedinUrl'), linkedinTexto: fd.get('linkedinTexto'), portfolios: fd.get('portfolios') });
  }
  function pdfParaTexto(file) {
    function carregar() {
      if (window.pdfjsLib) return Promise.resolve();
      return new Promise(function (ok, no) {
        var sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        sc.onload = ok; sc.onerror = function () { no(new Error('Não consegui carregar o leitor de PDF. Envie em .docx ou cole o texto.')); }; document.head.appendChild(sc);
      });
    }
    return carregar().then(function () {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      return file.arrayBuffer();
    }).then(function (buf) { return window.pdfjsLib.getDocument({ data: buf }).promise; }).then(async function (pdf) {
      var out = [];
      for (var p = 1; p <= pdf.numPages; p++) {
        var tc = await (await pdf.getPage(p)).getTextContent(), y = null, linha = '';
        tc.items.forEach(function (it) {
          var yy = it.transform ? Math.round(it.transform[5]) : null;
          if (y !== null && yy !== null && Math.abs(yy - y) > 3) { out.push(linha); linha = ''; }
          linha += it.str + (it.hasEOL ? '\n' : ''); y = yy;
        });
        out.push(linha, '');
      }
      var t = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (t.length < 30) throw new Error('Este PDF parece ser uma imagem (sem texto). Cole o texto manualmente.');
      return t;
    });
  }

  /* ---------- radar ---------- */
  function radarView(R) {
    var c = R.config, u = R.ultimo;
    var h = '<div class="pt-head"><div><h1>Radar de vagas</h1><p class="lede">Todo dia às ' + esc(R.proxima) + ' busca vagas em fontes públicas, descarta as que você já viu e importa as que mais combinam com as suas evidências. As melhores já chegam analisadas, com a chance estimada de avançar.</p></div>' +
      '<button class="pt-btn primary" data-act="radar-agora"' + (R.emExecucao ? ' disabled' : '') + '>' + (R.emExecucao ? 'Buscando…' : 'Buscar agora') + '</button></div>';
    if (R.emExecucao) h += '<div class="card"><b>Buscando vagas…</b><div class="small muted">Pode levar alguns minutos, principalmente com a análise por IA. A página atualiza sozinha.</div><div class="progress"><i></i></div></div>';
    if (u) {
      var fontes = Object.keys(u.fontes || {}).map(function (k) { var f = u.fontes[k]; return '<span class="lvl">' + esc(k) + ': ' + (f.erro ? 'falhou (' + esc(f.erro) + ')' : f.ok + ' busca(s) ok') + '</span>'; }).join(' ');
      h += '<div class="card"><div class="sec-title"><h3>Última busca</h3><span class="small muted">' + esc(new Date(u.em).toLocaleString('pt-BR')) + (u.manual ? ' · manual' : '') + '</span></div>' +
        '<p style="margin:0 0 8px">' + u.encontradas + ' encontrada(s) · <b>' + (u.novas || []).length + ' nova(s)</b> importada(s) · ' + (u.analisadas || []).length + ' analisada(s)</p>' +
        '<div class="row" style="margin-bottom:8px">' + fontes + '</div>' +
        ((u.erros || []).length ? u.erros.map(function (e) { return '<div class="alert">' + esc(e) + '</div>'; }).join('') : '') +
        ((u.novas || []).length ? '<p class="small muted" style="margin:8px 0 0">Vagas analisadas mostram a <b>aderência</b> real (calculada com as suas evidências aprovadas). As demais mostram só uma <b>pré-triagem</b> aproximada, feita antes da análise: abra a vaga e clique em Analisar com IA para o número verdadeiro.</p><div class="vagas" style="margin-top:8px">' + u.novas.map(function (n) {
          var num = n.analisada
            ? '<div class="v-score" title="Aderência real, após a análise">' + pct(n.aderencia) + '<div class="small muted" style="font-weight:400">aderência' + (n.pAvancar == null ? '' : ' · chance ' + Math.round(n.pAvancar * 100) + '%') + '</div></div>'
            : '<div class="v-score muted" title="Estimativa local antes da análise com IA">~' + Math.round(n.score * 100) + '%<div class="small muted" style="font-weight:400">pré-triagem</div></div>';
          return '<a class="vaga" href="#vaga-' + n.id + '"><div><div class="v-title">' + esc(n.titulo) + '</div><div class="small muted">' + esc(n.empresa) + ' · ' + esc(n.fonte.replace('radar:', '')) + (n.bloqueio ? ' · <span style="color:var(--pt-amber,#fbbf24)">pode exigir residência fora do Brasil</span>' : '') + '</div></div>' + num + '</a>';
        }).join('') + '</div>' : '') + '</div>';
    } else h += '<div class="empty"><h3>Ainda sem buscas</h3><p>A primeira roda amanhã às 08:30, ou agora no botão acima.</p></div>';
    h += '<form class="card" data-form="radar" style="display:grid;gap:12px"><div class="sec-title"><h3>O que procurar</h3></div>' +
      '<label class="check"><input type="checkbox" name="ativo"' + (c.ativo ? ' checked' : '') + '> Busca automática diária ligada</label>' +
      campo('consultas', 'Buscas em português (Gupy), separadas por vírgula', (c.consultas || []).join(', '), { max: 300 }) +
      campo('consultasEn', 'Buscas em inglês (vagas remotas, Remotive)', (c.consultasEn || []).join(', '), { max: 300 }) +
      campo('excluir', 'Ignorar títulos que contenham', (c.excluir || []).join(', '), { max: 300 }) +
      campo('paginasExtras', 'Páginas de busca de outros sites (Jobgether, BeBee…), uma por linha', (c.paginasExtras || []).join('\n'), { area: true, alt: 90, max: 1500, ph: 'Cole aqui o endereço da página de resultados, depois de filtrar a busca no próprio site.' }) +
      '<p class="small muted" style="margin:-4px 0 0">O radar lê essas páginas pelos dados de vaga que o site publica para o Google, respeitando o robots.txt e com poucas requisições por dia. Se um site não publicar esses dados ou bloquear robôs, o motivo aparece em “Última busca”.</p>' +
      '<div class="row"><button type="button" class="pt-btn sm" data-act="testar-paginas">Testar estas páginas</button></div><div id="teste-paginas" aria-live="polite"></div>' +
      '<div class="row"><label class="check"><input type="checkbox" name="jobgether"' + (c.jobgether !== false ? ' checked' : '') + '> Jobgether (feed liberado pelo site para IA; só vagas abertas ao Brasil)</label></div>' +
      '<div class="row"><label class="check"><input type="checkbox" name="gupy"' + (c.gupy ? ' checked' : '') + '> Gupy</label><label class="check"><input type="checkbox" name="remotive"' + (c.remotive ? ' checked' : '') + '> Remotive</label></div>' +
      '<div class="row">' + campo('maxNovas', 'Máximo de vagas novas por dia', c.maxNovas, { w: 1, min: 140, max: 3 }) + campo('analisarTop', 'Analisar com IA as primeiras', c.analisarTop, { w: 1, min: 140, max: 2 }) + campo('diasMax', 'Ignorar anúncios com mais de (dias)', c.diasMax, { w: 1, min: 140, max: 3 }) + '</div>' +
      '<p class="small muted" style="margin:0">Cada análise usa uma chamada de IA dos provedores configurados. Use 0 para só importar. LinkedIn e Indeed não entram: os termos de uso proíbem a coleta automática.</p>' +
      '<div class="row" style="justify-content:flex-end"><button class="pt-btn primary">Salvar</button></div></form>';
    return h;
  }

  /* ---------- render ---------- */
  var seq = 0;
  async function render() {
    renderTabs();
    var my = ++seq, r = route(), view = $('#view'), y = window.scrollY, html = '';
    try {
      if (r.name === 'vaga') {
        var res = await Promise.all([api('GET', '/vagas/' + r.id), api('GET', '/evidencias')]);
        var evid = {}; res[1].forEach(function (e) { evid[e.id] = e; });
        html = vagaView(res[0], evid);
      } else if (r.name === 'evidencias') {
        var e2 = await Promise.all([api('GET', '/evidencias'), api('GET', '/perfil')]);
        html = evidenciasView(e2[0], e2[1]);
      } else if (r.name === 'padroes') {
        var p2 = await Promise.all([api('GET', '/padroes'), api('GET', '/perfil')]);
        html = padroesView(p2[0], p2[1].plano);
      } else if (r.name === 'aprendizado') {
        html = aprendizadoView(await api('GET', '/aprendizado'));
      } else if (r.name === 'perfil') {
        var pf = await Promise.all([api('GET', '/fontes'), api('GET', '/evidencias')]);
        html = perfilFontesView(pf[0], pf[1]);
      } else if (r.name === 'curriculo') {
        var c2 = await Promise.all([api('GET', '/perfil'), api('GET', '/evidencias'), api('GET', '/vagas')]);
        html = curriculoView(c2[0], c2[1], c2[2]);
      } else if (r.name === 'radar') {
        var R = await api('GET', '/radar');
        html = radarView(R);
        if (R.emExecucao) { clearTimeout(radarTimer); radarTimer = setTimeout(function () { if (route().name === 'radar') render(); }, 6000); }
      } else if (r.name === 'funil') {
        html = funilView(await api('GET', '/vagas'));
      } else {
        html = vagasView(await api('GET', '/vagas'));
      }
    } catch (e) {
      html = '<div class="banner">' + esc(e.status === 404 ? 'Não encontrado.' : e.message) + (r.name === 'vaga' ? ' <a href="#vagas">Voltar às vagas</a>' : '') + '</div>';
    }
    if (my !== seq) return;
    view.innerHTML = html;
    window.scrollTo(0, y);
  }

  /* ---------- modal ---------- */
  function openModal(html) { var m = $('#modal'); m.innerHTML = '<div class="sheet" role="dialog" aria-modal="true">' + html + '</div>'; m.hidden = false; document.body.classList.add('lock'); var f = m.querySelector('input,textarea,select'); if (f) f.focus(); }
  function closeModal() { if (ctl) { try { ctl.abort(); } catch (e) {} ctl = null; } var m = $('#modal'); m.hidden = true; m.innerHTML = ''; document.body.classList.remove('lock'); }

  function formEvid(e) {
    e = e || {};
    return '<h2>' + (e.id ? 'Editar evidência' : (e.origemPonte ? 'Registrar ponte concluída' : 'Nova evidência')) + '</h2><form data-form="evid" style="display:contents"><input type="hidden" name="id" value="' + esc(e.id || '') + '"><input type="hidden" name="origemPonte" value="' + esc(e.origemPonte || '') + '">' +
      '<label>Habilidade ou entrega<input name="skill" required maxlength="120" value="' + esc(e.skill || '') + '" placeholder="Ex.: Apache Airflow, pipeline medalhão, SAP MM"></label>' +
      '<label>Nível<select name="nivel">' + NIVEIS.map(function (n) { return '<option' + ((e.nivel || 'Não definido') === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label>' +
      '<label>O que isso prova<textarea name="prova" maxlength="1200" placeholder="Onde e como você usou: projeto, cargo, resultado.">' + esc(e.prova || '') + '</textarea></label>' +
      '<label>Link (opcional)<input name="link" maxlength="400" value="' + esc(e.link || '') + '" placeholder="https://github.com/…"></label>' +
      '<div class="row" style="justify-content:flex-end"><button type="button" class="pt-btn" data-act="fechar">Cancelar</button><button class="pt-btn primary">Salvar</button></div></form>';
  }
  function formVaga() {
    return '<h2>Nova vaga</h2><form data-form="vaga" style="display:contents"><label>Texto da vaga<textarea name="texto" required style="min-height:220px" maxlength="20000" placeholder="Cole aqui a descrição completa do anúncio."></textarea></label>' +
      '<div class="row"><label style="flex:1;min-width:180px">Título (opcional)<input name="titulo" maxlength="140"></label><label style="flex:1;min-width:180px">Empresa (opcional)<input name="empresa" maxlength="120"></label></div>' +
      '<div class="row"><label style="flex:2;min-width:200px">Link do anúncio (opcional)<input name="url" maxlength="400" placeholder="https://…"></label><label style="flex:1;min-width:140px">Onde achou (opcional)<input name="fonte" maxlength="60" placeholder="Gupy, LinkedIn…"></label></div>' +
      '<label class="check"><input type="checkbox" name="analisar" checked> Analisar com IA ao salvar</label>' +
      '<div class="row" style="justify-content:flex-end"><button type="button" class="pt-btn" data-act="fechar">Cancelar</button><button class="pt-btn primary">Adicionar</button></div></form>';
  }
  function formPerfil(p) {
    p = p || {};
    return '<h2>Perfil de busca</h2><form data-form="perfil" style="display:contents">' +
      '<label>Alvo salarial<input name="alvo" maxlength="160" value="' + esc(p.alvo || '') + '" placeholder="Ex.: R$ 11–16 mil CLT"></label>' +
      '<label>Lacunas declaradas, separadas por vírgula<input name="lacunas" maxlength="400" value="' + esc((p.lacunas || []).join(', ')) + '" placeholder="Ex.: AWS, Kafka"></label>' +
      '<label>Observações que a IA deve levar em conta<textarea name="obs" maxlength="800">' + esc(p.obs || '') + '</textarea></label>' +
      '<div class="row" style="justify-content:flex-end"><button type="button" class="pt-btn" data-act="fechar">Cancelar</button><button class="pt-btn primary">Salvar</button></div></form>';
  }

  /* ---------- ações ---------- */
  async function tentar(fn) { try { return await fn(); } catch (e) { toast(e.message || 'Algo deu errado.'); return null; } }

  async function analisar(id) {
    if (state.busy[id]) return;
    state.busy[id] = true; render();
    try { await api('POST', '/vagas/' + id + '/analisar'); } catch (e) { toast(e.message); }
    delete state.busy[id]; render();
  }

  var ACTS = {
    'nova-vaga': function () { openModal(formVaga()); },
    'nova-evid': function () { openModal(formEvid()); },
    'edit-evid': async function (d) { var l = await tentar(function () { return api('GET', '/evidencias'); }); var e = (l || []).filter(function (x) { return String(x.id) === d.id; })[0]; if (e) openModal(formEvid(e)); },
    'edit-perfil': async function () { var p = await tentar(function () { return api('GET', '/perfil'); }); if (p) openModal(formPerfil(p)); },
    'concluir-ponte': function (d) { openModal(formEvid({ skill: d.nome, origemPonte: d.nome, nivel: 'Básico' })); },
    'ler-portfolios': async function (d, b) {
      b.disabled = true; b.textContent = 'Lendo…';
      var ok = await tentar(function () { return salvarDoForm().then(function () { return api('POST', '/fontes/portfolios/ler'); }); });
      if (ok) toast('Portfólios lidos.'); render();
    },
    propor: async function (d, b) {
      b.disabled = true; b.textContent = 'Lendo e extraindo… pode levar 1 a 2 minutos';
      var r = await tentar(function () { return salvarDoForm().then(function () { return api('POST', '/fontes/propor'); }); });
      if (r) { state.proposta = r; toast(r.evidencias.length + ' sugestão(ões). Revise abaixo.'); }
      await render();
      var el = $('form[data-form="proposta"]'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    marcar: function (d) { document.querySelectorAll('form[data-form="proposta"] input[name=sel]').forEach(function (c) { c.checked = d.v === '1'; }); },
    'descartar-proposta': function () { state.proposta = null; render(); },
    baixar: async function (d) {
      var v = $('#cv-vaga') ? $('#cv-vaga').value : '';
      var url = '/api/pontes/curriculo?formato=' + d.f + (v ? '&vaga=' + v : '');
      if (d.f === 'html') { window.open(url, '_blank', 'noopener'); return; }
      try {
        var r = await fetch(url, { credentials: 'same-origin' });
        if (!r.ok) { var j = await r.json().catch(function () { return {}; }); throw new Error(j.error || 'Falha ao gerar o arquivo.'); }
        var nome = ((r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/) || [])[1] || ('curriculo.' + d.f);
        var blob = await r.blob(), a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = nome; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      } catch (e) { toast(e.message); }
    },
    'testar-paginas': async function (d, b) {
      var linhas = String(($('textarea[name=paginasExtras]') || {}).value || '').split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean);
      var box = $('#teste-paginas'); if (!box) return;
      if (!linhas.length) { box.innerHTML = '<div class="alert">Cole ao menos um endereço acima.</div>'; return; }
      b.disabled = true; box.innerHTML = '<div class="small muted">Testando… cada página pode levar até meio minuto.</div>';
      var out = [];
      for (var i = 0; i < linhas.length; i++) {
        try {
          var r = await api('POST', '/radar/testar', { url: linhas[i] });
          out.push(r.ok
            ? '<div class="card"><b style="color:var(--pt-green,#34d399)">' + r.total + ' vaga(s) encontrada(s)</b> <span class="small muted" style="word-break:break-all">' + esc(r.url) + '</span><ul class="small" style="margin:6px 0 0;padding-left:18px">' + r.amostra.map(function (v) { return '<li>' + esc(v.titulo) + (v.empresa ? ' — ' + esc(v.empresa) : '') + '</li>'; }).join('') + '</ul></div>'
            : '<div class="alert"><span style="word-break:break-all">' + esc(r.url) + '</span><br>Não dá para ler: ' + esc(r.motivo) + '</div>');
        } catch (e) { out.push('<div class="alert">' + esc(linhas[i]) + '<br>' + esc(e.message) + '</div>'); }
        box.innerHTML = out.join('') + (i < linhas.length - 1 ? '<div class="small muted">Testando a próxima…</div>' : '');
      }
      b.disabled = false;
    },
    'radar-agora': async function () { var r = await tentar(function () { return api('POST', '/radar/executar'); }); if (r) toast('Busca iniciada. Os resultados aparecem aqui.'); render(); },
    filtro: function (d) { state.filtro = d.k; render(); },
    analisar: function (d) { analisar(parseInt(d.id, 10)); },
    sug: async function (d) { await tentar(function () { return api('POST', '/vagas/' + d.v + '/requisitos/' + d.i + '/' + d.a); }); render(); },
    plano: async function (b) { b.disabled = true; await tentar(function () { return api('POST', '/plano'); }); render(); },
    reconstruir: async function () { var r = await tentar(function () { return api('POST', '/modelo/reconstruir'); }); if (r) toast('Modelo reconstruído com ' + r.exemplos + ' desfecho(s).'); render(); },
    fechar: function () { closeModal(); },
    copiar: function () {
      var el = $('#carta-out'); if (!el) return;
      var fb = function () { var r = document.createRange(); r.selectNodeContents(el); var s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Texto selecionado. Use Ctrl+C para copiar.'); };
      try { navigator.clipboard.writeText(el.textContent).then(function () { toast('Copiado.'); }, fb); } catch (e) { fb(); }
    },
    carta: async function (d) {
      openModal('<h2>Carta de apresentação</h2><div class="out" id="carta-out">Redigindo… pode levar alguns segundos.</div><div class="row" style="justify-content:flex-end"><button class="pt-btn" data-act="copiar">Copiar</button><button class="pt-btn primary" data-act="fechar">Fechar</button></div>');
      try { var r = await api('POST', '/vagas/' + d.id + '/carta'); var o = $('#carta-out'); if (o) o.textContent = r.texto; }
      catch (e) { var o2 = $('#carta-out'); if (o2) o2.textContent = e.message; }
    },
    'del-vaga': async function (d) {
      var k = 'v:' + d.id; if (state.confirm !== k) { state.confirm = k; render(); return; }
      state.confirm = ''; var r = await tentar(function () { return api('DELETE', '/vagas/' + d.id); }); if (r) location.hash = '#vagas'; else render();
    },
    'del-evid': async function (d) {
      var k = 'e:' + d.id; if (state.confirm !== k) { state.confirm = k; render(); return; }
      state.confirm = ''; await tentar(function () { return api('DELETE', '/evidencias/' + d.id); }); render();
    }
  };

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (b && ACTS[b.dataset.act]) { ACTS[b.dataset.act](b.dataset, b); return; }
    if (e.target.id === 'modal') closeModal();
    if (state.confirm && !e.target.closest('[data-act^="del-"]')) { state.confirm = ''; render(); }
  });
  document.addEventListener('change', async function (e) {
    var t = e.target, campo = null;
    if (t.id === 'status-sel') campo = 'status'; else if (t.id === 'etapa-sel') campo = 'etapaRecusa'; else if (t.id === 'motivo-sel') campo = 'motivoRecusa';
    if (campo) {
      var body = {}; body[campo] = t.value;
      var r = await tentar(function () { return api('PATCH', '/vagas/' + t.dataset.id, body); });
      if (r && r.aprendizado && r.aprendizado.aprendeu) toast('O modelo aprendeu com este desfecho.');
      render();
    } else if (t.id === 'sort') { state.sort = t.value; render(); }
  });
  document.addEventListener('change', async function (e) {
    var t = e.target;
    if (!(t.matches && t.matches('input[type=file][data-alvo]')) || !t.files[0]) return;
    var file = t.files[0], alvo = $('textarea[name=' + t.dataset.alvo + ']');
    toast('Lendo ' + file.name + '…');
    try {
      var texto;
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') texto = await pdfParaTexto(file);
      else {
        var r = await fetch('/api/pontes/fontes/arquivo?nome=' + encodeURIComponent(file.name), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', Accept: 'application/json' }, body: await file.arrayBuffer() });
        var j = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(j.error || 'Falha ao ler o arquivo.');
        texto = j.texto;
      }
      alvo.value = texto.slice(0, 30000);
      if (t.dataset.nome) { var nm = $('input[name=' + t.dataset.nome + ']'); if (nm) nm.value = file.name; }
      toast('Texto extraído (' + texto.length + ' caracteres). Confira abaixo e clique em Salvar fontes.');
    } catch (err) { toast(err.message || 'Não foi possível ler o arquivo.'); }
    t.value = '';
  });
  document.addEventListener('toggle', function (e) { var t = e.target; if (t.matches && t.matches('details.orig')) state.textoAberto[t.dataset.id] = t.open; }, true);

  $('#modal').addEventListener('submit', async function (e) {
    e.preventDefault();
    var f = e.target, fd = new FormData(f), k = f.dataset.form;
    if (k === 'evid') {
      var id = fd.get('id'), body = { skill: fd.get('skill'), nivel: fd.get('nivel'), prova: fd.get('prova'), link: fd.get('link'), origemPonte: fd.get('origemPonte') || undefined };
      var r = await tentar(function () { return id ? api('PUT', '/evidencias/' + id, body) : api('POST', '/evidencias', body); });
      if (r) {
        closeModal();
        var n = (r.impacto || []).length;
        if (n) toast(n + ' vaga(s) ganharam sugestões de casamento. Confirme na página de cada vaga.');
        render();
      }
    } else if (k === 'vaga') {
      var r2 = await tentar(function () { return api('POST', '/vagas', { texto: fd.get('texto'), titulo: fd.get('titulo'), empresa: fd.get('empresa'), url: fd.get('url'), fonte: fd.get('fonte') }); });
      if (r2) { closeModal(); location.hash = '#vaga-' + r2.id; if (fd.get('analisar')) analisar(r2.id); }
    } else if (k === 'perfil') {
      var r3 = await tentar(function () { return api('PUT', '/perfil', { alvo: fd.get('alvo'), lacunas: String(fd.get('lacunas') || ''), obs: fd.get('obs') }); });
      if (r3) { closeModal(); render(); }
    }
  });

  $('#view').addEventListener('submit', async function (e) {
    e.preventDefault();
    var f = e.target, fd = new FormData(f), k = f.dataset.form, o = {};
    fd.forEach(function (v, key) { o[key] = v; });
    if (k === 'fontes') {
      var rf = await tentar(function () { return salvarDoForm(); });
      if (rf) { toast('Fontes salvas.'); render(); }
      return;
    }
    if (k === 'proposta') {
      var sel = fd.getAll('sel').map(Number), prop = state.proposta;
      if (!prop) return;
      var body = { evidencias: sel.map(function (i) { return prop.evidencias[i]; }).filter(Boolean), preencherCv: !!fd.get('preencherCv'), cv: prop.cv };
      var ra = await tentar(function () { return api('POST', '/fontes/aplicar', body); });
      if (ra) {
        state.proposta = null;
        toast(ra.criadas + ' evidência(s) adicionada(s)' + (ra.cvPreenchido.length ? ' e ' + ra.cvPreenchido.length + ' campo(s) do currículo preenchido(s)' : '') + '.');
        location.hash = '#evidencias'; render();
      }
      return;
    }
    if (k === 'cv') {
      var r = await tentar(function () { return api('PUT', '/curriculo', o); });
      if (r) toast('Dados do currículo salvos.');
    } else if (k === 'radar') {
      o.ativo = !!fd.get('ativo'); o.jobgether = !!fd.get('jobgether'); o.gupy = !!fd.get('gupy'); o.remotive = !!fd.get('remotive');
      var r2 = await tentar(function () { return api('PUT', '/radar', o); });
      if (r2) { toast('Radar atualizado.'); render(); }
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
  window.addEventListener('hashchange', function () { render(); window.scrollTo(0, 0); });

  render();
})();
