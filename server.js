const express  = require('express');
const fetch    = require('node-fetch');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const TG_TOKEN    = process.env.TG_TOKEN    || '8826929533:AAH5CdY8yBf9p-2CM-JDYLz_ppu7bkxN5wQ';
const TG_CHAT_ID  = process.env.TG_CHAT_ID  || '7324646421';
const TG_CHAT_IDS = [TG_CHAT_ID, '-1003914910677'];
const PORT        = process.env.PORT        || 3000;
const FUTATS_TOKEN = 'w8e6q2xa';
const FUTATS_BASE  = 'https://gz.futats.com/opta';

const DATA_FILE  = path.join(__dirname, 'dados.json');
const PEND_FILE  = path.join(__dirname, 'pendentes.json');

function lerArquivo(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function salvarArquivo(file, data) {
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
}

let dadosHist = lerArquivo(DATA_FILE, []);
let pendentes = lerArquivo(PEND_FILE, []);

// Estado live por jogo
let estadoLive = {};

function dataHoje() {
  return new Date(new Date().getTime() - 3*60*60*1000).toISOString().split('T')[0];
}
function agoraBRT() {
  return new Date(new Date().getTime() - 3*60*60*1000);
}
function horaBRT() {
  return agoraBRT().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
}

// ── LINKS EXCHANGES ──────────────────────────────────────────
function linksExchanges(urls) {
  if (!urls) return '';
  const links = [];
  if (urls.url_betfair)       links.push(`<a href="${urls.url_betfair}">Betfair</a>`);
  if (urls.url_bolsadeaposta) links.push(`<a href="${urls.url_bolsadeaposta}">Bolsa</a>`);
  if (urls.url_betbra)        links.push(`<a href="${urls.url_betbra}">BetBra</a>`);
  if (urls.url_fulltbet)      links.push(`<a href="${urls.url_fulltbet}">FulltBet</a>`);
  if (urls.url_oddjusta)      links.push(`<a href="${urls.url_oddjusta}">OddJusta</a>`);
  return links.length ? '\n🔗 ' + links.join(' · ') : '';
}

// ── TELEGRAM ─────────────────────────────────────────────────
async function sendTelegram(msg, extra = {}) {
  const ids = [];
  for (const chatId of TG_CHAT_IDS) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML', disable_web_page_preview: true, ...extra })
      });
      const d = await r.json();
      if (d.ok) ids.push({ chatId, messageId: d.result.message_id });
    } catch(e) { console.error('TG send error:', e.message); }
  }
  return ids;
}

async function editTelegram(msgIds, novoTexto) {
  for (const { chatId, messageId } of (msgIds || [])) {
    try {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: novoTexto, parse_mode: 'HTML', disable_web_page_preview: true })
      });
    } catch(e) {}
  }
}

async function futatsGet(endpoint) {
  const r = await fetch(`${FUTATS_BASE}/${endpoint}`, {
    headers: { 'x-token': FUTATS_TOKEN }
  });
  return r.json();
}

function getFavorito(jogo) {
  const oc  = parseFloat(jogo.odd_inicial_casa || jogo.odd_casa || 99);
  const of_ = parseFloat(jogo.odd_inicial_fora || jogo.odd_fora || 99);
  return oc <= of_ ? 'casa' : 'fora';
}

// ── REGISTRAR PENDENTE ────────────────────────────────────────
function registrarPendente(jogo, strat, tipo = 'pre') {
  const id    = Date.now() + Math.random();
  const hoje  = dataHoje();
  const entrada = {
    id, tipo,
    fixture_id: jogo.fixture_id || null,
    data: jogo.data?.slice(0,10) || hoje,
    hora: jogo.hora?.slice(0,5) || '00:00',
    jogo: `${jogo.mandante} x ${jogo.visitante}`,
    home: jogo.mandante,
    away: jogo.visitante,
    strat,
    odd_casa:  parseFloat(jogo.odd_atual_casa || jogo.odd_casa || 0) || null,
    odd_visit: parseFloat(jogo.odd_atual_fora || jogo.odd_fora || 0) || null,
    result: 'pendente',
    selecao_ia:          jogo.selecao_ia          || null,
    filtro:              jogo.filtros_partida      || null,
    estrategia_futats:   jogo.estrategias_partida  || null,
    cor_futats:          jogo.cores_estrategias_partida || null,
    urls:                jogo.urls_exchanges       || null,
  };
  const jaExiste = pendentes.some(p =>
    p.jogo === entrada.jogo && p.strat === strat &&
    p.data === entrada.data && p.tipo  === tipo
  );
  if (!jaExiste) {
    pendentes.push(entrada);
    salvarArquivo(PEND_FILE, pendentes);
  }
  return entrada;
}

// ── RESULTADO GREEN/RED ───────────────────────────────────────
function calcularResultado(strat, ftH, ftA, htH = 0, htA = 0) {
  const s   = strat.replace(/_live$|_pre$/, '');
  const tot = ftH + ftA;
  switch(s) {
    case 'lay_0x1':              return (ftH === 0 && ftA === 1) ? 'red' : 'green';
    case 'lay_1x0':              return (ftH === 1 && ftA === 0) ? 'red' : 'green';
    case 'lay_0x2':              return (ftH === 0 && ftA === 2) ? 'red' : 'green';
    case 'lay_0x3':              return (ftH === 0 && ftA === 3) ? 'red' : 'green';
    case 'lay_goleada_visit':    return (ftA - ftH >= 4 && ftA > ftH) ? 'red' : 'green';
    case 'lay_goleada_mand':     return (ftH - ftA >= 4 && ftH > ftA) ? 'red' : 'green';
    case 'favorito_ht_gonza':
    case 'lay_away_manu':
    case 'lay_manu4':            return ftA > ftH ? 'red' : 'green';
    case 'lay_xg':               return null;
    case 'back_favorito':
    case 'back_fav_ht':
    case 'back_gonza_xg':        return ftH > ftA ? 'green' : 'red';
    case 'recuperacao_favorito': return null;
    case 'over05':               return (htH === 0 && htA === 0) ? (tot > 0 ? 'green' : 'red') : 'nao_entra';
    case 'over15':
    case 'felipe_over15':        return tot > 1 ? 'green' : 'red';
    case 'over25':               return tot > 2 ? 'green' : 'red';
    case 'over05_ht':            return tot > 0 ? 'green' : 'red';
    case 'over15_ht':            return tot > 1 ? 'green' : 'red';
    case 'ambas_marcam':
    case 'am':
    case 'am_xg':                return (ftH > 0 && ftA > 0) ? 'green' : 'red';
    case 'gol_no_final':         return (ftH + ftA) > (htH + htA) ? 'green' : 'red';
    case 'correcao_lay_fav':
    case 'correcao_lay_zebra':   return null;
    default:                     return tot > 0 ? 'green' : 'red';
  }
}

// ── DISPLAY NAMES ─────────────────────────────────────────────
const STRAT_DISPLAY = {
  back_favorito:        '🤖 Back Favorito',
  recuperacao_favorito: '🤖 Recuperação Favorito',
  gol_no_final:         '🤖 Gol no Final',
  over05_ht:            '🤖 Over 0.5 HT',
  over15_ht:            '🤖 Over 1.5 HT',
  over15:               '🤖 Over 1.5',
  over25:               '🤖 Over 2.5',
  ambas_marcam:         '🤖 Ambas Marcam',
  lay_0x1:              '🤖 Lay Resultado 0x1',
  lay_1x0:              '🤖 Lay Resultado 1x0',
  lay_goleada_visit:    '🤖 Lay Goleada Visitante',
  lay_goleada_mand:     '🤖 Lay Goleada Mandante',
  correcao_lay_fav:     '🤖 Correção Lay Favorito',
  correcao_lay_zebra:   '🤖 Correção Lay Zebra',
  favorito_ht_gonza:    '🔵 Favorito ht Gonza',
  felipe_over15:        '🟠 Felipe Over 1.5',
  lay_away_manu:        '⚪ Lay Away Manu',
  lay_manu4:            '⚪ Lay Manu 4',
  back_gonza_xg:        '🔵 Back Gonza com xG',
  lay_0x2:              '⚪ Lay 0x2 Manu',
  lay_0x3:              '⚪ Lay 0x3',
  lay_xg:               '🟣 Lay xG',
  am_xg:                '🟤 AM xG',
  over05:               '🟢 Over 0,5 Gonza',
  am:                   '🔴 AM',
  atolada_master:       '⚡ Atolada Master',
};

const IA_PARA_STRAT = {
  'Back Favorito':          'back_favorito',
  'Recuperação Favorito':   'recuperacao_favorito',
  'Gol no Final':           'gol_no_final',
  'Over 0.5 HT':            'over05_ht',
  'Over 1.5':               'over15',
  'Over 2.5':               'over25',
  'Ambas Marcam':           'ambas_marcam',
  'Lay Resultado 0x1':      'lay_0x1',
  'Lay Resultado 1x0':      'lay_1x0',
  'Lay Goleada Visitante':  'lay_goleada_visit',
  'Lay Goleada Mandante':   'lay_goleada_mand',
  'Correção Lay Favorito':  'correcao_lay_fav',
  'Correção Lay Zebra':     'correcao_lay_zebra',
};

const FILTRO_PARA_STRAT = {
  'Favorito ht Gonza':  'favorito_ht_gonza',
  'Felipe over 1.5':    'felipe_over15',
  'lay away Manu':      'lay_away_manu',
  'Lay Manu 4':         'lay_manu4',
  'back gonza com xg':  'back_gonza_xg',
  'lay 0x2 Manu':       'lay_0x2',
  'lay 0x3':            'lay_0x3',
};

const ESTRAT_PARA_STRAT = {
  'Over 0,5 Gonza':   'over05',
  'Felipe over 1.5':  'felipe_over15',
  'Back Favorito HT': 'back_fav_ht',
  'Lay xG':           'lay_xg',
  'AM xG':            'am_xg',
  'AM':               'am',
};

// ── CARD MATINAL ──────────────────────────────────────────────
async function enviarCardMatinal() {
  const hoje = dataHoje();
  const [dd, mm, yyyy] = hoje.split('-').reverse();
  const pendHoje = pendentes.filter(p => p.data === hoje && p.tipo === 'pre');

  if (!pendHoje.length) {
    await sendTelegram(`📋 <b>FUTATS — ${dd}/${mm}/${yyyy}</b>\n\nNenhum jogo registrado hoje ainda.`);
    return;
  }

  // Agrupar por jogo (hora|jogo)
  const byJogo = {};
  for (const p of pendHoje) {
    const k = p.hora + '|' + p.jogo;
    if (!byJogo[k]) byJogo[k] = { hora: p.hora, jogo: p.jogo, strats: [] };
    byJogo[k].strats.push(p.strat);
  }

  // Ordenar por hora
  const jogosOrdenados = Object.values(byJogo).sort((a, b) => a.hora.localeCompare(b.hora));

  // Agrupar por bloco de hora
  const byHora = {};
  for (const j of jogosOrdenados) {
    if (!byHora[j.hora]) byHora[j.hora] = [];
    byHora[j.hora].push(j);
  }

  let msg = `📋 <b>FUTATS — Jogos do dia ${dd}/${mm}/${yyyy}</b>\n`;

  for (const [hora, jogos] of Object.entries(byHora)) {
    msg += `\n🕐 <b>${hora}</b>\n`;
    for (const j of jogos) {
      const stratsDisplay = j.strats.map(s => STRAT_DISPLAY[s] || s).join(' · ');
      msg += `⚽ ${j.jogo}\n${stratsDisplay}\n`;
    }
  }

  msg += `\n📊 ${jogosOrdenados.length} jogo(s) · ${pendHoje.length} estratégia(s)`;
  await sendTelegram(msg);
  console.log('[CARD] Card matinal enviado.');
}

// ── RESUMO DO DIA ─────────────────────────────────────────────
async function enviarResumoDia() {
  const hoje = dataHoje();
  const [dd, mm, yyyy] = hoje.split('-').reverse();
  const pendHoje = pendentes.filter(p => p.data === hoje);

  if (!pendHoje.length) {
    await sendTelegram(`📊 <b>FUTATS — Resumo ${dd}/${mm}/${yyyy}</b>\n\nNenhum registro hoje.`);
    return;
  }

  // Agrupar por jogo
  const byJogo = {};
  for (const p of pendHoje) {
    const k = p.hora + '|' + p.jogo;
    if (!byJogo[k]) byJogo[k] = { hora: p.hora, jogo: p.jogo, strats: [] };
    byJogo[k].strats.push(p);
  }

  const jogosOrdenados = Object.values(byJogo).sort((a, b) => a.hora.localeCompare(b.hora));

  let greens = 0, reds = 0, pendCount = 0;
  let linhas = '';

  for (const j of jogosOrdenados) {
    const stratsStr = j.strats.map(p => {
      const nome = STRAT_DISPLAY[p.strat.replace(/_live$/, '')] || p.strat;
      const tipo = p.tipo === 'live' ? ' 🔴live' : '';
      if (p.result === 'green') { greens++; return `${nome}${tipo} ✅`; }
      if (p.result === 'red')   { reds++;   return `${nome}${tipo} ❌`; }
      pendCount++;
      return `${nome}${tipo} ⏳`;
    }).join('\n  ');

    linhas += `\n⚽ <b>${j.jogo}</b> · ${j.hora}\n  ${stratsStr}\n`;
  }

  const saldo = greens + reds > 0
    ? `\n✅ ${greens} GREEN · ❌ ${reds} RED · ⏳ ${pendCount} pendente(s)`
    : `\n⏳ ${pendCount} pendente(s)`;

  await sendTelegram(`📊 <b>FUTATS — Resumo ${dd}/${mm}/${yyyy}</b>${linhas}${saldo}`);
  console.log('[RESUMO] Resumo do dia enviado.');
}

// ── PRÉ-JOGO ─────────────────────────────────────────────────
async function buscarPreJogo() {
  console.log('[PRÉ] Buscando jogos das APIs do futats...');
  try {
    const [rIA, rFiltros, rEst] = await Promise.all([
      futatsGet('api-games-ia'),
      futatsGet('api-games-filtros'),
      futatsGet('api-games-estrategias'),
    ]);
    const jogosIA      = rIA[0]?.eventos      || [];
    const jogosFiltros = rFiltros[0]?.eventos || [];
    const jogosEst     = rEst[0]?.eventos     || [];
    let registrados = 0;

    for (const jogo of jogosIA) {
      const selecoes = (jogo.selecao_ia || '').split(',').map(s => s.trim()).filter(Boolean);
      for (const sel of selecoes) {
        const strat = IA_PARA_STRAT[sel];
        if (!strat) continue;
        registrarPendente({ ...jogo, selecao_ia: sel }, strat, 'pre');
        registrados++;
      }
    }
    for (const jogo of jogosFiltros) {
      const filtros = (jogo.filtros_partida || '').split(',').map(s => s.trim()).filter(Boolean);
      for (const filtro of filtros) {
        const strat = FILTRO_PARA_STRAT[filtro];
        if (!strat) continue;
        registrarPendente({ ...jogo, filtros_partida: filtro }, strat, 'pre');
        registrados++;
      }
    }
    for (const jogo of jogosEst) {
      // CRÍTICO: split por ", " para não partir "Over 0,5 Gonza"
      const ests = (jogo.estrategias_partida || '').split(', ').map(s => s.trim()).filter(Boolean);
      for (const est of ests) {
        const strat = ESTRAT_PARA_STRAT[est];
        if (!strat) continue;
        registrarPendente({ ...jogo, estrategias_partida: est }, strat, 'pre');
        registrados++;
      }
    }
    console.log(`[PRÉ] ${registrados} estratégias registradas.`);
  } catch(e) {
    console.error('[PRÉ] Erro:', e.message);
  }
}

// ── LIVE ──────────────────────────────────────────────────────
async function monitorarLive() {
  try {
    const rLive   = await futatsGet('api-games-live');
    const jogosLive = rLive[0]?.eventos || [];
    const agora   = Date.now();
    const hoje    = dataHoje();
    const idsLive = new Set(jogosLive.map(j => j.mandante + '_' + j.visitante));

    // Detectar jogos encerrados (saíram do live)
    for (const [jogoId, estado] of Object.entries(estadoLive)) {
      if (!idsLive.has(jogoId) && !estado.encerrado) {
        const minSemDados = (agora - estado.ultimaVez) / 60000;
        if (minSemDados >= 2 && (estado.ultimoMinuto || 0) >= 88) {
          estado.encerrado = true;
          await processarFimDeJogo(jogoId, estado, hoje);
        }
      }
    }

    for (const jogo of jogosLive) {
      const jogoId = jogo.mandante + '_' + jogo.visitante;
      if (!estadoLive[jogoId]) {
        estadoLive[jogoId] = {
          jogo, momentum: [], eventos: [], ultimoMinuto: 0,
          ultimaVez: agora, encerrado: false,
          // msgIds: { stratKey: { ids: [...], placarAlerta, tempoAlerta } }
          msgIds: {},
          ultimoPlacar: null,
        };
      }
      const estado = estadoLive[jogoId];
      estado.ultimaVez = agora;
      estado.jogo = jogo;

      for (const m of (jogo.momentum || [])) {
        if (!estado.momentum.find(x => x.minuto === m.minuto)) estado.momentum.push(m);
      }
      for (const ev of (jogo.eventos || [])) {
        const jaExiste = estado.eventos.find(x =>
          x.minuto === ev.minuto && x.tipo_evento === ev.tipo_evento && x.lado === ev.lado
        );
        if (!jaExiste) estado.eventos.push(ev);
      }
      if (estado.momentum.length > 0) {
        estado.ultimoMinuto = Math.max(...estado.momentum.map(m => m.minuto));
      }

      if (jogo.tempo === 'Encerrado' && !estado.encerrado) {
        estado.encerrado = true;
        await processarFimDeJogo(jogoId, estado, hoje);
        continue;
      }

      // Detectar mudança de placar e editar mensagens ativas
      const placarAtual = `${parseInt(jogo.gols_casa)||0}x${parseInt(jogo.gols_fora)||0}`;
      if (estado.ultimoPlacar && estado.ultimoPlacar !== placarAtual) {
        await atualizarPlacarNasMensagens(jogo, estado, placarAtual, hoje);
      }
      estado.ultimoPlacar = placarAtual;

      await processarAlertasLive(jogo, estado, jogoId, hoje);
    }
  } catch(e) {
    console.error('[LIVE] Erro:', e.message);
  }
}

// ── Montar mensagem de alerta ─────────────────────────────────
// Linha fixa = disparo. Linha editável = placar atual / resultado.
function montarMsgAlerta(display, jogo, tempo, placarAlerta, placarAtual, links, statusLinha = null) {
  const fixo    = `${display}\n⚽ <b>${jogo.mandante} x ${jogo.visitante}</b>\n⏱ ${tempo}' · 📊 ${placarAlerta}`;
  const sep     = '\n─────────────────';
  const editavel = statusLinha
    ? `\n${statusLinha}`
    : `\n📊 Placar atual: ${placarAtual}`;
  return fixo + sep + editavel + links;
}

// ── Atualizar placar nas mensagens ativas ─────────────────────
async function atualizarPlacarNasMensagens(jogo, estado, placarAtual, hoje) {
  const tempo = parseInt(jogo.tempo) || 0;
  const links = linksExchanges(estado.jogo?.urls_exchanges || {});

  for (const [stratKey, info] of Object.entries(estado.msgIds || {})) {
    if (!info?.ids?.length) continue;
    const display = STRAT_DISPLAY[stratKey] || stratKey;
    const novoTexto = montarMsgAlerta(
      display, jogo, info.tempoAlerta, info.placarAlerta,
      `${placarAtual} · ${tempo}'`, links
    );
    await editTelegram(info.ids, novoTexto);
  }
}

// ── Alertas live ──────────────────────────────────────────────
async function processarAlertasLive(jogo, estado, jogoId, hoje) {
  const tempo    = parseInt(jogo.tempo) || 0;
  const periodo  = jogo.periodo || '';
  const golsCasa = parseInt(jogo.gols_casa) || 0;
  const golsFora = parseInt(jogo.gols_fora) || 0;
  const total    = golsCasa + golsFora;
  const placar   = `${golsCasa}x${golsFora}`;
  const urls     = jogo.urls_exchanges || {};
  const links    = linksExchanges(urls);
  const favorito = getFavorito(jogo);
  const oddCasa  = parseFloat(jogo.odd_atual_casa || 0);
  const oddFora  = parseFloat(jogo.odd_atual_fora || 0);

  const isHT  = jogo.tempo === 'Intervalo';
  const is1T  = (periodo === '1_tempo' || tempo <= 45) && !isHT;
  const is2T  = (periodo === '2_tempo' || tempo > 45) && !isHT;

  const evNovos   = jogo.eventos || [];
  const raiosCasa = evNovos.filter(e => e.tipo_evento === 'raio' && e.lado === 'casa');
  const raiosFora = evNovos.filter(e => e.tipo_evento === 'raio' && e.lado === 'fora');
  const raioFav   = favorito === 'casa' ? raiosCasa.length > 0 : raiosFora.length > 0;
  const raioZebra = favorito === 'casa' ? raiosFora.length > 0 : raiosCasa.length > 0;
  const raioMand  = raiosCasa.length > 0;
  const raioVisit = raiosFora.length > 0;
  const temRaio   = raioMand || raioVisit;

  const chutesGolCasa = evNovos.filter(e => e.tipo_evento === 'chute_no_gol' && e.lado === 'casa').length;
  const chutesGolFora = evNovos.filter(e => e.tipo_evento === 'chute_no_gol' && e.lado === 'fora').length;

  const todosRaiosCasa = estado.eventos.filter(e => e.tipo_evento === 'raio' && e.lado === 'casa');
  const todosRaiosFora = estado.eventos.filter(e => e.tipo_evento === 'raio' && e.lado === 'fora');
  const tevRaioFav     = favorito === 'casa' ? todosRaiosCasa.length > 0 : todosRaiosFora.length > 0;
  const tevRaioMand    = todosRaiosCasa.length > 0;

  const pendJogo = pendentes.filter(p =>
    p.data === hoje && p.result === 'pendente' &&
    (p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`)
  );

  // ── alertar: 1x por stratKey (lay ao placar: só 1 por jogo) ──
  // Para lay ao placar, stratKey = stratBase (sem sufixo de condição)
  async function alertar(stratKey, dica, stratRegistrar = null) {
    // Já alertou para essa strat nesse jogo? Não dispara de novo.
    if (estado.msgIds[stratKey]) return;

    const display = STRAT_DISPLAY[stratKey] || stratKey;
    const linhaInfo = dica ? `\n💡 ${dica}` : '';
    const textoCompleto = montarMsgAlerta(
      display + linhaInfo, jogo, tempo, placar, placar, links
    );

    const ids = await sendTelegram(textoCompleto);

    estado.msgIds[stratKey] = {
      ids,
      placarAlerta: placar,
      tempoAlerta:  tempo,
      stratKey,
    };

    if (stratRegistrar) {
      const pendLive = registrarPendente({
        ...jogo, fixture_id: pendJogo[0]?.fixture_id || null
      }, stratRegistrar, 'live');
      pendLive.condicao = stratKey;
      pendLive.msgIds   = ids;
      salvarArquivo(PEND_FILE, pendentes);
    }
  }

  // ── SELEÇÕES IA ───────────────────────────────────────────

  // 1. BACK FAVORITO
  if (pendJogo.some(p => p.strat === 'back_favorito')) {
    if (total === 0 && tempo <= 70 && raioFav)
      await alertar('back_favorito', '0x0 + Raio do Favorito!', 'back_favorito_live');
    const favPerdendo = (favorito==='casa' && golsFora-golsCasa===1) || (favorito==='fora' && golsCasa-golsFora===1);
    if (favPerdendo && tempo <= 70 && raioFav)
      await alertar('back_favorito', 'Favorito perdendo + Raio!', 'back_favorito_live');
  }

  // 2. RECUPERAÇÃO FAVORITO
  if (pendJogo.some(p => p.strat === 'recuperacao_favorito')) {
    const favPerdendo1 = (favorito==='casa' && golsFora-golsCasa===1) || (favorito==='fora' && golsCasa-golsFora===1);
    if (favPerdendo1 && tevRaioFav)
      await alertar('recuperacao_favorito', 'Favorito perdendo por 1 + Raio!', 'recuperacao_favorito_live');
  }

  // 3. GOL NO FINAL
  if (pendJogo.some(p => p.strat === 'gol_no_final')) {
    if (is2T && !isHT && temRaio)
      await alertar('gol_no_final', 'Raio no 2T!', 'gol_no_final_live');
  }

  // 4. OVER 0.5 HT
  if (pendJogo.some(p => p.strat === 'over05_ht')) {
    if (is1T && total === 0 && temRaio)
      await alertar('over05_ht', '0x0 + Raio no 1T!', 'over05_ht_live');
    if (is1T && total === 0 && tempo <= 20 && chutesGolCasa >= 1 && chutesGolFora >= 1)
      await alertar('over05_ht', '0x0 + Chute no gol dos dois!', 'over05_ht_live');
    if (is1T && total === 1 && tempo < 20 && temRaio)
      await alertar('over15_ht', '1 gol + Raio antes min 20!', 'over15_ht_live');
  }

  // 5. OVER 1.5
  if (pendJogo.some(p => p.strat === 'over15')) {
    if (total === 0 && temRaio)
      await alertar('over15', '0x0 + Raio!', 'over15_live');
    if (is1T && total === 1 && temRaio) {
      const raioPerdendo = (golsCasa < golsFora && raioMand) || (golsFora < golsCasa && raioVisit);
      if (raioPerdendo)
        await alertar('over15', `${placar} + Raio do time perdendo!`, 'over15_live');
    }
  }

  // 6. OVER 2.5
  if (pendJogo.some(p => p.strat === 'over25')) {
    if (total === 0 && temRaio)
      await alertar('over25', '0x0 + Raio! (entrar Over 1.5)', 'over25_live');
    if (is1T && total === 1 && temRaio) {
      const raioPerdendo = (golsCasa < golsFora && raioMand) || (golsFora < golsCasa && raioVisit);
      if (raioPerdendo)
        await alertar('over25', `${placar} + Raio do time perdendo! (entrar Over 1.5)`, 'over25_live');
    }
  }

  // 7. AMBAS MARCAM
  if (pendJogo.some(p => p.strat === 'ambas_marcam')) {
    if (total === 0 && todosRaiosCasa.length > 0 && todosRaiosFora.length > 0)
      await alertar('ambas_marcam', '0x0 + Raio dos dois times!', 'ambas_marcam_live');
    if (total === 1 && temRaio) {
      const raioPerdendo = (golsCasa > golsFora && raioVisit) || (golsFora > golsCasa && raioMand);
      if (raioPerdendo)
        await alertar('ambas_marcam', `${placar} + Raio do time perdendo!`, 'ambas_marcam_live');
    }
  }

  // 8. LAY 0x1 — 1 alerta por jogo, edita placar
  if (pendJogo.some(p => p.strat === 'lay_0x1')) {
    if (raioMand && total === 0)
      await alertar('lay_0x1', '0x0 + Raio do Mandante!', 'lay_0x1_live');
    else if (raioMand && golsCasa === 0 && golsFora === 1)
      await alertar('lay_0x1', '⚠️ Placar 0x1! Raio Mandante — feche e aguarde!', 'lay_0x1_live');
    else if (raioMand && is2T && !(golsCasa === 0 && golsFora === 1))
      await alertar('lay_0x1', `Raio Mandante no 2T · ${placar}`, 'lay_0x1_live');
  }

  // 9. LAY 1x0 — 1 alerta por jogo, edita placar
  if (pendJogo.some(p => p.strat === 'lay_1x0')) {
    if (raioVisit && total === 0)
      await alertar('lay_1x0', '0x0 + Raio do Visitante!', 'lay_1x0_live');
    else if (raioVisit && golsCasa === 1 && golsFora === 0)
      await alertar('lay_1x0', '⚠️ Placar 1x0! Raio Visitante — feche e aguarde!', 'lay_1x0_live');
    else if (raioVisit && is2T && !(golsCasa === 1 && golsFora === 0))
      await alertar('lay_1x0', `Raio Visitante no 2T · ${placar}`, 'lay_1x0_live');
  }

  // 10. LAY GOLEADA VISITANTE — 1 alerta por jogo
  if (pendJogo.some(p => p.strat === 'lay_goleada_visit')) {
    if (raioMand)
      await alertar('lay_goleada_visit', 'Raio do Mandante!', 'lay_goleada_visit_live');
  }

  // 11. LAY GOLEADA MANDANTE — 1 alerta por jogo
  if (pendJogo.some(p => p.strat === 'lay_goleada_mand')) {
    if (raioVisit)
      await alertar('lay_goleada_mand', 'Raio do Visitante!', 'lay_goleada_mand_live');
  }

  // 12. CORREÇÃO LAY FAVORITO
  if (pendJogo.some(p => p.strat === 'correcao_lay_fav')) {
    if (tempo <= 5 && !isHT && raioZebra)
      await alertar('correcao_lay_fav', `Raio da Zebra no min ${tempo}!`, 'correcao_lay_fav_live');
  }

  // 13. CORREÇÃO LAY ZEBRA
  if (pendJogo.some(p => p.strat === 'correcao_lay_zebra')) {
    if (tempo <= 5 && !isHT && raioFav)
      await alertar('correcao_lay_zebra', `Raio do Favorito no min ${tempo}!`, 'correcao_lay_zebra_live');
  }

  // ── FILTROS ───────────────────────────────────────────────

  // FAVORITO HT GONZA / LAY AWAY MANU / LAY MANU 4
  for (const sf of ['favorito_ht_gonza','lay_away_manu','lay_manu4']) {
    if (!pendJogo.some(p => p.strat === sf)) continue;
    if (total === 0 && raioMand)
      await alertar(sf, `0x0 + Raio do Mandante! · Lay Visitante · Odd: ${oddFora.toFixed(2)}`, `${sf}_live`);
    else if (golsFora > golsCasa && raioMand && tempo <= 70)
      await alertar(sf, `Mandante perdendo + Raio! · Lay Visitante · Odd: ${oddFora.toFixed(2)}`, `${sf}_live`);
    else if (golsFora > golsCasa && raioMand && tempo > 70)
      await alertar(sf, `Mandante perdendo + Raio (após min 70)! · Mercado de GOLS`, `${sf}_live`);
  }

  // BACK GONZA COM xG
  if (pendJogo.some(p => p.strat === 'back_gonza_xg')) {
    if (is1T && tempo <= 20 && total === 0 && raioMand)
      await alertar('back_gonza_xg', `Raio Mandante até min 20 · 0x0! · Odd: ${oddCasa.toFixed(2)}`, 'back_gonza_xg_live');
    else if (tempo > 35 && total === 0 && raioMand)
      await alertar('back_gonza_xg', `Raio Mandante após min 35 · 0x0! · Odd: ${oddCasa.toFixed(2)}`, 'back_gonza_xg_live');
    else if (is2T && total === 0 && tempo <= 70 && raioMand)
      await alertar('back_gonza_xg', `0x0 + Raio Mandante no 2T! · Odd: ${oddCasa.toFixed(2)}`, 'back_gonza_xg_live');
  }

  // FELIPE OVER 1.5
  if (pendJogo.some(p => p.strat === 'felipe_over15')) {
    if (total === 0 && temRaio)
      await alertar('felipe_over15', '0x0 + Raio!', 'felipe_over15_live');
    else if (is1T && total === 1 && temRaio) {
      const raioPerdendo = (golsCasa < golsFora && raioMand) || (golsFora < golsCasa && raioVisit);
      if (raioPerdendo)
        await alertar('felipe_over15', `${placar} + Raio do time perdendo!`, 'felipe_over15_live');
    }
  }

  // LAY 0x2 MANU — 1 alerta por jogo, edita placar
  if (pendJogo.some(p => p.strat === 'lay_0x2')) {
    if (golsCasa === 0 && golsFora <= 2 && raioMand)
      await alertar('lay_0x2', `Raio Mandante · ${placar}!`, 'lay_0x2_live');
  }

  // LAY 0x3 — 1 alerta por jogo, edita placar
  if (pendJogo.some(p => p.strat === 'lay_0x3')) {
    if (golsCasa === 0 && golsFora <= 3 && raioMand)
      await alertar('lay_0x3', `Raio Mandante · ${placar}!`, 'lay_0x3_live');
  }

  // LAY xG
  if (pendJogo.some(p => p.strat === 'lay_xg')) {
    const p        = pendJogo.find(p => p.strat === 'lay_xg');
    const layHome  = p?.lay_team === 'home';
    const maiorXgRaio    = layHome ? raioVisit : raioMand;
    const empatado       = golsCasa === golsFora;
    const menorXgFrente  = (layHome && golsCasa > golsFora) || (!layHome && golsFora > golsCasa);
    if (maiorXgRaio && (empatado || menorXgFrente))
      await alertar('lay_xg', 'Raio do time de maior xG!', 'lay_xg_live');
  }

  // AM xG
  if (pendJogo.some(p => p.strat === 'am_xg')) {
    if (total === 0 && todosRaiosCasa.length > 0 && todosRaiosFora.length > 0)
      await alertar('am_xg', '0x0 + Raio dos dois times!', 'am_xg_live');
    else if (total === 1 && temRaio) {
      const raioPerdendo = (golsCasa > golsFora && raioVisit) || (golsFora > golsCasa && raioMand);
      if (raioPerdendo)
        await alertar('am_xg', `${placar} + Raio do time perdendo!`, 'am_xg_live');
    }
    if (isHT && total === 0 && tevRaioMand)
      await alertar('atolada_master', 'AM xG + HT 0x0 + Raio no 1T!', 'atolada_master_live');
  }

  // OVER 0,5 GONZA
  if (pendJogo.some(p => p.strat === 'over05')) {
    if (is1T && total === 0 && raioMand && raioVisit)
      await alertar('over05', '0x0 + Raio dos dois times no 1T! (entrar Over HT)', 'over05_live');
    else if (isHT && total === 0 && tevRaioMand)
      await alertar('over05', 'Intervalo 0x0! Entrar agora no Over HT!', 'over05_live');
    else if (is2T && total === 0 && temRaio)
      await alertar('over05', '0x0 + Raio no 2T!', 'over05_live');
  }

  // AM
  if (pendJogo.some(p => p.strat === 'am')) {
    if (total === 0 && todosRaiosCasa.length > 0 && todosRaiosFora.length > 0)
      await alertar('am', '0x0 + Raio dos dois times!', 'am_live');
    else if (total === 1 && temRaio) {
      const raioPerdendo = (golsCasa > golsFora && raioVisit) || (golsFora > golsCasa && raioMand);
      if (raioPerdendo)
        await alertar('am', `${placar} + Raio do time perdendo!`, 'am_live');
    }
  }
}

// ── FIM DE JOGO ───────────────────────────────────────────────
async function processarFimDeJogo(jogoId, estado, hoje) {
  console.log(`[FIM] ${jogoId}`);
  const jogo = estado.jogo;
  if (!jogo) return;

  const golsCasa = parseInt(jogo.gols_casa) || 0;
  const golsFora = parseInt(jogo.gols_fora) || 0;
  const placarFT = `${golsCasa}x${golsFora}`;
  const links    = linksExchanges(jogo.urls_exchanges || {});

  const pendJogo = pendentes.filter(p =>
    p.data === hoje && p.result === 'pendente' &&
    (p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`)
  );

  // Resolver pendentes
  for (const p of pendJogo) {
    p.final  = placarFT;
    const res = calcularResultado(p.strat, golsCasa, golsFora);
    p.result  = res || 'resolvido';
  }
  salvarArquivo(PEND_FILE, pendentes);

  // Editar todas as mensagens ativas com resultado
  for (const [stratKey, info] of Object.entries(estado.msgIds || {})) {
    if (!info?.ids?.length) continue;

    const stratBase = stratKey.replace(/_live$/, '');
    const pLive = pendJogo.find(p => {
      const ps = p.strat.replace(/_live$/, '');
      return ps === stratBase || ps === stratKey;
    });

    const res     = pLive?.result || calcularResultado(stratBase, golsCasa, golsFora);
    const emoji   = res === 'green' ? '✅ GREEN' : '❌ RED';
    const display = STRAT_DISPLAY[stratKey] || stratKey;

    // Linha fixa mantém tempo e placar do alerta
    const textoFinal = `${display}\n⚽ <b>${jogo.mandante} x ${jogo.visitante}</b>\n⏱ ${info.tempoAlerta}' · 📊 ${info.placarAlerta}\n─────────────────\n${emoji} · FT: ${placarFT}${links}`;
    await editTelegram(info.ids, textoFinal);
  }

  await sendTelegram(`🏁 <b>FIM DE JOGO</b>\n⚽ ${jogo.mandante} x ${jogo.visitante}\n📊 FT: ${placarFT}`);
}

// ── AGENDADOR BRT ─────────────────────────────────────────────
function agendarHoraBRT(hora, minuto, callback) {
  function proximaExecucao() {
    const agora  = agoraBRT();
    const alvo   = new Date(agora);
    alvo.setHours(hora, minuto, 0, 0);
    if (alvo <= agora) alvo.setDate(alvo.getDate() + 1);
    const diff = alvo - agora;
    setTimeout(async () => {
      await callback();
      setInterval(callback, 24 * 60 * 60 * 1000);
    }, diff);
    console.log(`[AGENDA] ${hora}:${String(minuto).padStart(2,'0')} BRT agendado em ${Math.round(diff/60000)} min`);
  }
  proximaExecucao();
}

// ── ROUTES ────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'ok', version: 'server_37',
  pendentes: pendentes.filter(p => p.result === 'pendente').length,
  jogos_live: Object.keys(estadoLive).filter(k => !estadoLive[k].encerrado).length,
  uptime: Math.floor(process.uptime()) + 's'
}));

app.get('/pendentes',  (req, res) => res.json(pendentes));
app.post('/pendentes', (req, res) => {
  const novos = req.body;
  if (!Array.isArray(novos)) return res.status(400).json({ error: 'Array esperado' });
  if (novos.length === 0)    return res.json({ ok: true, total: pendentes.length, aviso: 'vazia ignorada' });
  const idsNovos = new Set(novos.map(p => String(p.id)));
  const mantidos = pendentes.filter(p => !idsNovos.has(String(p.id)) && p.result === 'pendente');
  pendentes = [...novos, ...mantidos];
  salvarArquivo(PEND_FILE, pendentes);
  res.json({ ok: true, total: pendentes.length });
});

app.get('/dados',  (req, res) => res.json(dadosHist));
app.post('/dados', (req, res) => {
  const novos = req.body;
  if (!Array.isArray(novos)) return res.status(400).json({ error: 'Array esperado' });
  dadosHist = novos;
  salvarArquivo(DATA_FILE, dadosHist);
  res.json({ ok: true, total: dadosHist.length });
});

app.get('/estado-live', (req, res) => {
  const resumo = {};
  for (const [k, v] of Object.entries(estadoLive)) {
    resumo[k] = {
      minuto: v.ultimoMinuto, encerrado: v.encerrado,
      ultimoPlacar: v.ultimoPlacar,
      alertas: Object.keys(v.msgIds || {})
    };
  }
  res.json(resumo);
});

app.post('/testar-telegram', async (req, res) => {
  await sendTelegram('✅ FUTATS Server v37 funcionando! 🎯');
  res.json({ ok: true });
});

app.post('/resumo-agora', async (req, res) => {
  await enviarResumoDia();
  res.json({ ok: true });
});

app.post('/card-agora', async (req, res) => {
  await enviarCardMatinal();
  res.json({ ok: true });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`FUTATS Server v37 na porta ${PORT}`);

  // Buscar jogos pré-jogo
  await buscarPreJogo();
  setInterval(buscarPreJogo, 6 * 60 * 60 * 1000);

  // Monitoramento live
  setInterval(monitorarLive, 90 * 1000);

  // Agendar card matinal 08:00 BRT e resumo 23:00 BRT
  agendarHoraBRT(8,  0, enviarCardMatinal);
  agendarHoraBRT(23, 0, enviarResumoDia);

  // Avisos de inicio
  await sendTelegram(
    '🚀 <b>FUTATS Server v37 iniciado!</b>\n' +
    '✅ 1 alerta por estratégia por jogo\n' +
    '✅ Edição de placar em tempo real\n' +
    '✅ GREEN/RED editado ao fim do jogo\n' +
    '✅ Card matinal 08h · Resumo 23h\n' +
    '✅ Lay ao placar: 1 alerta + edições'
  );

  // Enviar card e resumo imediatamente ao subir
  await enviarCardMatinal();
  await enviarResumoDia();
});
