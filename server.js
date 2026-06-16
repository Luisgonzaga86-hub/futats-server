const express  = require('express');
const fetch    = require('node-fetch');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── Configurações ──────────────────────────────────────────────
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

// Estado live acumulado por jogo
let estadoLive = {};
// Alertas já disparados { [jogoId_strat]: placarDoAlerta }
// Valor = placar no momento do alerta (para detectar mudança de placar)
let notificados = {};

// ── Utilitários de data/hora BRT ───────────────────────────────
function dataHoje() {
  return new Date(new Date().getTime() - 3*60*60*1000).toISOString().split('T')[0];
}
function agoraBRT() {
  return new Date(new Date().getTime() - 3*60*60*1000);
}
function horaBRT() {
  return agoraBRT().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
}

// ── Telegram ──────────────────────────────────────────────────
async function sendTelegram(msg, extra = {}) {
  const ids = [];
  for (const chatId of TG_CHAT_IDS) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML', ...extra })
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
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: novoTexto, parse_mode: 'HTML' })
      });
    } catch(e) {}
  }
}

// ── Futats API ────────────────────────────────────────────────
async function futatsGet(endpoint) {
  const r = await fetch(`${FUTATS_BASE}/${endpoint}`, {
    headers: { 'x-token': FUTATS_TOKEN }
  });
  return r.json();
}

// ── Determinar favorito/zebra ─────────────────────────────────
function getFavorito(jogo) {
  const oc = parseFloat(jogo.odd_inicial_casa || jogo.odd_casa || 99);
  const of_ = parseFloat(jogo.odd_inicial_fora || jogo.odd_fora || 99);
  return oc <= of_ ? 'casa' : 'fora';
}

// ── Links exchanges ──────────────────────────────────────────
function linksExchanges(urls) {
  if (!urls) return '';
  const links = [];
  if (urls.betfair)       links.push(`<a href="${urls.betfair}">Betfair</a>`);
  if (urls.bolsadeaposta) links.push(`<a href="${urls.bolsadeaposta}">Bolsa de Aposta</a>`);
  if (urls.bet365)        links.push(`<a href="${urls.bet365}">Bet365</a>`);
  return links.length ? '\n🔗 ' + links.join(' · ') : '';
}

// ── Registrar pendente no site ───────────────────────────────
function registrarPendente(jogo, strat, tipo = 'pre') {
  const id = Date.now() + Math.random();
  const hoje = dataHoje();
  const entrada = {
    id, tipo,
    fixture_id: jogo.fixture_id || null,
    data: jogo.data?.slice(0,10) || hoje,
    hora: jogo.hora?.slice(0,5) || '00:00',
    jogo: `${jogo.mandante} x ${jogo.visitante}`,
    home: jogo.mandante,
    away: jogo.visitante,
    strat,
    odd_casa: parseFloat(jogo.odd_atual_casa || jogo.odd_casa || 0) || null,
    odd_visit: parseFloat(jogo.odd_atual_fora || jogo.odd_fora || 0) || null,
    result: 'pendente',
    selecao_ia: jogo.selecao_ia || null,
    filtro: jogo.filtros_partida || null,
    estrategia_futats: jogo.estrategias_partida || null,
    cor_futats: jogo.cores_estrategias_partida || null,
    urls: jogo.urls_exchanges || null
  };
  const jaExiste = pendentes.some(p =>
    p.jogo === entrada.jogo && p.strat === strat &&
    p.data === entrada.data && p.tipo === tipo
  );
  if (!jaExiste) {
    pendentes.push(entrada);
    salvarArquivo(PEND_FILE, pendentes);
  }
  return entrada;
}

// ── Resultado GREEN/RED ──────────────────────────────────────
// REGRA: para estratégias de lay ao placar específico,
// RED = somente se FT for EXATAMENTE o placar apostado.
// Todos os outros placares = GREEN.
function calcularResultado(strat, ftH, ftA, htH = 0, htA = 0) {
  // Normalizar: remover sufixo _live, _pre, etc.
  const s = strat.replace(/_live$|_pre$/, '');
  const tot = ftH + ftA;
  const favorito = ftH <= ftA ? 'casa' : 'fora'; // simplificado

  switch(s) {
    // Lay ao placar: RED apenas se FT = placar exato apostado
    case 'lay_0x1':      return (ftH === 0 && ftA === 1) ? 'red' : 'green';
    case 'lay_1x0':      return (ftH === 1 && ftA === 0) ? 'red' : 'green';
    case 'lay_0x2':      return (ftH === 0 && ftA === 2) ? 'red' : 'green';
    case 'lay_0x3':      return (ftH === 0 && ftA === 3) ? 'red' : 'green';
    // Lay goleada: RED se visitante/mandante fizer goleada (≥4 de diferença)
    case 'lay_goleada_visit': return (ftA - ftH >= 4 && ftA > ftH) ? 'red' : 'green';
    case 'lay_goleada_mand':  return (ftH - ftA >= 4 && ftH > ftA) ? 'red' : 'green';
    // Outros lays
    case 'favorito_ht_gonza':
    case 'lay_away_manu':
    case 'lay_manu4':    return ftA > ftH ? 'red' : 'green';
    case 'lay_xg':       return null; // manual
    // Backs
    case 'back_favorito':
    case 'back_fav_ht':
    case 'back_gonza_xg': return ftH > ftA ? 'green' : 'red'; // simplificado
    case 'recuperacao_favorito': return null; // só live
    // Overs
    case 'over05':       return (htH === 0 && htA === 0) ? (tot > 0 ? 'green' : 'red') : 'nao_entra';
    case 'over15':
    case 'felipe_over15': return tot > 1 ? 'green' : 'red';
    case 'over25':       return tot > 2 ? 'green' : 'red';
    case 'over05_ht':    return tot > 0 ? 'green' : 'red';
    // Ambas
    case 'ambas_marcam':
    case 'am':
    case 'am_xg':        return (ftH > 0 && ftA > 0) ? 'green' : 'red';
    // Gol no final
    case 'gol_no_final': return (ftH + ftA) > (htH + htA) ? 'green' : 'red';
    // Correções (live only)
    case 'correcao_lay_fav':
    case 'correcao_lay_zebra': return null;
    default: return tot > 0 ? 'green' : 'red';
  }
}

// ── Mapa estratégias ──────────────────────────────────────────
const STRAT_DISPLAY = {
  back_favorito:       '🤖 Back Favorito',
  recuperacao_favorito:'🤖 Recuperação Favorito',
  gol_no_final:        '🤖 Gol no Final',
  over05_ht:           '🤖 Over 0.5 HT',
  over15:              '🤖 Over 1.5',
  over25:              '🤖 Over 2.5',
  ambas_marcam:        '🤖 Ambas Marcam',
  lay_0x1:             '🤖 Lay Resultado 0x1',
  lay_1x0:             '🤖 Lay Resultado 1x0',
  lay_goleada_visit:   '🤖 Lay Goleada Visitante',
  lay_goleada_mand:    '🤖 Lay Goleada Mandante',
  correcao_lay_fav:    '🤖 Correção Lay Favorito',
  correcao_lay_zebra:  '🤖 Correção Lay Zebra',
  favorito_ht_gonza:   '🔵 Favorito ht Gonza',
  felipe_over15:       '🟠 Felipe Over 1.5',
  lay_away_manu:       '⚪ Lay Away Manu',
  lay_manu4:           '⚪ Lay Manu 4',
  back_gonza_xg:       '🔵 Back Gonza com xG',
  lay_0x2:             '⚪ Lay 0x2 Manu',
  lay_0x3:             '⚪ Lay 0x3',
  lay_xg:              '🟣 Lay xG',
  am_xg:               '🟤 AM xG',
  over05:              '🟢 Over 0.5',
  am:                  '🔴 AM',
  atolada_master:      '⚡ Atolada Master',
};

// ── Mapa seleção IA → strat ───────────────────────────────────
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
  'Favorito ht Gonza':    'favorito_ht_gonza',
  'Felipe over 1.5':      'felipe_over15',
  'lay away Manu':        'lay_away_manu',
  'Lay Manu 4':           'lay_manu4',
  'back gonza com xg':    'back_gonza_xg',
  'lay 0x2 Manu':         'lay_0x2',
  'lay 0x3':              'lay_0x3',
};

const ESTRAT_PARA_STRAT = {
  'Lay xG':  'lay_xg',
  'AM xG':   'am_xg',
  'Over 0.5':'over05',
  'AM':      'am',
};

// ── PRÉ-JOGO ─────────────────────────────────────────────────
async function buscarPreJogo() {
  console.log('[PRÉ] Buscando jogos das APIs do futats...');
  try {
    const [rIA, rFiltros, rEst] = await Promise.all([
      futatsGet('api-games-ia'),
      futatsGet('api-games-filtros'),
      futatsGet('api-games-estrategias'),
    ]);

    const jogosIA      = rIA[0]?.eventos || [];
    const jogosFiltros = rFiltros[0]?.eventos || [];
    const jogosEst     = rEst[0]?.eventos || [];

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
      // CRÍTICO: split por ", " (vírgula+espaço) para não partir "Over 0,5 Gonza"
      const estrategias = (jogo.estrategias_partida || '').split(', ').map(s => s.trim()).filter(Boolean);
      for (const est of estrategias) {
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
    const rLive = await futatsGet('api-games-live');
    const jogosLive = rLive[0]?.eventos || [];
    const agora = Date.now();
    const hoje = dataHoje();

    const idsLive = new Set(jogosLive.map(j => j.mandante + '_' + j.visitante));

    for (const [jogoId, estado] of Object.entries(estadoLive)) {
      if (!idsLive.has(jogoId) && !estado.encerrado) {
        const minSemDados = (agora - estado.ultimaVez) / 60000;
        const minJogo = estado.ultimoMinuto || 0;
        if (minSemDados >= 2 && minJogo >= 88) {
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
          msgIds: {}
        };
      }

      const estado = estadoLive[jogoId];
      estado.ultimaVez = agora;
      estado.jogo = jogo;

      const momNovos = (jogo.momentum || []);
      for (const m of momNovos) {
        if (!estado.momentum.find(x => x.minuto === m.minuto)) {
          estado.momentum.push(m);
        }
      }

      const evNovos = (jogo.eventos || []);
      for (const ev of evNovos) {
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

      await processarAlertasLive(jogo, estado, jogoId, hoje);
    }

  } catch(e) {
    console.error('[LIVE] Erro:', e.message);
  }
}

// ── Processar alertas live ────────────────────────────────────
async function processarAlertasLive(jogo, estado, jogoId, hoje) {
  const tempo    = parseInt(jogo.tempo) || 0;
  const periodo  = jogo.periodo || '';
  const golsCasa = parseInt(jogo.gols_casa) || 0;
  const golsFora = parseInt(jogo.gols_fora) || 0;
  const total    = golsCasa + golsFora;
  const hora     = horaBRT();
  const placar   = `${golsCasa}x${golsFora}`;
  const urls     = jogo.urls_exchanges || {};
  const links    = linksExchanges(urls);
  const favorito = getFavorito(jogo);
  const oddCasa  = parseFloat(jogo.odd_atual_casa || 0);
  const oddFora  = parseFloat(jogo.odd_atual_fora || 0);
  const is1T     = periodo === '1_tempo' || tempo <= 45;
  const is2T     = periodo === '2_tempo' || tempo > 45;
  const isHT     = jogo.tempo === 'Intervalo';
  const oddFav   = favorito === 'casa' ? oddCasa : oddFora;
  const oddZebra = favorito === 'casa' ? oddFora : oddCasa;

  const evNovos = jogo.eventos || [];
  const raiosCasa  = evNovos.filter(e => e.tipo_evento === 'raio' && e.lado === 'casa');
  const raiosFora  = evNovos.filter(e => e.tipo_evento === 'raio' && e.lado === 'fora');
  const raioFav    = favorito === 'casa' ? raiosCasa.length > 0 : raiosFora.length > 0;
  const raioZebra  = favorito === 'casa' ? raiosFora.length > 0 : raiosCasa.length > 0;
  const raioMand   = raiosCasa.length > 0;
  const raioVisit  = raiosFora.length > 0;
  const temRaio    = raiosCasa.length > 0 || raiosFora.length > 0;

  const chutesGolCasa  = evNovos.filter(e => e.tipo_evento === 'chute_no_gol' && e.lado === 'casa').length;
  const chutesGolFora  = evNovos.filter(e => e.tipo_evento === 'chute_no_gol' && e.lado === 'fora').length;

  const todosRaiosCasa  = estado.eventos.filter(e => e.tipo_evento === 'raio' && e.lado === 'casa');
  const todosRaiosFora  = estado.eventos.filter(e => e.tipo_evento === 'raio' && e.lado === 'fora');
  const tevRaioFav      = favorito === 'casa' ? todosRaiosCasa.length > 0 : todosRaiosFora.length > 0;
  const tevRaioMand     = todosRaiosCasa.length > 0;

  const pendJogo = pendentes.filter(p =>
    p.data === hoje && p.result === 'pendente' &&
    (p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`)
  );

  // ─────────────────────────────────────────────────────────────
  // FUNÇÃO ALERTAR: 1 alerta por estratégia + alerta ao mudar placar
  // nKey base (sem variáveis) = bloqueia segundo alerta da mesma condição
  // nKey com placar = permite novo alerta quando placar muda
  // ─────────────────────────────────────────────────────────────
  async function alertar(stratKey, texto, stratRegistrar = null) {
    // Chave BASE: só jogoId + stratKey (sem tempo/placar)
    const nKeyBase  = `${jogoId}_${stratKey}`;
    // Chave c/ placar: permite redispachar quando placar muda
    const nKeyPlacar = `${jogoId}_${stratKey}_${placar}`;

    // Se já foi alertado para ESTE placar, ignorar
    if (notificados[nKeyPlacar]) return;

    // Marcar como notificado para este placar
    notificados[nKeyBase]   = placar; // guarda placar do último alerta
    notificados[nKeyPlacar] = true;

    const msg = `${texto}\n⚽ <b>${jogo.mandante} x ${jogo.visitante}</b>\n📊 ${placar} · ${tempo}'\n⏰ ${hora}${links}`;
    const ids = await sendTelegram(msg);

    // Guardar msgIds por stratKey+placar para edição posterior
    if (!estado.msgIds[stratKey]) estado.msgIds[stratKey] = [];
    estado.msgIds[stratKey].push({ placar, ids });

    if (stratRegistrar) {
      const pendLive = registrarPendente({
        ...jogo, fixture_id: pendJogo[0]?.fixture_id || null
      }, stratRegistrar, 'live');
      pendLive.condicao = stratKey;
      pendLive.msgIds   = ids;
      salvarArquivo(PEND_FILE, pendentes);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // SELEÇÕES IA
  // ─────────────────────────────────────────────────────────────

  // 1. BACK FAVORITO
  if (pendJogo.some(p => p.strat === 'back_favorito')) {
    if (total === 0 && tempo <= 70 && raioFav) {
      await alertar('back_fav_0x0', `🤖 <b>BACK FAVORITO</b>\n💡 0x0 + Raio do Favorito!`, 'back_favorito_live');
    }
    const favPerdendo = (favorito === 'casa' && golsFora - golsCasa === 1) ||
                        (favorito === 'fora' && golsCasa - golsFora === 1);
    if (favPerdendo && tempo <= 70 && raioFav) {
      await alertar(`back_fav_perd_${placar}`, `🤖 <b>BACK FAVORITO — Recuperação!</b>\n💡 Favorito perdendo + Raio!`, 'back_favorito_live');
    }
  }

  // 2. RECUPERAÇÃO FAVORITO
  {
    const favPerdendo1 = (favorito === 'casa' && golsFora - golsCasa === 1) ||
                         (favorito === 'fora' && golsCasa - golsFora === 1);
    if (pendJogo.some(p => p.strat === 'recuperacao_favorito') && favPerdendo1 && tevRaioFav) {
      await alertar(`recup_fav_${placar}`, `🤖 <b>RECUPERAÇÃO FAVORITO</b>\n💡 Favorito perdendo por 1 + Raio!`, 'recuperacao_favorito_live');
    }
  }

  // 3. GOL NO FINAL
  if (pendJogo.some(p => p.strat === 'gol_no_final')) {
    if (is2T && temRaio) {
      await alertar('gol_final_2t', `🤖 <b>GOL NO FINAL</b>\n💡 Raio no 2T!`, 'gol_no_final_live');
    }
  }

  // 4. OVER 0.5 HT
  if (pendJogo.some(p => p.strat === 'over05_ht')) {
    if (is1T && total === 0 && temRaio) {
      await alertar('over05ht_raio', `🤖 <b>OVER 0.5 HT</b>\n💡 0x0 + Raio no 1T!`, 'over05_ht_live');
    }
    if (is1T && total === 0 && tempo <= 20 && chutesGolCasa >= 1 && chutesGolFora >= 1) {
      await alertar('over05ht_chutes', `🤖 <b>OVER 0.5 HT — Chutes!</b>\n💡 0x0 + Chute no gol dos dois times!`, 'over05_ht_live');
    }
    if (is1T && total === 1 && tempo < 20 && temRaio) {
      await alertar(`over15ht_${placar}`, `🤖 <b>OVER 1.5 HT</b>\n💡 1 gol + Raio antes do min 20!`, 'over15_ht_live');
    }
  }

  // 5. OVER 1.5
  if (pendJogo.some(p => p.strat === 'over15')) {
    if (total === 0 && temRaio) {
      await alertar('over15_0x0', `🤖 <b>OVER 1.5</b>\n💡 0x0 + Raio!`, 'over15_live');
    }
    if (is1T && total === 1 && temRaio) {
      const perdendoCasa = golsCasa < golsFora;
      const raioPerdendo = (perdendoCasa && raioMand) || (!perdendoCasa && raioVisit);
      if (raioPerdendo) {
        await alertar(`over15_perd_${placar}`, `🤖 <b>OVER 1.5</b>\n💡 ${placar} + Raio do time perdendo!`, 'over15_live');
      }
    }
  }

  // 6. OVER 2.5
  if (pendJogo.some(p => p.strat === 'over25')) {
    if (total === 0 && temRaio) {
      await alertar('over25_0x0', `🤖 <b>OVER 2.5</b> (entrar Over 1.5)\n💡 0x0 + Raio!`, 'over25_live');
    }
    if (is1T && total === 1 && temRaio) {
      const perdendoCasa = golsCasa < golsFora;
      const raioPerdendo = (perdendoCasa && raioMand) || (!perdendoCasa && raioVisit);
      if (raioPerdendo) {
        await alertar(`over25_perd_${placar}`, `🤖 <b>OVER 2.5</b> (entrar Over 1.5)\n💡 ${placar} + Raio do time perdendo!`, 'over25_live');
      }
    }
  }

  // 7. AMBAS MARCAM
  if (pendJogo.some(p => p.strat === 'ambas_marcam')) {
    if (total === 0 && todosRaiosCasa.length > 0 && todosRaiosFora.length > 0) {
      await alertar('ambas_0x0', `🤖 <b>AMBAS MARCAM</b>\n💡 0x0 + Raio dos dois times!`, 'ambas_marcam_live');
    }
    if (total === 1 && temRaio) {
      const raioPerdendo = (golsCasa > golsFora && raioVisit) || (golsFora > golsCasa && raioMand);
      if (raioPerdendo) {
        await alertar(`ambas_perd_${placar}`, `🤖 <b>AMBAS MARCAM</b>\n💡 ${placar} + Raio do time perdendo!`, 'ambas_marcam_live');
      }
    }
  }

  // 8. LAY RESULTADO 0x1
  // Alerta 1x (quando 0x0 com raio mandante) + atualiza quando placar muda
  if (pendJogo.some(p => p.strat === 'lay_0x1')) {
    if (raioMand) {
      // Só alerta se ainda não é 0x1 (placar contra) e se total <=1
      if (total === 0) {
        await alertar('lay_0x1_entrada', `🤖 <b>LAY RESULTADO 0x1</b>\n💡 0x0 + Raio do Mandante!`, 'lay_0x1_live');
      } else if (golsCasa === 0 && golsFora === 1) {
        // Placar 0x1: lembrar mas NÃO redisparar (já está no placar ruim)
        await alertar(`lay_0x1_atencao_${placar}`, `🤖 <b>LAY 0x1 — ⚠️ Placar 0x1!</b>\n💡 Raio Mandante — placar de risco!`, 'lay_0x1_live');
      }
    }
  }

  // 9. LAY RESULTADO 1x0
  if (pendJogo.some(p => p.strat === 'lay_1x0')) {
    if (raioVisit) {
      if (total === 0) {
        await alertar('lay_1x0_entrada', `🤖 <b>LAY RESULTADO 1x0</b>\n💡 0x0 + Raio do Visitante!`, 'lay_1x0_live');
      } else if (golsCasa === 1 && golsFora === 0) {
        await alertar(`lay_1x0_atencao_${placar}`, `🤖 <b>LAY 1x0 — ⚠️ Placar 1x0!</b>\n💡 Raio Visitante — placar de risco!`, 'lay_1x0_live');
      }
    }
  }

  // 10. LAY GOLEADA VISITANTE — 1 alerta por partida
  if (pendJogo.some(p => p.strat === 'lay_goleada_visit')) {
    if (raioMand) {
      await alertar('lay_gol_visit_entrada', `🤖 <b>LAY GOLEADA VISITANTE</b>\n💡 Raio do Mandante!`, 'lay_goleada_visit_live');
    }
  }

  // 11. LAY GOLEADA MANDANTE — 1 alerta por partida
  if (pendJogo.some(p => p.strat === 'lay_goleada_mand')) {
    if (raioVisit) {
      await alertar('lay_gol_mand_entrada', `🤖 <b>LAY GOLEADA MANDANTE</b>\n💡 Raio do Visitante!`, 'lay_goleada_mand_live');
    }
  }

  // 12. CORREÇÃO LAY FAVORITO
  if (tempo <= 5 && raioZebra) {
    if (pendJogo.some(p => p.strat === 'correcao_lay_fav')) {
      await alertar(`corr_fav_min${tempo}`, `🤖 <b>CORREÇÃO LAY FAVORITO</b>\n💡 Raio da Zebra no min ${tempo}!`, 'correcao_lay_fav_live');
    }
  }

  // 13. CORREÇÃO LAY ZEBRA
  if (tempo <= 5 && raioFav) {
    if (pendJogo.some(p => p.strat === 'correcao_lay_zebra')) {
      await alertar(`corr_zebra_min${tempo}`, `🤖 <b>CORREÇÃO LAY ZEBRA</b>\n💡 Raio do Favorito no min ${tempo}!`, 'correcao_lay_zebra_live');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // FILTROS PERSONALIZADOS
  // ─────────────────────────────────────────────────────────────

  // FAVORITO HT GONZA / LAY AWAY MANU / LAY MANU 4
  const stratsFavGonza = ['favorito_ht_gonza','lay_away_manu','lay_manu4'];
  for (const sf of stratsFavGonza) {
    if (pendJogo.some(p => p.strat === sf)) {
      if (total === 0 && raioMand) {
        await alertar(`${sf}_0x0`, `${STRAT_DISPLAY[sf]}\n💡 0x0 + Raio do Mandante!\n🎯 Lay Visitante · Odd: ${oddFora.toFixed(2)}`, `${sf}_live`);
      }
      if (golsFora > golsCasa && raioMand && tempo <= 70) {
        await alertar(`${sf}_perd_${placar}`, `${STRAT_DISPLAY[sf]}\n💡 Mandante perdendo + Raio!\n🎯 Lay Visitante · Odd: ${oddFora.toFixed(2)}`, `${sf}_live`);
      }
      if (golsFora > golsCasa && raioMand && tempo > 70) {
        await alertar(`${sf}_pos70_${placar}`, `${STRAT_DISPLAY[sf]}\n💡 Mandante perdendo + Raio (após min 70)!\n🎯 Mercado de GOLS · Odd: ${oddFora.toFixed(2)}`, `${sf}_live`);
      }
    }
  }

  // BACK GONZA COM xG
  if (pendJogo.some(p => p.strat === 'back_gonza_xg')) {
    if (is1T && tempo <= 20 && total === 0 && raioMand) {
      await alertar('back_gonza_c1', `🔵 <b>BACK GONZA xG</b>\n💡 Raio Mandante até min 20 · 0x0!\n🎯 Odd: ${oddCasa.toFixed(2)}`, 'back_gonza_xg_live');
    }
    if (tempo > 35 && total === 0 && raioMand) {
      await alertar('back_gonza_c2', `🔵 <b>BACK GONZA xG</b>\n💡 Raio Mandante após min 35 · 0x0!\n🎯 Odd: ${oddCasa.toFixed(2)}`, 'back_gonza_xg_live');
    }
    if (is2T && total === 0 && tempo <= 70 && raioMand) {
      await alertar('back_gonza_c3', `🔵 <b>BACK GONZA xG — 2T!</b>\n💡 0x0 + Raio Mandante no 2T!\n🎯 Odd: ${oddCasa.toFixed(2)}`, 'back_gonza_xg_live');
    }
  }

  // FELIPE OVER 1.5
  if (pendJogo.some(p => p.strat === 'felipe_over15')) {
    if (total === 0 && temRaio) {
      await alertar('felipe15_0x0', `🟠 <b>FELIPE OVER 1.5</b>\n💡 0x0 + Raio!`, 'felipe_over15_live');
    }
    if (is1T && total === 1 && temRaio) {
      const perdendoCasa = golsCasa < golsFora;
      const raioPerdendo = (perdendoCasa && raioMand) || (!perdendoCasa && raioVisit);
      if (raioPerdendo) {
        await alertar(`felipe15_perd_${placar}`, `🟠 <b>FELIPE OVER 1.5</b>\n💡 ${placar} + Raio do time perdendo!`, 'felipe_over15_live');
      }
    }
  }

  // LAY 0x2 MANU
  if (pendJogo.some(p => p.strat === 'lay_0x2')) {
    if (golsCasa === 0 && golsFora <= 2 && raioMand) {
      await alertar(`lay_0x2_${placar}`, `⚪ <b>LAY 0x2 MANU</b>\n💡 Raio Mandante · ${placar}!`, 'lay_0x2_live');
    }
  }

  // LAY 0x3
  if (pendJogo.some(p => p.strat === 'lay_0x3')) {
    if (golsCasa === 0 && golsFora <= 3 && raioMand) {
      await alertar(`lay_0x3_${placar}`, `⚪ <b>LAY 0x3</b>\n💡 Raio Mandante · ${placar}!`, 'lay_0x3_live');
    }
  }

  // LAY xG
  if (pendJogo.some(p => p.strat === 'lay_xg')) {
    const p = pendJogo.find(p => p.strat === 'lay_xg');
    const layHome = p?.lay_team === 'home';
    const maiorXgRaio = layHome ? raioVisit : raioMand;
    const empatado = golsCasa === golsFora;
    const menorXgFrente = (layHome && golsCasa > golsFora) || (!layHome && golsFora > golsCasa);
    if (maiorXgRaio && (empatado || menorXgFrente)) {
      await alertar(`lay_xg_${placar}`, `🟣 <b>LAY xG</b>\n💡 Raio do time de maior xG!`, 'lay_xg_live');
    }
  }

  // AM xG
  if (pendJogo.some(p => p.strat === 'am_xg')) {
    if (total === 0 && todosRaiosCasa.length > 0 && todosRaiosFora.length > 0) {
      await alertar('am_xg_0x0', `🟤 <b>AM xG — AMBAS MARCAM</b>\n💡 0x0 + Raio dos dois times!`, 'am_xg_live');
    }
    if (total === 1 && temRaio) {
      const raioPerdendo = (golsCasa > golsFora && raioVisit) || (golsFora > golsCasa && raioMand);
      if (raioPerdendo) {
        await alertar(`am_xg_perd_${placar}`, `🟤 <b>AM xG</b>\n💡 ${placar} + Raio do time perdendo!`, 'am_xg_live');
      }
    }
    if (isHT && total === 0 && tevRaioMand) {
      await alertar('am_xg_atolada', `⚡ <b>ATOLADA MASTER DO GONZA!</b>\n💡 AM xG + HT 0x0 + Raio no 1T!`, 'atolada_master_live');
    }
  }

  // OVER 0.5 (bolinha verde)
  if (pendJogo.some(p => p.strat === 'over05')) {
    if (isHT && total === 0 && tevRaioMand) {
      await alertar('over05_ht_entrada', `🟢 <b>OVER 0.5 — Entrar no Intervalo!</b>\n💡 HT 0x0 + Teve Raio no 1T!`, 'over05_live');
    }
    if (is2T && total === 0 && temRaio) {
      await alertar('over05_2t', `🟢 <b>OVER 0.5 — Raio no 2T!</b>\n💡 0x0 + Raio no 2T!`, 'over05_live');
    }
  }

  // AM (bolinha vermelha)
  if (pendJogo.some(p => p.strat === 'am')) {
    if (total === 0 && todosRaiosCasa.length > 0 && todosRaiosFora.length > 0) {
      await alertar('am_0x0', `🔴 <b>AM — AMBAS MARCAM</b>\n💡 0x0 + Raio dos dois times!`, 'am_live');
    }
    if (total === 1 && temRaio) {
      const raioPerdendo = (golsCasa > golsFora && raioVisit) || (golsFora > golsCasa && raioMand);
      if (raioPerdendo) {
        await alertar(`am_perd_${placar}`, `🔴 <b>AM</b>\n💡 ${placar} + Raio do time perdendo!`, 'am_live');
      }
    }
  }
}

// ── Processar fim de jogo ─────────────────────────────────────
async function processarFimDeJogo(jogoId, estado, hoje) {
  console.log(`[FIM] ${jogoId}`);
  const jogo = estado.jogo;
  if (!jogo) return;

  const golsCasa = parseInt(jogo.gols_casa) || 0;
  const golsFora = parseInt(jogo.gols_fora) || 0;
  const placarFT = `${golsCasa}x${golsFora}`;

  const pendJogo = pendentes.filter(p =>
    p.data === hoje && p.result === 'pendente' &&
    (p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`)
  );

  for (const p of pendJogo) {
    p.final = placarFT;
    const res = calcularResultado(p.strat, golsCasa, golsFora);
    if (res && res !== null) p.result = res;
    else p.result = 'resolvido';
  }

  salvarArquivo(PEND_FILE, pendentes);

  // Editar mensagens Telegram com resultado
  for (const [stratKey, alertasArr] of Object.entries(estado.msgIds || {})) {
    // Pegar o último alerta enviado para esta strat
    if (!alertasArr || !alertasArr.length) continue;
    const ultimoAlerta = alertasArr[alertasArr.length - 1];
    const ids = ultimoAlerta.ids;

    // Encontrar resultado desta strat
    const stratBase = stratKey.replace(/_entrada$|_0x0$|_raio$|_c[123]$/, '').replace(/_live$/, '');
    const pLive = pendJogo.find(p => {
      const ps = p.strat.replace(/_live$/, '');
      return ps === stratBase || p.strat === stratKey || p.condicao === stratKey;
    });

    const res = pLive?.result;
    const emoji = res === 'green' ? '✅ GREEN' : res === 'red' ? '❌ RED' : '⏳';
    const display = STRAT_DISPLAY[stratBase] || stratKey;
    const msgEdit = `${display}\n⚽ ${jogo.mandante} x ${jogo.visitante}\n${emoji} · FT: ${placarFT}`;
    await editTelegram(ids, msgEdit);
  }

  await sendTelegram(`🏁 <b>FIM DE JOGO</b>\n⚽ ${jogo.mandante} x ${jogo.visitante}\n📊 FT: ${placarFT}`);
}

// ── ROUTES ────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    version: 'server_35',
    pendentes: pendentes.filter(p => p.result === 'pendente').length,
    jogos_live: Object.keys(estadoLive).filter(k => !estadoLive[k].encerrado).length,
    uptime: Math.floor(process.uptime()) + 's'
  });
});

app.get('/pendentes', (req, res) => res.json(pendentes));
app.post('/pendentes', (req, res) => {
  const novos = req.body;
  if (!Array.isArray(novos)) return res.status(400).json({ error: 'Array esperado' });
  if (novos.length === 0) return res.json({ ok: true, total: pendentes.length, aviso: 'vazia ignorada' });
  const idsNovos = new Set(novos.map(p => String(p.id)));
  const mantidos = pendentes.filter(p => !idsNovos.has(String(p.id)) && p.result === 'pendente');
  pendentes = [...novos, ...mantidos];
  salvarArquivo(PEND_FILE, pendentes);
  res.json({ ok: true, total: pendentes.length });
});

app.get('/dados', (req, res) => res.json(dadosHist));
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
      minuto: v.ultimoMinuto,
      encerrado: v.encerrado,
      momentum_len: v.momentum.length,
      eventos_len: v.eventos.length,
      alertas: Object.keys(v.msgIds || {})
    };
  }
  res.json(resumo);
});

app.post('/testar-telegram', async (req, res) => {
  await sendTelegram('✅ FUTATS Server v35 funcionando! 🎯');
  res.json({ ok: true });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`FUTATS Server v35 na porta ${PORT}`);
  await buscarPreJogo();
  setInterval(buscarPreJogo, 6 * 60 * 60 * 1000);
  setInterval(monitorarLive, 90 * 1000);
  await sendTelegram('🚀 FUTATS Server v35 iniciado!\n✅ Alertas: 1x por estratégia + atualização por placar\n✅ Resultados lay CS corrigidos');
});
