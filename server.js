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

// Estado live acumulado por jogo { [jogoId]: { momentum, eventos, ultimoMinuto, ultimaVez, snapshotAlerta, encerrado, msgIds } }
let estadoLive = {};
// Alertas já disparados { [jogoId_condicao]: true }
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
  // Evitar duplicata
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

// ── Resultado GREEN/RED de estratégias pré-jogo ──────────────
function calcularResultadoPre(strat, jogo, placar) {
  const { ftH, ftA, golsCasa, golsFora } = placar;
  const favorito = getFavorito(jogo);
  const favoritoVenceu = favorito === 'casa' ? ftH > ftA : ftA > ftH;

  switch(strat) {
    case 'back_favorito':        return favoritoVenceu ? 'green' : 'red';
    case 'recuperacao_favorito': return null; // só live
    case 'gol_no_final':        return (ftH + ftA) > (golsCasa + golsFora) ? 'green' : 'red'; // gol no 2T
    case 'over05_ht':           return (ftH + ftA) > 0 ? 'green' : 'red'; // simplificado — usa HT
    case 'over15':              return (ftH + ftA) >= 2 ? 'green' : 'red';
    case 'over25':              return (ftH + ftA) >= 3 ? 'green' : 'red';
    case 'ambas_marcam':        return (ftH > 0 && ftA > 0) ? 'green' : 'red';
    case 'lay_0x1':             return (ftH === 0 && ftA === 1) ? 'red' : 'green';
    case 'lay_1x0':             return (ftH === 1 && ftA === 0) ? 'red' : 'green';
    case 'lay_goleada_visit':   return (ftA - ftH >= 4 && ftA > ftH) ? 'red' : 'green';
    case 'lay_goleada_mand':    return (ftH - ftA >= 4 && ftH > ftA) ? 'red' : 'green';
    case 'correcao_lay_fav':    return null; // só live
    case 'correcao_lay_zebra':  return null; // só live
    case 'favorito_ht_gonza':   return ftA > ftH ? 'red' : 'green'; // lay visitante
    case 'felipe_over15':       return (ftH + ftA) >= 2 ? 'green' : 'red';
    case 'lay_away_manu':       return ftA > ftH ? 'red' : 'green';
    case 'lay_manu4':           return ftA > ftH ? 'red' : 'green';
    case 'back_gonza_xg':       return ftA > ftH ? 'red' : 'green';
    case 'lay_0x2':             return (ftH === 0 && ftA === 2) ? 'red' : 'green';
    case 'lay_0x3':             return (ftH === 0 && ftA === 3) ? 'red' : 'green';
    case 'lay_xg':              return null; // manual
    case 'am_xg':               return (ftH > 0 && ftA > 0) ? 'green' : 'red';
    case 'over05':              return (ftH + ftA) > 0 ? 'green' : 'red';
    case 'am':                  return (ftH > 0 && ftA > 0) ? 'green' : 'red';
    default:                    return null;
  }
}

// ── Mapa de estratégias: nome exibição ────────────────────────
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

// ── Mapa selecao_ia → strat interno ──────────────────────────
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

// ── PRÉ-JOGO: buscar e registrar jogos das 3 APIs ────────────
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

    // API IA — múltiplas seleções por jogo
    for (const jogo of jogosIA) {
      const selecoes = (jogo.selecao_ia || '').split(',').map(s => s.trim()).filter(Boolean);
      for (const sel of selecoes) {
        const strat = IA_PARA_STRAT[sel];
        if (!strat) continue;
        registrarPendente({ ...jogo, selecao_ia: sel }, strat, 'pre');
        registrados++;
      }
    }

    // API Filtros — múltiplos filtros por jogo
    for (const jogo of jogosFiltros) {
      const filtros = (jogo.filtros_partida || '').split(',').map(s => s.trim()).filter(Boolean);
      for (const filtro of filtros) {
        const strat = FILTRO_PARA_STRAT[filtro];
        if (!strat) continue;
        registrarPendente({ ...jogo, filtros_partida: filtro }, strat, 'pre');
        registrados++;
      }
    }

    // API Estratégias — bolinhas manuais
    for (const jogo of jogosEst) {
      const estrategias = (jogo.estrategias_partida || '').split(',').map(s => s.trim()).filter(Boolean);
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

// ── LIVE: monitorar API live do futats ────────────────────────
async function monitorarLive() {
  try {
    const rLive = await futatsGet('api-games-live');
    const jogosLive = rLive[0]?.eventos || [];
    const agora = Date.now();
    const hoje = dataHoje();

    // Marcar jogos que ainda estão ao vivo
    const idsLive = new Set(jogosLive.map(j => j.mandante + '_' + j.visitante));

    // Detectar jogos que saíram do live (possível encerramento)
    for (const [jogoId, estado] of Object.entries(estadoLive)) {
      if (!idsLive.has(jogoId) && !estado.encerrado) {
        const minSemDados = (agora - estado.ultimaVez) / 60000;
        const minJogo = estado.ultimoMinuto || 0;
        // Se passou 2-3 min sem dados após min 88+ → encerrado
        if (minSemDados >= 2 && minJogo >= 88) {
          estado.encerrado = true;
          await processarFimDeJogo(jogoId, estado, hoje);
        }
      }
    }

    // Processar cada jogo ao vivo
    for (const jogo of jogosLive) {
      const jogoId = jogo.mandante + '_' + jogo.visitante;

      // Inicializar estado se novo
      if (!estadoLive[jogoId]) {
        estadoLive[jogoId] = {
          jogo, momentum: [], eventos: [], ultimoMinuto: 0,
          ultimaVez: agora, snapshotAlerta: null, encerrado: false,
          msgIds: {} // { [condicao]: [{ chatId, messageId }] }
        };
      }

      const estado = estadoLive[jogoId];
      estado.ultimaVez = agora;
      estado.jogo = jogo;

      // Acumular momentum — adicionar apenas minutos novos
      const momNovos = (jogo.momentum || []);
      for (const m of momNovos) {
        if (!estado.momentum.find(x => x.minuto === m.minuto)) {
          estado.momentum.push(m);
        }
      }

      // Acumular eventos — adicionar apenas novos
      const evNovos = (jogo.eventos || []);
      for (const ev of evNovos) {
        const jaExiste = estado.eventos.find(x =>
          x.minuto === ev.minuto && x.tipo_evento === ev.tipo_evento && x.lado === ev.lado
        );
        if (!jaExiste) estado.eventos.push(ev);
      }

      // Atualizar último minuto
      if (estado.momentum.length > 0) {
        estado.ultimoMinuto = Math.max(...estado.momentum.map(m => m.minuto));
      }

      // Verificar encerrado pelo tempo (status "Encerrado")
      if (jogo.tempo === 'Encerrado' && !estado.encerrado) {
        estado.encerrado = true;
        await processarFimDeJogo(jogoId, estado, hoje);
        continue;
      }

      // Processar alertas live
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
  const oddFav   = favorito === 'casa' ? oddCasa : oddFora;
  const oddZebra = favorito === 'casa' ? oddFora : oddCasa;
  const is1T     = periodo === '1_tempo' || tempo <= 45;
  const is2T     = periodo === '2_tempo' || tempo > 45;
  const isHT     = jogo.tempo === 'Intervalo';

  // Raios do último minuto
  const evNovos = jogo.eventos || [];
  const raiosCasa  = evNovos.filter(e => e.tipo_evento === 'raio' && e.lado === 'casa');
  const raiosFora  = evNovos.filter(e => e.tipo_evento === 'raio' && e.lado === 'fora');
  const raioFav    = favorito === 'casa' ? raiosCasa.length > 0 : raiosFora.length > 0;
  const raioZebra  = favorito === 'casa' ? raiosFora.length > 0 : raiosCasa.length > 0;
  const raioMand   = raiosCasa.length > 0;
  const raioVisit  = raiosFora.length > 0;
  const temRaio    = raiosCasa.length > 0 || raiosFora.length > 0;

  // Chutes no gol (para Over 0.5 HT condição 2)
  const chutesGolCasa  = evNovos.filter(e => e.tipo_evento === 'chute_no_gol' && e.lado === 'casa').length;
  const chutesGolFora  = evNovos.filter(e => e.tipo_evento === 'chute_no_gol' && e.lado === 'fora').length;

  // Histórico de raios acumulados
  const todosRaiosCasa  = estado.eventos.filter(e => e.tipo_evento === 'raio' && e.lado === 'casa');
  const todosRaiosFora  = estado.eventos.filter(e => e.tipo_evento === 'raio' && e.lado === 'fora');
  const tevRaioFav      = favorito === 'casa' ? todosRaiosCasa.length > 0 : todosRaiosFora.length > 0;
  const tevRaioMand     = todosRaiosCasa.length > 0;

  // Buscar pendentes deste jogo
  const pendJogo = pendentes.filter(p =>
    p.data === hoje && p.result === 'pendente' &&
    (p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`)
  );

  async function alertar(condicao, texto, strat = null) {
    const nKey = `${jogoId}_${condicao}`;
    if (notificados[nKey]) return;
    notificados[nKey] = true;

    // Salvar snapshot do gráfico no estado
    if (!estado.snapshotAlerta) {
      estado.snapshotAlerta = {
        momentum: [...estado.momentum],
        eventos: [...estado.eventos],
        minuto: tempo, placar, pressao: jogo.resumo_pressao?.total
      };
    }

    const msg = `${texto}\n⚽ <b>${jogo.mandante} x ${jogo.visitante}</b>\n📊 ${placar} · ${tempo}'\n⏰ ${hora}${links}`;
    const ids = await sendTelegram(msg);
    estado.msgIds[condicao] = ids;

    // Registrar entrada live
    if (strat) {
      const pendLive = registrarPendente({
        ...jogo, fixture_id: pendJogo[0]?.fixture_id || null
      }, strat, 'live');
      pendLive.condicao = condicao;
      pendLive.msgIds   = ids;
      salvarArquivo(PEND_FILE, pendentes);
    }
  }

  // ── SELEÇÕES IA ──────────────────────────────────────────────

  // 1. BACK FAVORITO
  if (pendJogo.some(p => p.strat === 'back_favorito')) {
    // C1: 0x0 até min 70 + raio favorito
    if (total === 0 && tempo <= 70 && raioFav) {
      await alertar(`back_fav_c1_${tempo}`, `🤖 <b>BACK FAVORITO</b>\n💡 0x0 + Raio do Favorito!`, 'back_favorito_live');
    }
    // C2: Favorito perdendo por 1 até min 70 + raio favorito
    const favPerdendo = (favorito === 'casa' && golsFora - golsCasa === 1) ||
                        (favorito === 'fora' && golsCasa - golsFora === 1);
    if (favPerdendo && tempo <= 70 && raioFav) {
      await alertar(`back_fav_c2_${placar}`, `🤖 <b>BACK FAVORITO — Recuperação!</b>\n💡 Favorito perdendo + Raio!`, 'back_favorito_live');
      // Se zebra marcar depois de C1 disparado
    }
    // Sub-alerta: se zebra marcou após C1
    if (notificados[`${jogoId}_back_fav_c1_${tempo}`] && total > 0) {
      const favorPerdendoAgora = (favorito === 'casa' && golsFora > golsCasa) ||
                                  (favorito === 'fora' && golsCasa > golsFora);
      if (favorPerdendoAgora) {
        await alertar(`back_fav_zebra_${placar}`, `🤖 <b>BACK FAVORITO — Zebra marcou!</b>\n⚠️ Favorito perdendo — considere entrar novamente`, 'back_favorito_live');
      }
    }
  }

  // 2. RECUPERAÇÃO FAVORITO (exclusivo live)
  if (pendJogo.some(p => p.strat === 'recuperacao_favorito') || true) {
    const favPerdendo1 = (favorito === 'casa' && golsFora - golsCasa === 1) ||
                         (favorito === 'fora' && golsCasa - golsFora === 1);
    if (favPerdendo1 && tevRaioFav) {
      await alertar(`recup_fav_${placar}`, `🤖 <b>RECUPERAÇÃO FAVORITO</b>\n💡 Favorito perdendo por 1 + Raio!`, 'recuperacao_favorito_live');
    }
  }

  // 3. GOL NO FINAL
  if (pendJogo.some(p => p.strat === 'gol_no_final')) {
    if (is2T && temRaio) {
      await alertar(`gol_final_2t_${tempo}`, `🤖 <b>GOL NO FINAL</b>\n💡 Raio no 2T!`, 'gol_no_final_live');
    }
  }

  // 4. OVER 0.5 HT
  if (pendJogo.some(p => p.strat === 'over05_ht')) {
    // C1: 0x0 no 1T + raio
    if (is1T && total === 0 && temRaio) {
      await alertar(`over05ht_c1_${tempo}`, `🤖 <b>OVER 0.5 HT</b>\n💡 0x0 + Raio no 1T!`, 'over05_ht_live');
    }
    // C2: 0x0 até min 20 + chute no gol dos dois times
    if (is1T && total === 0 && tempo <= 20 && chutesGolCasa >= 1 && chutesGolFora >= 1) {
      await alertar(`over05ht_c2_${tempo}`, `🤖 <b>OVER 0.5 HT — Chutes!</b>\n💡 0x0 + Chute no gol dos dois times!`, 'over05_ht_live');
    }
    // C3: 1 gol + raio antes min 20 → Over 1.5 HT
    if (is1T && total === 1 && tempo < 20 && temRaio) {
      await alertar(`over15ht_c3_${tempo}`, `🤖 <b>OVER 1.5 HT</b>\n💡 1 gol + Raio antes do min 20!`, 'over15_ht_live');
    }
  }

  // 5. OVER 1.5
  if (pendJogo.some(p => p.strat === 'over15')) {
    // C1: 0x0 + raio
    if (total === 0 && temRaio) {
      await alertar(`over15_c1_${tempo}`, `🤖 <b>OVER 1.5</b>\n💡 0x0 + Raio!`, 'over15_live');
    }
    // C2: 1 gol + raio time perdendo no 1T
    if (is1T && total === 1 && temRaio) {
      const perdendoCasa = golsCasa < golsFora;
      const raioPerdendo = (perdendoCasa && raioMand) || (!perdendoCasa && raioVisit);
      if (raioPerdendo) {
        await alertar(`over15_c2_${placar}`, `🤖 <b>OVER 1.5</b>\n💡 1 gol + Raio do time perdendo no 1T!`, 'over15_live');
      }
    }
  }

  // 6. OVER 2.5 — mesmas condições Over 1.5 (mercado Over 1.5)
  if (pendJogo.some(p => p.strat === 'over25')) {
    if (total === 0 && temRaio) {
      await alertar(`over25_c1_${tempo}`, `🤖 <b>OVER 2.5</b> (entrar Over 1.5)\n💡 0x0 + Raio!`, 'over25_live');
    }
    if (is1T && total === 1 && temRaio) {
      const perdendoCasa = golsCasa < golsFora;
      const raioPerdendo = (perdendoCasa && raioMand) || (!perdendoCasa && raioVisit);
      if (raioPerdendo) {
        await alertar(`over25_c2_${placar}`, `🤖 <b>OVER 2.5</b> (entrar Over 1.5)\n💡 1 gol + Raio do time perdendo!`, 'over25_live');
      }
    }
  }

  // 7. AMBAS MARCAM
  if (pendJogo.some(p => p.strat === 'ambas_marcam')) {
    // C1: 0x0 + raio mandante E visitante (acumulados)
    if (total === 0 && todosRaiosCasa.length > 0 && todosRaiosFora.length > 0) {
      await alertar(`ambas_c1`, `🤖 <b>AMBAS MARCAM</b>\n💡 0x0 + Raio dos dois times!`, 'ambas_marcam_live');
    }
    // C2: 1x0 + raio do time perdendo
    if (total === 1 && temRaio) {
      const raioPerdendo = (golsCasa > golsFora && raioVisit) || (golsFora > golsCasa && raioMand);
      if (raioPerdendo) {
        await alertar(`ambas_c2_${placar}`, `🤖 <b>AMBAS MARCAM</b>\n💡 ${placar} + Raio do time perdendo!`, 'ambas_marcam_live');
      }
    }
  }

  // 8. LAY RESULTADO 0x1
  if (pendJogo.some(p => p.strat === 'lay_0x1')) {
    if (total === 0 && raioMand) {
      await alertar(`lay0x1_c1_${tempo}`, `🤖 <b>LAY RESULTADO 0x1</b>\n💡 0x0 + Raio do Mandante!`, 'lay_0x1_live');
    }
    if (golsCasa === 0 && golsFora === 1 && raioMand) {
      await alertar(`lay0x1_c2`, `🤖 <b>LAY RESULTADO 0x1</b>\n💡 0x1 + Raio do Mandante!`, 'lay_0x1_live');
    }
  }

  // 9. LAY RESULTADO 1x0
  if (pendJogo.some(p => p.strat === 'lay_1x0')) {
    if (total === 0 && raioVisit) {
      await alertar(`lay1x0_c1_${tempo}`, `🤖 <b>LAY RESULTADO 1x0</b>\n💡 0x0 + Raio do Visitante!`, 'lay_1x0_live');
    }
    if (golsCasa === 1 && golsFora === 0 && raioVisit) {
      await alertar(`lay1x0_c2`, `🤖 <b>LAY RESULTADO 1x0</b>\n💡 1x0 + Raio do Visitante!`, 'lay_1x0_live');
    }
  }

  // 10. LAY GOLEADA VISITANTE
  if (pendJogo.some(p => p.strat === 'lay_goleada_visit')) {
    if (raioMand) {
      await alertar(`lay_gol_visit_${tempo}`, `🤖 <b>LAY GOLEADA VISITANTE</b>\n💡 Raio do Mandante!`, 'lay_goleada_visit_live');
    }
  }

  // 11. LAY GOLEADA MANDANTE
  if (pendJogo.some(p => p.strat === 'lay_goleada_mand')) {
    if (raioVisit) {
      await alertar(`lay_gol_mand_${tempo}`, `🤖 <b>LAY GOLEADA MANDANTE</b>\n💡 Raio do Visitante!`, 'lay_goleada_mand_live');
    }
  }

  // 12. CORREÇÃO LAY FAVORITO (raio zebra até min 5)
  if (tempo <= 5 && raioZebra) {
    if (pendJogo.some(p => p.strat === 'correcao_lay_fav')) {
      await alertar(`corr_fav_${tempo}`, `🤖 <b>CORREÇÃO LAY FAVORITO</b>\n💡 Raio da Zebra no min ${tempo}!`, 'correcao_lay_fav_live');
    }
  }

  // 13. CORREÇÃO LAY ZEBRA (raio favorito até min 5)
  if (tempo <= 5 && raioFav) {
    if (pendJogo.some(p => p.strat === 'correcao_lay_zebra')) {
      await alertar(`corr_zebra_${tempo}`, `🤖 <b>CORREÇÃO LAY ZEBRA</b>\n💡 Raio do Favorito no min ${tempo}!`, 'correcao_lay_zebra_live');
    }
  }

  // ── FILTROS PERSONALIZADOS ───────────────────────────────────

  // FAVORITO HT GONZA / LAY AWAY MANU / LAY MANU 4 — mesmas condições
  const stratsFavGonza = ['favorito_ht_gonza','lay_away_manu','lay_manu4'];
  for (const sf of stratsFavGonza) {
    if (pendJogo.some(p => p.strat === sf)) {
      // C1: 0x0 + raio mandante
      if (total === 0 && raioMand) {
        await alertar(`${sf}_c1_${tempo}`, `${STRAT_DISPLAY[sf]}\n💡 0x0 + Raio do Mandante!\n🎯 Lay Visitante · Odd: ${oddFora.toFixed(2)}`, `${sf}_live`);
      }
      // C2: Mandante perdendo + raio mandante
      if (golsFora > golsCasa && raioMand) {
        if (tempo <= 70) {
          await alertar(`${sf}_c2_${placar}`, `${STRAT_DISPLAY[sf]}\n💡 Mandante perdendo + Raio!\n🎯 Lay Visitante · Odd: ${oddFora.toFixed(2)}\n⏰ Até min 70: GREEN se empatou`, `${sf}_live`);
        } else {
          await alertar(`${sf}_c2pos70_${placar}`, `${STRAT_DISPLAY[sf]}\n💡 Mandante perdendo + Raio (após min 70)!\n🎯 Mercado de GOLS · Odd: ${oddFora.toFixed(2)}`, `${sf}_live`);
        }
      }
    }
  }

  // BACK GONZA COM xG
  if (pendJogo.some(p => p.strat === 'back_gonza_xg')) {
    // C1: raio mandante até min 20 com 0x0
    if (is1T && tempo <= 20 && total === 0 && raioMand) {
      await alertar(`back_gonza_c1_${tempo}`, `🔵 <b>BACK GONZA xG</b>\n💡 Raio Mandante até min 20 · 0x0!\n🎯 Back Mandante vencer 1T · Odd: ${oddCasa.toFixed(2)}`, 'back_gonza_xg_live');
    }
    // C2: raio mandante após min 35 com 0x0
    if (tempo > 35 && total === 0 && raioMand) {
      await alertar(`back_gonza_c2_${tempo}`, `🔵 <b>BACK GONZA xG</b>\n💡 Raio Mandante após min 35 · 0x0!\n🎯 Back Mandante · Odd: ${oddCasa.toFixed(2)}`, 'back_gonza_xg_live');
    }
    // Sub-alerta C2: visitante marcou após alerta
    if (notificados[`${jogoId}_back_gonza_c2_${tempo}`] && golsFora > golsCasa) {
      await alertar(`back_gonza_c2_visit_${placar}`, `🔵 <b>BACK GONZA xG — Visitante marcou!</b>\n🎯 Lay Visitante · Odd: ${oddFora.toFixed(2)}`, 'back_gonza_xg_live');
    }
    // C3: RED no 1T, 0x0 no 2T, raio mandante até min 70
    if (is2T && total === 0 && tempo <= 70 && raioMand) {
      await alertar(`back_gonza_c3_${tempo}`, `🔵 <b>BACK GONZA xG — 2T!</b>\n💡 0x0 + Raio Mandante no 2T!\n🎯 Back Mandante · Odd: ${oddCasa.toFixed(2)}`, 'back_gonza_xg_live');
    }
  }

  // FELIPE OVER 1.5 — mesmas condições Over 1.5
  if (pendJogo.some(p => p.strat === 'felipe_over15')) {
    if (total === 0 && temRaio) {
      await alertar(`felipe15_c1_${tempo}`, `🟠 <b>FELIPE OVER 1.5</b>\n💡 0x0 + Raio!`, 'felipe_over15_live');
    }
    if (is1T && total === 1 && temRaio) {
      const perdendoCasa = golsCasa < golsFora;
      const raioPerdendo = (perdendoCasa && raioMand) || (!perdendoCasa && raioVisit);
      if (raioPerdendo) {
        await alertar(`felipe15_c2_${placar}`, `🟠 <b>FELIPE OVER 1.5</b>\n💡 1 gol + Raio do time perdendo!`, 'felipe_over15_live');
      }
    }
  }

  // LAY 0x2 MANU
  if (pendJogo.some(p => p.strat === 'lay_0x2')) {
    const placaOk = (golsCasa === 0 && golsFora <= 2);
    if (placaOk && raioMand) {
      await alertar(`lay0x2_${placar}`, `⚪ <b>LAY 0x2 MANU</b>\n💡 Raio Mandante · ${placar}!`, 'lay_0x2_live');
    }
  }

  // LAY 0x3
  if (pendJogo.some(p => p.strat === 'lay_0x3')) {
    const placaOk = (golsCasa === 0 && golsFora <= 3);
    if (placaOk && raioMand) {
      await alertar(`lay0x3_${placar}`, `⚪ <b>LAY 0x3</b>\n💡 Raio Mandante · ${placar}!`, 'lay_0x3_live');
    }
  }

  // LAY xG — raio do time de maior xG com jogo empatado ou menor xG na frente
  if (pendJogo.some(p => p.strat === 'lay_xg')) {
    const p = pendJogo.find(p => p.strat === 'lay_xg');
    const layHome = p?.lay_team === 'home'; // menor xG = home → maior xG = away
    const maiorXgRaio = layHome ? raioVisit : raioMand; // raio do maior xG
    const empatado = golsCasa === golsFora;
    const menorXgFrente = (layHome && golsCasa > golsFora) || (!layHome && golsFora > golsCasa);
    if (maiorXgRaio && (empatado || menorXgFrente)) {
      await alertar(`lay_xg_${placar}`, `🟣 <b>LAY xG</b>\n💡 Raio do time de maior xG!`, 'lay_xg_live');
    }
  }

  // AM xG — mesmas condições Ambas Marcam + Atolada Master no HT 0x0
  if (pendJogo.some(p => p.strat === 'am_xg')) {
    if (total === 0 && todosRaiosCasa.length > 0 && todosRaiosFora.length > 0) {
      await alertar(`am_xg_c1`, `🟤 <b>AM xG — AMBAS MARCAM</b>\n💡 0x0 + Raio dos dois times!`, 'am_xg_live');
    }
    if (total === 1 && temRaio) {
      const raioPerdendo = (golsCasa > golsFora && raioVisit) || (golsFora > golsCasa && raioMand);
      if (raioPerdendo) {
        await alertar(`am_xg_c2_${placar}`, `🟤 <b>AM xG</b>\n💡 ${placar} + Raio do time perdendo!`, 'am_xg_live');
      }
    }
    // Atolada Master no HT 0x0 (só se teve raio no 1T)
    if (isHT && total === 0 && tevRaioMand) {
      await alertar(`am_xg_atolada`, `⚡ <b>ATOLADA MASTER DO GONZA!</b>\n💡 AM xG + HT 0x0 + Raio no 1T!`, 'atolada_master_live');
    }
  }

  // OVER 0.5 (bolinha verde) — raio 1T entra HT, senão aguarda raio 2T
  if (pendJogo.some(p => p.strat === 'over05')) {
    if (isHT && total === 0 && tevRaioMand) {
      await alertar(`over05_ht_raio`, `🟢 <b>OVER 0.5 — Entrar no Intervalo!</b>\n💡 HT 0x0 + Teve Raio no 1T!`, 'over05_live');
    }
    if (is2T && total === 0 && temRaio) {
      await alertar(`over05_2t_${tempo}`, `🟢 <b>OVER 0.5 — Raio no 2T!</b>\n💡 0x0 + Raio no 2T!`, 'over05_live');
    }
  }

  // AM (bolinha vermelha) — mesmas condições Ambas Marcam
  if (pendJogo.some(p => p.strat === 'am')) {
    if (total === 0 && todosRaiosCasa.length > 0 && todosRaiosFora.length > 0) {
      await alertar(`am_c1`, `🔴 <b>AM — AMBAS MARCAM</b>\n💡 0x0 + Raio dos dois times!`, 'am_live');
    }
    if (total === 1 && temRaio) {
      const raioPerdendo = (golsCasa > golsFora && raioVisit) || (golsFora > golsCasa && raioMand);
      if (raioPerdendo) {
        await alertar(`am_c2_${placar}`, `🔴 <b>AM</b>\n💡 ${placar} + Raio do time perdendo!`, 'am_live');
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

  // Salvar snapshot final
  estado.snapshotFinal = {
    momentum: [...estado.momentum],
    eventos: [...estado.eventos],
    placar: placarFT,
    pressao: jogo.resumo_pressao?.total
  };

  // Resolver pendentes pré e live deste jogo
  const pendJogo = pendentes.filter(p =>
    p.data === hoje && p.result === 'pendente' &&
    (p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`)
  );

  for (const p of pendJogo) {
    p.final = placarFT;
    const res = calcularResultadoPre(p.strat, jogo, { ftH: golsCasa, ftA: golsFora, golsCasa: 0, golsFora: 0 });
    if (res) p.result = res;
    else p.result = 'resolvido';
  }

  salvarArquivo(PEND_FILE, pendentes);

  // Editar mensagens Telegram com resultado
  for (const [condicao, ids] of Object.entries(estado.msgIds || {})) {
    const pLive = pendJogo.find(p => p.condicao === condicao);
    if (!pLive) continue;
    const emoji = pLive.result === 'green' ? '✅ GREEN' : '❌ RED';
    const msgOrig = `${STRAT_DISPLAY[pLive.strat] || pLive.strat}\n⚽ ${jogo.mandante} x ${jogo.visitante}\n${emoji} · FT: ${placarFT}`;
    await editTelegram(ids, msgOrig);
  }

  // Notificar FT no Telegram
  await sendTelegram(`🏁 <b>FIM DE JOGO</b>\n⚽ ${jogo.mandante} x ${jogo.visitante}\n📊 FT: ${placarFT}`);
}

// ── ROUTES ────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
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
      eventos_len: v.eventos.length
    };
  }
  res.json(resumo);
});

app.post('/testar-telegram', async (req, res) => {
  await sendTelegram('✅ FUTATS Server v34 funcionando! 🎯');
  res.json({ ok: true });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`FUTATS Server v34 na porta ${PORT}`);

  // Buscar pré-jogo na inicialização e depois a cada 6h
  await buscarPreJogo();
  setInterval(buscarPreJogo, 6 * 60 * 60 * 1000);

  // Monitorar live a cada 90 segundos
  setInterval(monitorarLive, 90 * 1000);

  await sendTelegram('🚀 FUTATS Server v34 iniciado!\n✅ APIs futats.com integradas\n✅ Alertas live configurados');
});
