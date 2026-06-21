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
// Data de N dias atrás (BRT), formato YYYY-MM-DD
function dataOffsetBRT(diasAtras) {
  const d = new Date(new Date().getTime() - 3*60*60*1000);
  d.setDate(d.getDate() - diasAtras);
  return d.toISOString().split('T')[0];
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

// ── Envio paginado para mensagens longas ──────────────────────
// Recebe um cabeçalho (sempre na 1ª parte) e uma lista de "blocos" de texto
// (cada bloco = ex. um jogo inteiro, ou um horário inteiro) que NUNCA são
// cortados no meio. Agrupa blocos em mensagens até o limite de caracteres,
// numerando "parte X/Y" quando há mais de uma mensagem.
const TELEGRAM_LIMITE_CHARS = 3800; // margem de segurança abaixo do limite real de 4096

async function enviarEmPartes(cabecalho, blocos, rodape = '') {
  const partes = [];
  let atual = cabecalho;

  for (const bloco of blocos) {
    // Se adicionar este bloco ultrapassar o limite, fecha a parte atual e abre outra
    if ((atual + bloco).length > TELEGRAM_LIMITE_CHARS && atual !== cabecalho) {
      partes.push(atual);
      atual = '';
    }
    atual += bloco;
  }
  if (atual) partes.push(atual);

  // Anexa o rodapé na última parte
  if (rodape && partes.length) {
    partes[partes.length - 1] += rodape;
  } else if (rodape) {
    partes.push(rodape);
  }

  const total = partes.length;
  for (let i = 0; i < total; i++) {
    const prefixo = total > 1 ? `<i>(parte ${i+1}/${total})</i>\n` : '';
    await sendTelegram(prefixo + partes[i]);
  }
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
    case 'lay_0x3':               return (ftH === 0 && ftA === 3) ? 'red' : 'green';
    case 'lay_goleada_visit':    return (ftA - ftH >= 4 && ftA > ftH) ? 'red' : 'green';
    case 'lay_goleada_mand':     return (ftH - ftA >= 4 && ftH > ftA) ? 'red' : 'green';
    case 'favorito_ht_gonza':
    case 'lay_away_manu':
    case 'lay_manu4':            return ftA > ftH ? 'red' : 'green';
    case 'lay_xg':                return null;
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
    case 'ambas_marcam_xg':       return (ftH > 0 && ftA > 0) ? 'green' : 'red';
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
  ambas_marcam_xg:       '🟤 Ambas Marcam xG',
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
  'ambas marcam xg':    'ambas_marcam_xg',
};

const ESTRAT_PARA_STRAT = {
  'Over 0,5 Gonza':   'over05',
  'Felipe over 1.5':  'felipe_over15',
  'Back Favorito HT': 'back_fav_ht',
  'Lay xG':           'lay_xg',
  'AM xG':            'am_xg',
  'AM':               'am',
  'ambas marcam xg':  'ambas_marcam_xg',
};

// ── CARD MATINAL ──────────────────────────────────────────────
async function enviarCardMatinal(dataAlvo = null) {
  const hoje = dataAlvo || dataHoje();
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

  const cabecalho = `📋 <b>FUTATS — Jogos do dia ${dd}/${mm}/${yyyy}</b>\n`;

  // Cada bloco = um horário inteiro com todos os jogos daquele horário
  // (nunca corta um horário no meio entre duas mensagens)
  const blocos = [];
  for (const [hora, jogos] of Object.entries(byHora)) {
    let bloco = `\n🕐 <b>${hora}</b>\n`;
    for (const j of jogos) {
      const stratsDisplay = j.strats.map(s => STRAT_DISPLAY[s] || s).join(' · ');
      bloco += `⚽ ${j.jogo}\n${stratsDisplay}\n`;
    }
    blocos.push(bloco);
  }

  const rodape = `\n📊 ${jogosOrdenados.length} jogo(s) · ${pendHoje.length} estratégia(s)`;

  await enviarEmPartes(cabecalho, blocos, rodape);
  console.log('[CARD] Card matinal enviado.');
}

// ── RESUMO DO DIA ─────────────────────────────────────────────
async function enviarResumoDia(dataAlvo = null) {
  const hoje = dataAlvo || dataHoje();
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

  // Cada bloco = um jogo inteiro com todas as estratégias dele
  // (nunca corta um jogo no meio entre duas mensagens)
  const blocos = [];
  for (const j of jogosOrdenados) {
    const stratsStr = j.strats.map(p => {
      const nome = STRAT_DISPLAY[p.strat.replace(/_live$/, '')] || p.strat;
      const tipo = p.tipo === 'live' ? ' 🔴live' : '';
      if (p.result === 'green') { greens++; return `${nome}${tipo} ✅`; }
      if (p.result === 'red')   { reds++;   return `${nome}${tipo} ❌`; }
      pendCount++;
      return `${nome}${tipo} ⏳`;
    }).join('\n  ');

    blocos.push(`\n⚽ <b>${j.jogo}</b> · ${j.hora}\n  ${stratsStr}\n`);
  }

  const cabecalho = `📊 <b>FUTATS — Resumo ${dd}/${mm}/${yyyy}</b>`;
  const rodape = greens + reds > 0
    ? `\n✅ ${greens} GREEN · ❌ ${reds} RED · ⏳ ${pendCount} pendente(s)`
    : `\n⏳ ${pendCount} pendente(s)`;

  await enviarEmPartes(cabecalho, blocos, rodape);
  console.log('[RESUMO] Resumo do dia enviado.');
}

// ── RESUMO DO DIA ANTERIOR + CARD DO NOVO DIA (00h BRT) ───────
async function enviarResumoECard() {
  const ontem = dataOffsetBRT(1);
  console.log(`[00H] Enviando resumo final de ${ontem} + card do novo dia`);
  await enviarResumoDia(ontem);
  await enviarCardMatinal();
}

// ── RESOLVER PENDENTES ANTIGOS ────────────────────────────────
// Pendentes de dias anteriores que ficaram presos (servidor reiniciou)
// → busca na api-games-live se o jogo ainda está ativo
// → se não estiver, tenta resolver via api-games-live pelo placar atual
// → se não encontrar, marca como 'resolvido' para edição manual
async function resolverPendentesAntigos() {
  const hoje = dataHoje();
  const antigos = pendentes.filter(p => p.result === 'pendente' && p.data < hoje);
  if (!antigos.length) return;
  console.log(`[ANTIGOS] ${antigos.length} pendentes de dias anteriores encontrados`);

  // Buscar live atual para ver se algum jogo ainda está rodando
  let jogosLive = [];
  try {
    const rLive = await futatsGet('api-games-live');
    jogosLive = rLive[0]?.eventos || [];
  } catch(e) {}

  const jogosLiveIds = new Set(jogosLive.map(j => `${j.mandante}_${j.visitante}`));

  let resolvidos = 0;
  for (const p of antigos) {
    const jogoId = `${p.home}_${p.away}`;
    // Se ainda está no live, deixa
    if (jogosLiveIds.has(jogoId)) continue;
    // Não está no live → jogo acabou, mas não temos placar
    // Marca como 'resolvido' para edição manual no index
    p.result = 'resolvido';
    p.final  = p.final || '?x?';
    resolvidos++;
  }

  if (resolvidos > 0) {
    salvarArquivo(PEND_FILE, pendentes);
    console.log(`[ANTIGOS] ${resolvidos} pendentes marcados como resolvidos (edição manual necessária)`);
    await sendTelegram(
      `⚠️ <b>FUTATS — Pendentes antigos</b>\n` +
      `${resolvidos} jogo(s) de ontem precisam de placar manual no index:\n` +
      antigos.filter(p => p.result === 'resolvido').map(p => `• ${p.jogo} (${p.strat})`).join('\n')
    );
  }
}

// ── PRÉ-JOGO ─────────────────────────────────────────────────
async function buscarPreJogo() {
  console.log('[PRÉ] Buscando jogos das APIs do futats...');

  // Resolver pendentes antigos primeiro
  await resolverPendentesAntigos();

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
        const ultimoMin = estado.ultimoMinuto || 0;
        // Se sumiu do live há 3+ min e já estava nos acréscimos/fim de jogo
        if (minSemDados >= 3 && ultimoMin >= 90) {
          estado.encerrado = true;
          console.log(`[FIM AUTO] ${jogoId} · último min: ${ultimoMin} · sem dados há ${minSemDados.toFixed(1)}min`);
          await processarFimDeJogo(jogoId, estado, hoje);
        }
        // Se sumiu há mais de 10 min independente do minuto → forçar encerramento
        else if (minSemDados >= 10) {
          estado.encerrado = true;
          console.log(`[FIM FORÇADO] ${jogoId} · sem dados há ${minSemDados.toFixed(1)}min`);
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

      // Salvar placar HT quando detectar intervalo
      if (jogo.tempo === 'Intervalo' && !estado.htPlacar) {
        estado.htPlacar = placarAtual;
        console.log(`[HT] ${jogoId} → HT: ${placarAtual}`);
      }

      // ── Detectar pênaltis/prorrogação e congelar placar do tempo normal ──
      const periodoStr = String(jogo.periodo || '').toLowerCase();
      const tempoStr    = String(jogo.tempo   || '').toLowerCase();
      const ehPenaltisOuProrrogacao =
        periodoStr.includes('penalt') || tempoStr.includes('penalt') ||
        periodoStr.includes('prorrog') || tempoStr.includes('prorrog') ||
        periodoStr.includes('acrescimo_2t_extra');
      if (ehPenaltisOuProrrogacao && !estado.placarTempoNormal) {
        estado.placarTempoNormal = estado.ultimoPlacarTempoNormalCandidato || placarAtual;
        console.log(`[PRORROGAÇÃO/PÊNALTIS] ${jogoId} → congelando placar do tempo normal: ${estado.placarTempoNormal}`);
      }
      // Enquanto ainda não entrou em prorrogação/pênaltis, guarda o último placar visto
      // (cobre o caso de a API já pular direto pro placar de pênaltis sem avisar)
      if (!ehPenaltisOuProrrogacao && !estado.placarTempoNormal) {
        estado.ultimoPlacarTempoNormalCandidato = placarAtual;
      }

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
  // CORREÇÃO: usar exclusivamente o campo periodo (evita acréscimos do 1T
  // sendo contados como 2T)
  const is1T  = (periodo === '1_tempo') && !isHT;
  const is2T  = (periodo === '2_tempo') && !isHT;

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

  // 3. GOL NO FINAL — agora só dispara em periodo === '2_tempo' real
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

  // 7b. AMBAS MARCAM xG (nova) — só vale até o final do 1º tempo
  if (pendJogo.some(p => p.strat === 'ambas_marcam_xg')) {
    if (!is2T && !isHT) {
      if (total === 0 && todosRaiosCasa.length > 0 && todosRaiosFora.length > 0)
        await alertar('ambas_marcam_xg', '0x0 + Raio dos dois times no 1T!', 'ambas_marcam_xg_live');
      else if (total === 1 && temRaio) {
        // Raio do time que ainda não marcou
        const raioDoSemGol = (golsCasa > golsFora && raioVisit) || (golsFora > golsCasa && raioMand);
        if (raioDoSemGol)
          await alertar('ambas_marcam_xg', `${placar} + Raio do time que não marcou!`, 'ambas_marcam_xg_live');
      }
    }
  }

  // 8. LAY 0x1 — 1 alerta por jogo, só até o minuto 20 (não no intervalo)
  if (pendJogo.some(p => p.strat === 'lay_0x1')) {
    if (tempo <= 20 && !isHT) {
      if (raioMand && total === 0)
        await alertar('lay_0x1', '0x0 + Raio do Mandante (até min 20)!', 'lay_0x1_live');
      else if (raioMand && golsCasa === 0 && golsFora === 1)
        await alertar('lay_0x1', '⚠️ Placar 0x1! Raio Mandante — feche e aguarde!', 'lay_0x1_live');
    }
  }

  // 9. LAY 1x0 — 1 alerta por jogo, só até o minuto 20 (não no intervalo)
  if (pendJogo.some(p => p.strat === 'lay_1x0')) {
    if (tempo <= 20 && !isHT) {
      if (raioVisit && total === 0)
        await alertar('lay_1x0', '0x0 + Raio do Visitante (até min 20)!', 'lay_1x0_live');
      else if (raioVisit && golsCasa === 1 && golsFora === 0)
        await alertar('lay_1x0', '⚠️ Placar 1x0! Raio Visitante — feche e aguarde!', 'lay_1x0_live');
    }
  }

  // 10. LAY GOLEADA VISITANTE — 1 alerta por jogo, só até o minuto 20 (não no intervalo)
  if (pendJogo.some(p => p.strat === 'lay_goleada_visit')) {
    if (tempo <= 20 && !isHT && raioMand)
      await alertar('lay_goleada_visit', 'Raio do Mandante (até min 20)!', 'lay_goleada_visit_live');
  }

  // 11. LAY GOLEADA MANDANTE — 1 alerta por jogo, só até o minuto 20 (não no intervalo)
  if (pendJogo.some(p => p.strat === 'lay_goleada_mand')) {
    if (tempo <= 20 && !isHT && raioVisit)
      await alertar('lay_goleada_mand', 'Raio do Visitante (até min 20)!', 'lay_goleada_mand_live');
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

  // LAY 0x2 MANU — 1 alerta por jogo, só até o minuto 20 (não no intervalo)
  if (pendJogo.some(p => p.strat === 'lay_0x2')) {
    if (tempo <= 20 && !isHT && golsCasa === 0 && golsFora <= 2 && raioMand)
      await alertar('lay_0x2', `Raio Mandante (até min 20) · ${placar}!`, 'lay_0x2_live');
  }

  // LAY 0x3 — 1 alerta por jogo, só até o minuto 20 (não no intervalo)
  if (pendJogo.some(p => p.strat === 'lay_0x3')) {
    if (tempo <= 20 && !isHT && golsCasa === 0 && golsFora <= 3 && raioMand)
      await alertar('lay_0x3', `Raio Mandante (até min 20) · ${placar}!`, 'lay_0x3_live');
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

  // OVER 0,5 GONZA — 2T corrigido para depender só de periodo === '2_tempo'
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

  // Se detectamos pênaltis/prorrogação, usar o placar do tempo normal congelado
  // para o cálculo de resultado. O placar real (com pênaltis) ainda é exibido no FT.
  const golsCasaApi = parseInt(jogo.gols_casa) || 0;
  const golsForaApi = parseInt(jogo.gols_fora) || 0;
  const placarFTApi = `${golsCasaApi}x${golsForaApi}`;

  let golsCasa = golsCasaApi, golsFora = golsForaApi;
  let placarParaCalculo = placarFTApi;
  if (estado.placarTempoNormal) {
    const [pc, pf] = estado.placarTempoNormal.split('x').map(Number);
    if (!isNaN(pc) && !isNaN(pf)) {
      golsCasa = pc;
      golsFora = pf;
      placarParaCalculo = estado.placarTempoNormal;
      console.log(`[FIM] ${jogoId} → placar API: ${placarFTApi} (com pênaltis/prorrogação) · usando tempo normal: ${placarParaCalculo} para cálculo`);
    }
  }
  const placarFT = placarFTApi; // exibido nas mensagens (placar real do jogo)

  // Extrair placar do HT (necessário para estratégias como over05 que dependem do HT)
  let htH = 0, htA = 0;
  if (estado.htPlacar) {
    const [ph, pa] = estado.htPlacar.split('x').map(Number);
    if (!isNaN(ph) && !isNaN(pa)) { htH = ph; htA = pa; }
  }

  const links    = linksExchanges(jogo.urls_exchanges || {});

  const pendJogo = pendentes.filter(p =>
    p.data === hoje && p.result === 'pendente' &&
    (p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`)
  );

  // Resolver pendentes — usa placarParaCalculo (tempo normal) para acerto/erro,
  // e htH/htA reais para estratégias que dependem do placar do intervalo
  for (const p of pendJogo) {
    p.final  = placarFT;
    p.ht     = estado.htPlacar || '';
    const res = calcularResultado(p.strat, golsCasa, golsFora, htH, htA);
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

    const res     = pLive?.result || calcularResultado(stratBase, golsCasa, golsFora, htH, htA);
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
  status: 'ok', version: 'server_39',
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
      placarTempoNormal: v.placarTempoNormal || null,
      alertas: Object.keys(v.msgIds || {})
    };
  }
  res.json(resumo);
});

app.post('/testar-telegram', async (req, res) => {
  await sendTelegram('✅ FUTATS Server v38 funcionando! 🎯');
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
  console.log(`FUTATS Server v38 na porta ${PORT}`);

  // Buscar jogos pré-jogo
  await buscarPreJogo();
  setInterval(buscarPreJogo, 6 * 60 * 60 * 1000);

  // Monitoramento live
  setInterval(monitorarLive, 90 * 1000);

  // Agendar: 08h card matinal · 18h resumo parcial · 00h resumo do dia anterior + card novo dia
  agendarHoraBRT(8,  0, enviarCardMatinal);
  agendarHoraBRT(18, 0, enviarResumoDia);
  agendarHoraBRT(0,  0, enviarResumoECard);

  // Avisos de inicio
  await sendTelegram(
    '🚀 <b>FUTATS Server v38 iniciado!</b>\n' +
    '✅ Fix is2T/is1T — periodo real (sem bug de acréscimos)\n' +
    '✅ Lay 0x1/1x0/0x2/0x3/Goleada — só até min 20\n' +
    '✅ Placar de pênaltis/prorrogação congelado p/ cálculo\n' +
    '✅ Nova estratégia: Ambas Marcam xG (🟤)\n' +
    '✅ Horários: 08h card · 18h resumo · 00h resumo+card'
  );

  // Enviar card e resumo imediatamente ao subir
  await enviarCardMatinal();
  await enviarResumoDia();
});
