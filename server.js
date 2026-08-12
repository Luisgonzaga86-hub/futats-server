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

// ── CONFIABILIDADE PRÉ-LIVE — ponte com o futats-prelive via rede interna
// do Railway (23/07). Busca não-bloqueante: nunca atrasa o disparo de um
// alerta. Retry espaçado (a cada CONFIABILIDADE_RETRY_MS) enquanto não achar
// — cobre o caso de o Luis analisar o jogo manualmente pelo site depois que
// o alerta live já disparou.
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;
const FUTATS_PRELIVE_INTERNAL_URL = process.env.FUTATS_PRELIVE_INTERNAL_URL || 'http://futats-server.railway.internal:8080';
const CONFIABILIDADE_RETRY_MS = 5 * 60 * 1000;

async function buscarConfiabilidadePreLive(jogo) {
  if (!INTERNAL_TOKEN) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `${FUTATS_PRELIVE_INTERNAL_URL}/interno/confiabilidade?mandante=${encodeURIComponent(jogo.mandante)}&visitante=${encodeURIComponent(jogo.visitante)}`;
    const r = await fetch(url, { headers: { 'x-internal-token': INTERNAL_TOKEN }, signal: controller.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.error('[confiabilidade] Falha ao buscar do futats-prelive:', e.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function formatarBlocoConfiabilidade(conf) {
  const linhas = [
    '🎯 Confiabilidade pré-live',
    `🎯 Favorito: ${conf.favorito || '-'}`,
    `⚽ Gols: ${conf.gols || '-'}`,
    `🔒 Placar/Lay: ${conf.lay || '-'}`,
  ];
  if (conf.layImprovavelMantidos && conf.layImprovavelMantidos.length) {
    linhas.push(`🎯 Lay Improvável (mantidos): ${conf.layImprovavelMantidos.join(' · ')}`);
  }
  if (conf.top3Placares && conf.top3Placares.length) {
    linhas.push(`🎯 Top 3 placares: ${conf.top3Placares.join(' · ')}`);
  }
  return linhas.join('\n');
}

// Busca (com retry espaçado) e, assim que encontra pela 1ª vez, re-renderiza
// TODOS os alertas já ativos desse jogo — assim o bloco fica "gravado" desde
// já, sem precisar esperar o próximo evento de placar.
async function garantirConfiabilidade(jogoId, estado, jogo) {
  if (estado.confiabilidadeBloco) return;
  if (estado.encerrado) return; // jogo já acabou, mensagens já fechadas — não vale mais a pena buscar
  const agora = Date.now();
  if (estado.confiabilidadeUltimaTentativa && (agora - estado.confiabilidadeUltimaTentativa) < CONFIABILIDADE_RETRY_MS) return;
  estado.confiabilidadeUltimaTentativa = agora;

  const conf = await buscarConfiabilidadePreLive(jogo);
  if (!conf || !conf.encontrado) {
    console.log(`[confiabilidade] ${jogoId} → não encontrado ainda (tenta de novo em até ${CONFIABILIDADE_RETRY_MS / 60000}min).`);
    return;
  }

  estado.confiabilidadeBloco = formatarBlocoConfiabilidade(conf);
  console.log(`[confiabilidade] ${jogoId} → bloco carregado.`);

  // Se o jogo JÁ terminou (processarFimDeJogo já rodou), as mensagens já
  // têm o resultado final escrito (GREEN/RED · HT/FT) — não voltar a editar
  // como se o jogo ainda estivesse rolando, senão apagaria esse resultado.
  // Nesse caso o bloco só fica guardado (não é usado nesse jogo, já é tarde).
  if (estado.encerrado) {
    console.log(`[confiabilidade] ${jogoId} → jogo já encerrado, não re-renderiza (evita sobrescrever o resultado final).`);
    return;
  }

  console.log(`[confiabilidade] ${jogoId} → re-renderizando alertas ativos.`);
  for (const [stratKey, info] of Object.entries(estado.msgIds || {})) {
    if (!info?.ids?.length) continue;
    if (info.grupo1Status) continue; // Grupo 1 recebe o bloco na próxima transição de estado
    await rerenderizarAlerta(jogo, estado, stratKey, info);
  }
  if (estado.msgConsolidada?.ids?.length && !estado.msgConsolidada.travado) {
    await rerenderizarConsolidado(jogo, estado);
  }
}

// Todos os arquivos de dados ficam dentro de data/ — assim o Volume do
// Railway pode ser montado só nessa pasta (montar direto na raiz do app
// apagaria o node_modules na primeira vez, comportamento conhecido do
// Railway com volumes vazios sobrepondo o path de montagem).
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DATA_FILE   = path.join(DATA_DIR, 'dados.json');
const PEND_FILE   = path.join(DATA_DIR, 'pendentes.json');
const ESTADO_FILE = path.join(DATA_DIR, 'estado_live.json');
const MOMENTUM_HISTORICO_FILE = path.join(DATA_DIR, 'momentum_historico.json');
// Depois de encerrado, o jogo fica esse tempo no estado_live.json (pra
// garantir que nenhum ciclo atrasado ainda vá editar mensagem dele) antes
// de ser movido pro arquivo de histórico e removido do arquivo "quente"
// (que é reescrito por inteiro a cada ciclo — sem isso, ele só cresce).
const ARQUIVAR_APOS_MS = 60 * 60 * 1000; // 1h

function lerArquivo(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function salvarArquivo(file, data) {
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
}

let dadosHist = lerArquivo(DATA_FILE, []);
let pendentes = lerArquivo(PEND_FILE, []);
let momentumHistorico = lerArquivo(MOMENTUM_HISTORICO_FILE, {});

let estadoLive = lerArquivo(ESTADO_FILE, {});
for (const k of Object.keys(estadoLive)) {
  if (estadoLive[k]) estadoLive[k].ultimaVez = Date.now();
}
if (Object.keys(estadoLive).length) {
  console.log(`[ESTADO] Restaurado estado de ${Object.keys(estadoLive).length} jogo(s) do arquivo (estado_live.json).`);
}

function dataHoje() {
  return new Date(new Date().getTime() - 3*60*60*1000).toISOString().split('T')[0];
}
function agoraBRT() {
  return new Date(new Date().getTime() - 3*60*60*1000);
}
function horaBRT() {
  return agoraBRT().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
}
function dataOffsetBRT(diasAtras) {
  const d = new Date(new Date().getTime() - 3*60*60*1000);
  d.setDate(d.getDate() - diasAtras);
  return d.toISOString().split('T')[0];
}

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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`${FUTATS_BASE}/${endpoint}`, {
      headers: { 'x-token': FUTATS_TOKEN },
      signal: controller.signal,
    });
    return await r.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

const TELEGRAM_LIMITE_CHARS = 3800;

async function enviarEmPartes(cabecalho, blocos, rodape = '') {
  const partes = [];
  let atual = cabecalho;

  for (const bloco of blocos) {
    if ((atual + bloco).length > TELEGRAM_LIMITE_CHARS && atual !== cabecalho) {
      partes.push(atual);
      atual = '';
    }
    atual += bloco;
  }
  if (atual) partes.push(atual);

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

function getIndicadores(jogo, periodo) {
  const rp = jogo.resumo_pressao?.[periodo];
  if (!rp) return { pctCasa: 0, pctFora: 0, idxCasa: 0, idxFora: 0, efCasa: 0, efFora: 0 };
  return {
    pctCasa: rp.porcentagem_pressao?.casa || 0,
    pctFora: rp.porcentagem_pressao?.fora || 0,
    idxCasa: rp.indice_pressao?.casa || 0,
    idxFora: rp.indice_pressao?.fora || 0,
    efCasa:  rp.eficiencia_pressao?.casa || 0,
    efFora:  rp.eficiencia_pressao?.fora || 0,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

function ladoOposto(lado) { return lado === 'casa' ? 'fora' : 'casa'; }

function valorMomento(jogo, minuto, lado) {
  const m = (jogo.momentum || []).find(x => x.minuto === minuto);
  if (!m) return 0;
  return (lado === 'casa' ? m.valor_casa : m.valor_fora) || 0;
}

function janelaUltimos5(jogo, ladoAlvo, minutoAtual) {
  const janela = [];
  for (let min = minutoAtual - 4; min <= minutoAtual; min++) {
    janela.push({
      minuto: min,
      alvo: valorMomento(jogo, min, ladoAlvo),
      oposto: valorMomento(jogo, min, ladoOposto(ladoAlvo)),
    });
  }
  return janela;
}

function getEficienciaPeriodoAtual(jogo, estado, lado) {
  const tempoNum = parseInt(jogo.tempo) || 0;
  let periodo = 'ult_10min';
  if (estado.passouHT && estado.minutoInicio2T != null) {
    const minutosNo2T = tempoNum - estado.minutoInicio2T;
    if (minutosNo2T >= 0 && minutosNo2T < 10) periodo = '2_tempo';
  }
  const ind = getIndicadores(jogo, periodo);
  return lado === 'casa' ? ind.efCasa : ind.efFora;
}

function checaPressaoGonza(jogo, estado, ladoAlvo, minutoAtual) {
  if (!minutoAtual || minutoAtual < 5) return null;
  const janela = janelaUltimos5(jogo, ladoAlvo, minutoAtual);
  if (!janela.every(j => j.oposto === 0)) return null;

  const media   = janela.reduce((s, j) => s + Math.abs(j.alvo), 0) / 5;
  const minutos = janela.map(j => j.minuto);
  const chutes  = (jogo.eventos || []).filter(e =>
    e.lado === ladoAlvo && minutos.includes(e.minuto) && e.tipo_evento.startsWith('chute')
  );
  const chuteGol = chutes.find(c => c.tipo_evento === 'chute_no_gol');
  const chuteQualquer = chutes[0];

  if (media >= 136 && chuteGol) {
    const efNosso = getEficienciaPeriodoAtual(jogo, estado, ladoAlvo);
    if (efNosso >= 0.17) {
      return { tipo: 'completo', media: round2(media), minutoChute: chuteGol.minuto, eficiencia: round2(efNosso) };
    }
  }
  // Pressão Gonza 2 (26/07) — mesma janela/média do completo, mas aceita
  // QUALQUER tipo de chute (não só no gol) e não exige eficiência mínima.
  if (media >= 136 && chuteQualquer) {
    return { tipo: 'gonza2', media: round2(media), minutoChute: chuteQualquer.minuto };
  }
  if (media >= 180) {
    return { tipo: 'sem_eficiencia', media: round2(media) };
  }
  return null;
}

function checaReacaoOponente(jogo, ladoOponente, minutoAtual) {
  if (!minutoAtual || minutoAtual < 5) return null;
  const janela  = janelaUltimos5(jogo, ladoOponente, minutoAtual);
  const minutos = janela.map(j => j.minuto);

  for (const j of janela) {
    if (Math.abs(j.alvo) >= 150) {
      const chute = (jogo.eventos || []).find(e =>
        e.lado === ladoOponente && e.minuto === j.minuto &&
        (e.tipo_evento === 'chute_no_gol' || e.tipo_evento === 'chute_para_fora')
      );
      if (chute) return { tipo: 'momentum_forte', minuto: j.minuto, valor: j.alvo, chute: chute.tipo_evento };
    }
  }

  const media = janela.reduce((s, j) => s + Math.abs(j.alvo), 0) / 5;
  if (media > 100) return { tipo: 'media_sustentada', media: round2(media) };

  const chutesNaJanela = (jogo.eventos || []).filter(e =>
    e.lado === ladoOponente && minutos.includes(e.minuto) && e.tipo_evento.startsWith('chute')
  );
  if (chutesNaJanela.length >= 2) return { tipo: 'dois_chutes', qtd: chutesNaJanela.length };

  return null;
}

function checaJogoAberto(jogo, minutoAtual) {
  if (!minutoAtual || minutoAtual < 2) return null;
  function ultimoPicoComChute(lado) {
    for (let min = minutoAtual; min >= Math.max(1, minutoAtual - 9); min--) {
      const valor = valorMomento(jogo, min, lado);
      if (Math.abs(valor) >= 150) {
        const temChute = (jogo.eventos || []).some(e =>
          e.lado === lado && e.minuto === min && e.tipo_evento.startsWith('chute')
        );
        if (temChute) return min;
      }
    }
    return null;
  }
  const minCasa = ultimoPicoComChute('casa');
  const minFora = ultimoPicoComChute('fora');
  if (minCasa == null || minFora == null) return null;
  if (Math.abs(minCasa - minFora) <= 2) return { minCasa, minFora };
  return null;
}

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

function calcularResultado(strat, ftH, ftA, htH = 0, htA = 0) {
  const s   = strat.replace(/_live$|_pre$/, '');
  const tot = ftH + ftA;
  switch(s) {
    case 'lay_0x1_ia':           return (ftH === 0 && ftA === 1) ? 'red' : 'green';
    case 'lay_1x0_ia':           return (ftH === 1 && ftA === 0) ? 'red' : 'green';
    case 'lay_gol_visit':        return (ftA - ftH >= 4 && ftA > ftH) ? 'red' : 'green';
    case 'lay_gol_mand':         return (ftH - ftA >= 4 && ftH > ftA) ? 'red' : 'green';
    case 'favorito_ht_gonza':
    case 'lay_away_manu':
    case 'lay_manu4':            return ftA > ftH ? 'red' : 'green';
    case 'lay_xg':                return null;
    case 'back_fav_ht':
    case 'back_gonza_xg':        return ftH > ftA ? 'green' : 'red';
    case 'over05':               return (htH === 0 && htA === 0) ? (tot > 0 ? 'green' : 'red') : 'nao_entra';
    case 'over15_ia':
    case 'felipe_over15':        return tot > 1 ? 'green' : 'red';
    case 'over05_ht':            return tot > 0 ? 'green' : 'red';
    case 'over15_ht':            return tot > 1 ? 'green' : 'red';
    case 'ambas_marcam':
    case 'am_xg':                return (ftH > 0 && ftA > 0) ? 'green' : 'red';
    case 'ambas_marcam_xg':       return (ftH > 0 && ftA > 0) ? 'green' : 'red';
    case 'gol_no_final':         return (ftH + ftA) > (htH + htA) ? 'green' : 'red';
    default:                     return tot > 0 ? 'green' : 'red';
  }
}

const STRAT_DISPLAY = {
  gol_no_final:         '🤖 Gol no Final',
  over05_ht:            '🤖 Over 0.5 HT',
  over15_ht:            '🤖 Over 1.5 HT',
  over15_ia:            '🤖 Over 1.5',
  ambas_marcam:         '🤖 Ambas Marcam',
  lay_0x1_ia:           '🤖 Lay Resultado 0x1',
  lay_1x0_ia:           '🤖 Lay Resultado 1x0',
  lay_gol_visit:        '🤖 Lay Goleada Visitante',
  lay_gol_mand:         '🤖 Lay Goleada Mandante',
  favorito_ht_gonza:    '🔵 Favorito ht Gonza',
  felipe_over15:        '🟠 Felipe Over 1.5',
  lay_away_manu:        '⚪ Lay Away Manu',
  lay_manu4:            '⚪ Lay Manu 4',
  back_gonza_xg:        '🔵 Back Gonza com xG',
  lay_xg:               '🟣 Lay xG',
  am_xg:                '🟤 AM xG',
  over05:               '🟢 Over 0,5 Gonza',
  ambas_marcam_xg:       '🟤 Ambas Marcam xG',
};

// ════════════════════════════════════════════════════════════════
// ── REGRAS_ENTRADA — tabela de decisão validada com dados reais ──
// (10/08/2026, cruzando alertas do canal + odds pré-jogo + placar
// final de centenas de jogos). Mexer aqui não muda a lógica que usa
// essa tabela, só os números/cortes.
// ════════════════════════════════════════════════════════════════
const REGRAS_ENTRADA = {
  favorito_ht_gonza: {
    corte2T: 65,               // 45'-65' = Over Limite / depois = Lay+1 zebra
    oddJustaOverLimite1T: 1.06,
    oddJustaLay1Zebra2T: 1.17,
  },
  over05: {
    oddJustaCombinado: 1.05,   // com qualquer outra estratégia junto → Over Limite
    oddJustaOverHT: 1.06,
    oddJustaOverLimiteIsolado: 1.05,
  },
  gol_no_final: {
    limiteMinuto: 65,          // só dispara até aqui
    oddJusta: 1.36,
  },
};

// Estratégias de gol que agora só disparam a partir do 2º tempo
// (min 45+) — decisão de 10/08, focando o sinal onde ele é mais forte.
const GOLS_STRATS_SO_2T = ['felipe_over15', 'ambas_marcam', 'ambas_marcam_xg', 'over15_ia'];

const IA_PARA_STRAT = {
  'Gol no Final':           'gol_no_final',
  'Over 0.5 HT':            'over05_ht',
  'Over 1.5':               'over15_ia',
  'Ambas Marcam':           'ambas_marcam',
  'Lay Resultado 0x1':      'lay_0x1_ia',
  'Lay Resultado 1x0':      'lay_1x0_ia',
  'Lay Goleada Visitante':  'lay_gol_visit',
  'Lay Goleada Mandante':   'lay_gol_mand',
};

const FILTRO_PARA_STRAT = {
  'Favorito ht Gonza':  'favorito_ht_gonza',
  'Felipe over 1.5':    'felipe_over15',
  'lay away Manu':      'lay_away_manu',
  'Lay Manu 4':         'lay_manu4',
  'back gonza com xg':  'back_gonza_xg',
  'ambas marcam xg':    'ambas_marcam_xg',
};

const ESTRAT_PARA_STRAT = {
  'Over 0,5 Gonza':   'over05',
  'Lay xg':           'lay_xg',
  'ambos xg pro':     'am_xg',
};

async function enviarCardMatinal(dataAlvo = null) {
  const hoje = dataAlvo || dataHoje();
  const [dd, mm, yyyy] = hoje.split('-').reverse();
  const pendHoje = pendentes.filter(p => p.data === hoje && p.tipo === 'pre');

  if (!pendHoje.length) {
    await sendTelegram(`📋 <b>FUTATS — ${dd}/${mm}/${yyyy}</b>\n\nNenhum jogo registrado hoje ainda.`);
    return;
  }

  const byJogo = {};
  for (const p of pendHoje) {
    const k = p.hora + '|' + p.jogo;
    if (!byJogo[k]) byJogo[k] = { hora: p.hora, jogo: p.jogo, strats: [] };
    byJogo[k].strats.push(p.strat);
  }

  const jogosOrdenados = Object.values(byJogo).sort((a, b) => a.hora.localeCompare(b.hora));

  const byHora = {};
  for (const j of jogosOrdenados) {
    if (!byHora[j.hora]) byHora[j.hora] = [];
    byHora[j.hora].push(j);
  }

  const cabecalho = `📋 <b>FUTATS — Jogos do dia ${dd}/${mm}/${yyyy}</b>\n`;

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

async function enviarResumoDia(dataAlvo = null) {
  const hoje = dataAlvo || dataHoje();
  const [dd, mm, yyyy] = hoje.split('-').reverse();
  const pendHoje = pendentes.filter(p => p.data === hoje);

  if (!pendHoje.length) {
    await sendTelegram(`📊 <b>FUTATS — Resumo ${dd}/${mm}/${yyyy}</b>\n\nNenhum registro hoje.`);
    return;
  }

  const byJogo = {};
  for (const p of pendHoje) {
    const k = p.hora + '|' + p.jogo;
    if (!byJogo[k]) byJogo[k] = { hora: p.hora, jogo: p.jogo, strats: [] };
    byJogo[k].strats.push(p);
  }

  const jogosOrdenados = Object.values(byJogo).sort((a, b) => a.hora.localeCompare(b.hora));

  let greens = 0, reds = 0, pendCount = 0;

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

async function enviarResumoECard() {
  const ontem = dataOffsetBRT(1);
  console.log(`[00H] Enviando resumo final de ${ontem} + card do novo dia`);
  await enviarResumoDia(ontem);
  await enviarCardMatinal();
}

async function resolverPendentesAntigos() {
  const hoje = dataHoje();
  const antigos = pendentes.filter(p => p.result === 'pendente' && p.data < hoje);
  if (!antigos.length) return;
  console.log(`[ANTIGOS] ${antigos.length} pendentes de dias anteriores encontrados`);

  let jogosLive = [];
  try {
    const rLive = await futatsGet('api-games-live');
    jogosLive = rLive[0]?.eventos || [];
  } catch(e) {}

  const jogosLiveIds = new Set(jogosLive.map(j => `${j.mandante}_${j.visitante}`));

  let resolvidos = 0;
  for (const p of antigos) {
    const jogoId = `${p.home}_${p.away}`;
    if (jogosLiveIds.has(jogoId)) continue;
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

async function buscarPreJogo() {
  console.log('[PRÉ] Buscando jogos das APIs do futats...');

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

async function monitorarLive() {
  try {
    const rLive   = await futatsGet('api-games-live');
    const jogosLive = rLive[0]?.eventos || [];
    const agora   = Date.now();
    const hoje    = dataHoje();
    const idsLive = new Set(jogosLive.map(j => j.mandante + '_' + j.visitante));

    for (const [jogoId, estado] of Object.entries(estadoLive)) {
      if (!idsLive.has(jogoId) && !estado.encerrado) {
        const minSemDados = (agora - estado.ultimaVez) / 60000;
        const ultimoMin = estado.ultimoMinuto || 0;
        if (minSemDados >= 3 && ultimoMin >= 90) {
          estado.encerrado = true;
          estado.encerradoEm = agora;
          console.log(`[FIM AUTO] ${jogoId} · último min: ${ultimoMin} · sem dados há ${minSemDados.toFixed(1)}min`);
          await processarFimDeJogo(jogoId, estado, hoje);
        }
        else if (minSemDados >= 10) {
          estado.encerrado = true;
          estado.encerradoEm = agora;
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
          msgIds: {},
          ultimoPlacar: null,
        };
      }
      const estado = estadoLive[jogoId];
      estado.ultimaVez = agora;
      estado.jogo = jogo;

      // Busca a confiabilidade pré-live em paralelo, sem bloquear os alertas
      // (fire-and-forget) — assim que chega, re-renderiza os alertas ativos.
      garantirConfiabilidade(jogoId, estado, jogo).catch((e) =>
        console.error(`[confiabilidade] Erro inesperado em ${jogoId}:`, e.message)
      );

      for (const m of (jogo.momentum || [])) {
        if (!estado.momentum.find(x => x.minuto === m.minuto)) estado.momentum.push(m);
      }
      for (const ev of (jogo.eventos || [])) {
        const jaExiste = estado.eventos.find(x =>
          x.minuto === ev.minuto && x.tipo_evento === ev.tipo_evento && x.lado === ev.lado
        );
        if (!jaExiste) estado.eventos.push(ev);
      }
      const tempoAtualNum = parseInt(jogo.tempo) || estado.ultimoMinuto || 0;
      if (jogo.tempo !== 'Intervalo' && tempoAtualNum > 0) {
        estado.ultimoMinuto = tempoAtualNum;
      }

      if (jogo.tempo === 'Encerrado' && !estado.encerrado) {
        estado.encerrado = true;
        estado.encerradoEm = agora;
        await processarFimDeJogo(jogoId, estado, hoje);
        continue;
      }

      const placarAtual = `${parseInt(jogo.gols_casa)||0}x${parseInt(jogo.gols_fora)||0}`;
      if (estado.ultimoPlacar && estado.ultimoPlacar !== placarAtual) {
        await atualizarPlacarNasMensagens(jogo, estado, placarAtual, hoje);
      }
      estado.ultimoPlacar = placarAtual;

      if (jogo.tempo === 'Intervalo' && !estado.htPlacar) {
        const htCasaApi = parseInt(jogo.gols_casa_ht);
        const htForaApi = parseInt(jogo.gols_fora_ht);
        estado.htPlacar = (!isNaN(htCasaApi) && !isNaN(htForaApi))
          ? `${htCasaApi}x${htForaApi}`
          : placarAtual;
        estado.passouHT = true;
        console.log(`[HT] ${jogoId} → HT: ${estado.htPlacar}`);
      }
      if (!estado.passouHT && (parseInt(jogo.tempo) || 0) > 60) {
        estado.passouHT = true;
        console.log(`[HT-FORÇADO] ${jogoId} → API nunca reportou Intervalo, forçando passouHT no minuto ${jogo.tempo}`);
        if (!estado.htPlacar) {
          const htCasaApi = parseInt(jogo.gols_casa_ht);
          const htForaApi = parseInt(jogo.gols_fora_ht);
          estado.htPlacar = (!isNaN(htCasaApi) && !isNaN(htForaApi))
            ? `${htCasaApi}x${htForaApi}`
            : null;
        }
      }

      if (estado.passouHT && estado.minutoInicio2T == null && jogo.tempo !== 'Intervalo') {
        const tNumInicio2T = parseInt(jogo.tempo) || 0;
        if (tNumInicio2T > 0) estado.minutoInicio2T = tNumInicio2T;
      }

      const tempoStr    = String(jogo.tempo   || '').toLowerCase();
      const ehPenaltisOuProrrogacao =
        tempoStr.includes('penalt') || tempoStr.includes('prorrog');
      if (ehPenaltisOuProrrogacao && !estado.placarTempoNormal) {
        estado.placarTempoNormal = estado.ultimoPlacarTempoNormalCandidato || placarAtual;
        console.log(`[PRORROGAÇÃO/PÊNALTIS] ${jogoId} → congelando placar do tempo normal: ${estado.placarTempoNormal}`);
      }
      if (!ehPenaltisOuProrrogacao && !estado.placarTempoNormal) {
        estado.ultimoPlacarTempoNormalCandidato = placarAtual;
      }

      await processarAlertasLive(jogo, estado, jogoId, hoje);
      await processarIndicadoresProprios(jogo, estado, jogoId, hoje);
      await processarEstadoGrupo1(jogo, estado, jogoId, hoje);
    }

    arquivarJogosEncerrados();
    salvarArquivo(ESTADO_FILE, estadoLive);
  } catch(e) {
    console.error('[LIVE] Erro:', e.message);
  }
}

// Move pro arquivo de histórico (e remove do estado_live.json) qualquer
// jogo encerrado há mais de ARQUIVAR_APOS_MS — assim o arquivo "quente"
// (reescrito por inteiro a cada ciclo) não fica acumulando pra sempre.
// Os dados brutos (momentum/eventos) ficam preservados no histórico, só
// pra dar de reabrir o gráfico depois.
function arquivarJogosEncerrados() {
  const agora = Date.now();
  let arquivados = 0;
  for (const [jogoId, estado] of Object.entries(estadoLive)) {
    if (!estado.encerrado) continue;
    const encerradoEm = estado.encerradoEm || estado.ultimaVez || 0;
    if ((agora - encerradoEm) < ARQUIVAR_APOS_MS) continue;

    momentumHistorico[jogoId] = momentumHistorico[jogoId] || [];
    // Guarda como lista (não sobrescreve) — cobre o caso raro de dois jogos
    // diferentes do mesmo confronto (ida/volta, edições diferentes do ano).
    momentumHistorico[jogoId].push({
      jogo: estado.jogo,
      momentum: estado.momentum,
      eventos: estado.eventos,
      htPlacar: estado.htPlacar || null,
      ultimoPlacar: estado.ultimoPlacar || null,
      encerradoEm,
    });
    delete estadoLive[jogoId];
    arquivados++;
  }
  if (arquivados > 0) {
    salvarArquivo(MOMENTUM_HISTORICO_FILE, momentumHistorico);
    console.log(`[ARQUIVO] ${arquivados} jogo(s) movido(s) pro histórico (estado_live.json aliviado).`);
  }
}

function montarMsgAlerta(display, jogo, tempo, placarAlerta, placarAtual, links, statusLinha = null) {
  const fixo    = `${display}\n⚽ <b>${jogo.mandante} x ${jogo.visitante}</b>\n⏱ ${tempo}' · 📊 ${placarAlerta}`;
  const sep     = '\n─────────────────';
  const editavel = statusLinha
    ? `\n${statusLinha}`
    : `\n📊 Placar atual: ${placarAtual}`;
  return fixo + sep + editavel + links;
}

// ════════════════════════════════════════════════════════════════
// ── MOTOR ÚNICO DE INDICADORES (26/07) ───────────────────────────
// ════════════════════════════════════════════════════════════════
// A partir de 26/07, TODA estratégia (Seleção IA, Filtros, Estratégias-
// bolinha, Grupo 1) dispara SÓ por estes 4 indicadores próprios — raio
// do futats.com e os índices de resumo_pressao deixaram de ser gatilho
// de entrada (continuam existindo só como dado bruto em getIndicadores,
// usado apenas pela checagem de eficiência do Pressão Gonza "completo").
//
//   • Pressão Gonza    — janela limpa, média≥136, chute NO GOL, eficiência≥0.17
//   • Pressão Gonza 2  — mesma janela/média, QUALQUER chute, sem exigir eficiência
//   • Pressão sem ef.  — janela limpa, média≥180 (observação, não conta como entrada)
//   • Jogo Aberto      — pico≥150 dos dois lados + chute, perto no tempo
//
// Cada alerta guarda os minutos de cada indicador por tempo (1T/2T) em
// info.indicadores — 1 linha por indicador por tempo, acumulando minutos
// na mesma linha se bater de novo (nunca duplica, nunca perde histórico).
// ════════════════════════════════════════════════════════════════

const INDICADOR_LABEL = {
  gonza:  '🟣 Pressão Gonza',
  gonza2: '🟣 Pressão Gonza 2',
  semEf:  '🟣 Pressão sem eficiência',
  aberto: '🟠 Jogo Aberto',
};
const ORDEM_INDICADORES = ['gonza', 'gonza2', 'semEf', 'aberto'];

function novoRegistroIndicadores() {
  const r = {};
  for (const tipo of ORDEM_INDICADORES) r[tipo] = { '1T': [], '2T': [] };
  return r;
}

// Registra uma ocorrência (minuto, ou "min-min" no caso de Jogo Aberto)
// na linha certa — nunca duplica o mesmo valor. Devolve true se era nova
// (útil pra saber se precisa re-renderizar a mensagem).
function registrarIndicador(info, tipo, periodoLabel, valor) {
  info.indicadores = info.indicadores || novoRegistroIndicadores();
  const lista = info.indicadores[tipo][periodoLabel];
  if (!lista.includes(valor)) { lista.push(valor); return true; }
  return false;
}

function montarLinhasIndicadores(info) {
  if (!info.indicadores) return [];
  const linhas = [];
  for (const tipo of ORDEM_INDICADORES) {
    for (const periodo of ['1T', '2T']) {
      const vals = info.indicadores[tipo][periodo];
      if (vals && vals.length) {
        linhas.push(`${INDICADOR_LABEL[tipo]} (${periodo}) — min ${vals.join(', ')}`);
      }
    }
  }
  return linhas;
}

// Filtro de placar — evita disparar mercado que já não faz mais sentido
// dado o placar atual (ex: Over 1.5 quando já saíram 2+ gols).
function placarValidoParaGols(stratKey, golsCasa, golsFora) {
  const total = golsCasa + golsFora;
  switch (stratKey) {
    case 'over15_ia':
    case 'felipe_over15':
      return total <= 1;
    case 'ambas_marcam':
    case 'ambas_marcam_xg':
    case 'am_xg':
      return !(golsCasa > 0 && golsFora > 0); // Ambas Marcam ainda não ocorreu
    case 'over05':
      return total <= 3;
    default:
      return true; // gol_no_final, over05_ht — sem filtro extra de placar
  }
}

// Monta o corpo completo (indicadores + aviso de saída + placar atual +
// confiabilidade) — usado tanto no disparo inicial quanto em toda edição
// posterior, pra nunca haver dois formatos diferentes de montagem.
function montarCorpoAlerta(info, estado, placarAtual, tempoDisplay) {
  const partes = [...montarLinhasIndicadores(info)];
  if (info.avisoSaida) partes.push(info.avisoSaida);
  partes.push(`📊 Placar atual: ${placarAtual} · ${tempoDisplay}'`);
  if (estado.confiabilidadeBloco) partes.push(estado.confiabilidadeBloco);
  return partes.join('\n');
}

// ════════════════════════════════════════════════════════════════
// ── ALERTA CONSOLIDADO (10/08) — 1 mensagem por jogo, agrupando  ──
// ── todas as estratégias próprias que dispararem juntas, com a   ──
// ── entrada sugerida calculada a partir das regras validadas.    ──
// ════════════════════════════════════════════════════════════════
// gol_no_final NUNCA entra aqui — sempre mensagem própria (ver mais
// abaixo, continua usando dispararAlertaIndicador/rerenderizarAlerta).
const STRATS_FORA_DO_CONSOLIDADO = ['gol_no_final'];

function golsDoEstado(estado) {
  return (estado.eventos || [])
    .filter(e => e.tipo_evento === 'gol')
    .sort((a, b) => a.minuto - b.minuto);
}

function ladoZebra(jogo) { return ladoOposto(getFavorito(jogo)); }

function calcularAlvoLayPlacar(placarBase, zebraLado, incremento) {
  const [gc, gf] = placarBase.split('x').map(Number);
  if (zebraLado === 'casa') return `${gc + incremento}x${gf}`;
  return `${gc}x${gf + incremento}`;
}

// CASO1/2/3 do manual do Over 0,5 Gonza sozinho (sem nenhuma outra
// estratégia confirmando junto).
function determinarEntradaOver05Isolado(jogo, placarBase, tempoNum) {
  const [gc, gf] = placarBase.split('x').map(Number);
  const favorito = getFavorito(jogo);
  const total = gc + gf;

  if (total === 0) {
    if (tempoNum < 20) {
      return { tipo: 'over_ht_recuperacao', texto: 'Over HT (se não sair, Lay 1x0/0x1 zebra)', placarBase, oddJusta: REGRAS_ENTRADA.over05.oddJustaOverHT };
    }
    return { tipo: 'over_limite', texto: 'Over Limite', placarBase, oddJusta: REGRAS_ENTRADA.over05.oddJustaOverLimiteIsolado };
  }

  if (total === 1) {
    const lider = gc === 1 ? 'casa' : 'fora';
    const liderEhFavorito = lider === favorito;
    if (!liderEhFavorito) {
      if (lider === 'fora') return { tipo: 'lay_placar_fixo', texto: 'Lay 0x2', alvoLay: '0x2', placarBase };
      return { tipo: 'over_limite', texto: 'Over Limite', placarBase };
    }
    if (lider === 'casa') return { tipo: 'lay_placar_fixo', texto: 'Lay 1x1', alvoLay: '1x1', placarBase };
    return { tipo: 'over_limite', texto: 'Over Limite', placarBase };
  }

  return { tipo: 'over_limite', texto: 'Over Limite', placarBase };
}

// Estratégias de lado que seguem a mesma regra Lay[placar+N zebra]
// que o Favorito ht Gonza (mesma família de mercado).
const LADO_MESMA_REGRA_FAVORITO = ['lay_away_manu', 'lay_manu4', 'back_gonza_xg', 'lay_gol_mand', 'lay_gol_visit'];

// Decide qual entrada sugerir dado o conjunto de estratégias ativas no
// alerta consolidado. `estrategias` = [{stratKey, tempoNum, placarAlerta}].
function determinarEntradaSugerida(jogo, estrategias) {
  const keys = estrategias.map(e => e.stratKey);
  const temFavorito = keys.includes('favorito_ht_gonza');
  const temOver = keys.includes('over05');
  const outrasLado = keys.some(k => LADO_MESMA_REGRA_FAVORITO.includes(k));

  const maisTardio = estrategias.reduce((a, b) => (b.tempoNum > a.tempoNum ? b : a));
  const tempoNum = maisTardio.tempoNum;
  const placarBase = maisTardio.placarAlerta;
  const is1T = tempoNum < 45;
  const zebra = ladoZebra(jogo);

  // Over 0,5 Gonza + qualquer outra estratégia junto → Over Limite
  if (temOver && estrategias.length > 1) {
    return { tipo: 'over_limite', texto: 'Over Limite', placarBase, oddJusta: REGRAS_ENTRADA.over05.oddJustaCombinado };
  }

  // Favorito ht Gonza (ou lado da mesma família), sem Over 0,5 Gonza junto
  if (temFavorito || outrasLado) {
    if (is1T) {
      const alvoLay = calcularAlvoLayPlacar(placarBase, zebra, 2);
      return {
        tipo: 'duas_opcoes_1T', texto: `Lay ${alvoLay}  ou  Over Limite`,
        alvoLay, placarBase, oddJusta: REGRAS_ENTRADA.favorito_ht_gonza.oddJustaOverLimite1T,
      };
    }
    if (tempoNum <= REGRAS_ENTRADA.favorito_ht_gonza.corte2T) {
      return { tipo: 'over_limite', texto: 'Over Limite', placarBase };
    }
    const alvoLay = calcularAlvoLayPlacar(placarBase, zebra, 1);
    return {
      tipo: 'lay_placar', texto: `Lay ${alvoLay}`, alvoLay, placarBase,
      oddJusta: REGRAS_ENTRADA.favorito_ht_gonza.oddJustaLay1Zebra2T,
    };
  }

  // Só Over 0,5 Gonza, sozinho — CASO1/2/3 (com Lay) só valem no 1T;
  // no 2T é sempre Over Limite (11/08, corrigindo bug: regra de Lay
  // estava vazando pro 2T sem querer).
  if (temOver) {
    if (!is1T) return { tipo: 'over_limite', texto: 'Over Limite', placarBase, oddJusta: REGRAS_ENTRADA.over05.oddJustaOverLimiteIsolado };
    return determinarEntradaOver05Isolado(jogo, placarBase, tempoNum);
  }

  return null; // nenhuma estratégia com regra de entrada validada
}

// Verifica se a entrada sugerida já bateu green com os gols atuais do
// jogo, e acha o minuto do gol específico que confirmou.
function checarGreenConsolidado(jogo, estado, entradaSugerida) {
  if (!entradaSugerida) return { green: false };
  const golsCasa = parseInt(jogo.gols_casa) || 0;
  const golsFora = parseInt(jogo.gols_fora) || 0;
  const gols = golsDoEstado(estado);
  const [baseCasa, baseFora] = (entradaSugerida.placarBase || '0x0').split('x').map(Number);

  if (['over_limite', 'duas_opcoes_1T', 'over_ht_recuperacao'].includes(entradaSugerida.tipo)) {
    const totalBase = baseCasa + baseFora;
    if ((golsCasa + golsFora) > totalBase) {
      const golQueDecide = gols[totalBase]; // (totalBase+1)-ésimo gol cronológico do jogo
      return { green: true, minutoGreen: golQueDecide ? golQueDecide.minuto : null };
    }
    return { green: false };
  }

  if (['lay_placar', 'lay_placar_fixo'].includes(entradaSugerida.tipo)) {
    const [alvoCasa, alvoFora] = entradaSugerida.alvoLay.split('x').map(Number);
    if (golsCasa > alvoCasa || golsFora > alvoFora) {
      const ladoQueEstourou = golsCasa > alvoCasa ? 'casa' : 'fora';
      const alvoDesseLado = ladoQueEstourou === 'casa' ? alvoCasa : alvoFora;
      const golsDesseLado = gols.filter(g => g.lado === ladoQueEstourou);
      const golQueDecide = golsDesseLado[alvoDesseLado]; // gol nº (alvo+1) desse lado
      return { green: true, minutoGreen: golQueDecide ? golQueDecide.minuto : null };
    }
    if (jogo.tempo === 'Encerrado' && !(golsCasa === alvoCasa && golsFora === alvoFora)) {
      return { green: true, minutoGreen: null };
    }
    return { green: false };
  }

  return { green: false };
}

function montarLinhaEntradaSugerida(info) {
  if (!info.entradaSugerida) return '';
  let linha = `➜ ENTRAR: ${info.entradaSugerida.texto}`;
  if (info.entradaGreen) {
    linha += `\n✅ GREEN confirmado` + (info.entradaMinutoGreen ? ` — gol aos ${info.entradaMinutoGreen}'` : '');
  }
  return linha;
}

// Monta o texto completo do alerta consolidado (lista de estratégias
// ativas + indicadores + entrada sugerida + placar).
function montarMsgConsolidada(jogo, estado, msgCons, placarAtual, tempoDisplay) {
  const ROTULO_GRUPO1 = {
    atencao: ' — ⚠️ atenção (contra na frente)',
    reacao: ' — 🔄 reação confirmada',
    red: ' — ❌ sem reação',
  };
  const linhasEstrategias = msgCons.estrategias.map(e => {
    const display = STRAT_DISPLAY[e.stratKey] || e.stratKey;
    const statusTxt = ROTULO_GRUPO1[e.grupo1Status] || '';
    return `  ${display} (${e.tempoNum}' · ${e.placarAlerta})${statusTxt}`;
  }).join('\n');

  const fixo = `⚽ <b>${jogo.mandante} x ${jogo.visitante}</b>\n⏱ Alertas ativos:\n${linhasEstrategias}`;
  const sep = '\n─────────────────';

  const partes = [...montarLinhasIndicadores(msgCons)];
  if (msgCons.avisoSaida) partes.push(msgCons.avisoSaida);
  const linhaEntrada = montarLinhaEntradaSugerida(msgCons);
  if (linhaEntrada) partes.push(linhaEntrada);
  partes.push(`📊 Placar atual: ${placarAtual} · ${tempoDisplay}'`);
  if (estado.confiabilidadeBloco) partes.push(estado.confiabilidadeBloco);

  const links = linksExchanges(jogo.urls_exchanges || {});
  return fixo + sep + '\n' + partes.join('\n') + links;
}

// Chamado sempre que uma estratégia própria dispara (nova, ou já com o
// jogo tendo alerta consolidado ativo). Cria a mensagem se não existir;
// se existir e ainda não travou (green), adiciona a estratégia e
// recalcula a entrada sugerida; se já travou, devolve false (quem
// chamou deve então abrir uma mensagem NOVA em vez desta).
async function dispararOuAtualizarConsolidado(jogo, estado, stratKey, tempoNum, placarAlerta, opcoes = {}) {
  estado.msgConsolidada = estado.msgConsolidada || null;
  const cons = estado.msgConsolidada;

  if (cons && cons.travado) return false; // já fechou — quem chamou abre mensagem nova

  const tempoDisplay = jogo.tempo === 'Intervalo' ? 'HT' : tempoNum;
  const placarAtual = `${parseInt(jogo.gols_casa)||0}x${parseInt(jogo.gols_fora)||0}`;
  const periodoAtual = tempoNum < 45 ? '1T' : '2T';

  if (!cons) {
    estado.msgConsolidada = {
      ids: null,
      estrategias: [{ stratKey, tempoNum, placarAlerta }],
      indicadores: novoRegistroIndicadores(),
      avisoSaida: null,
      semEfAtivoPeriodo: {},
      travado: false,
    };
  } else {
    if (!cons.estrategias.some(e => e.stratKey === stratKey)) {
      cons.estrategias.push({ stratKey, tempoNum, placarAlerta });
    }
  }
  const msgCons = estado.msgConsolidada;
  msgCons.__tempoAtualParaSemEf = tempoNum;
  msgCons.__jogoParaRegistro = jogo;
  if (opcoes.tipoIndicador) {
    registrarIndicador(msgCons, opcoes.tipoIndicador, periodoAtual, opcoes.valorIndicador);
  }
  if (opcoes.entradaReal) msgCons.entradaConfirmada = true;
  msgCons.entradaSugerida = determinarEntradaSugerida(jogo, msgCons.estrategias);
  const gr = checarGreenConsolidado(jogo, estado, msgCons.entradaSugerida);
  msgCons.entradaGreen = gr.green;
  msgCons.entradaMinutoGreen = gr.minutoGreen;
  if (gr.green) msgCons.travado = true;

  const texto = montarMsgConsolidada(jogo, estado, msgCons, placarAtual, tempoDisplay);

  if (!msgCons.ids) {
    msgCons.ids = await sendTelegram(texto);
  } else {
    await editTelegram(msgCons.ids, texto);
  }

  if (opcoes.entradaReal) {
    const pendLive = registrarPendente({ ...jogo }, `${stratKey}_live`, 'live');
    pendLive.condicao = opcoes.tipoIndicador || null;
    pendLive.msgIds = msgCons.ids;
    salvarArquivo(PEND_FILE, pendentes);
  }
  return true;
}

// Re-renderiza o alerta consolidado quando algo muda (placar, indicador
// novo) sem adicionar estratégia nova.
async function rerenderizarConsolidado(jogo, estado) {
  const msgCons = estado.msgConsolidada;
  if (!msgCons || !msgCons.ids) return;
  if (msgCons.travado) return; // já fechou, não mexe mais

  const tempoNum = parseInt(jogo.tempo) || estado.ultimoMinuto || 0;
  const tempoDisplay = jogo.tempo === 'Intervalo' ? 'HT' : tempoNum;
  const placarAtual = `${parseInt(jogo.gols_casa)||0}x${parseInt(jogo.gols_fora)||0}`;

  msgCons.entradaSugerida = determinarEntradaSugerida(jogo, msgCons.estrategias);
  const gr = checarGreenConsolidado(jogo, estado, msgCons.entradaSugerida);
  msgCons.entradaGreen = gr.green;
  msgCons.entradaMinutoGreen = gr.minutoGreen;
  if (gr.green) msgCons.travado = true;

  const texto = montarMsgConsolidada(jogo, estado, msgCons, placarAtual, tempoDisplay);
  await editTelegram(msgCons.ids, texto);
}

// Dispara o alerta inicial de uma estratégia (só se ainda não tiver sido
// alertada). tipoIndicador/periodo/valor = o indicador que disparou.
async function dispararAlertaIndicador(jogo, estado, stratKey, tipoIndicador, periodo, valor, opcoes = {}) {
  if (estado.msgIds[stratKey]) return false;

  const tempoNum = parseInt(jogo.tempo) || estado.ultimoMinuto || 0;
  const tempoDisplay = jogo.tempo === 'Intervalo' ? 'HT' : tempoNum;
  const golsCasa = parseInt(jogo.gols_casa) || 0, golsFora = parseInt(jogo.gols_fora) || 0;
  const placar = `${golsCasa}x${golsFora}`;
  const links = linksExchanges(jogo.urls_exchanges || {});
  const display = STRAT_DISPLAY[stratKey] || stratKey;

  const indicadores = novoRegistroIndicadores();
  indicadores[tipoIndicador][periodo].push(valor);
  const infoTemp = { indicadores, avisoSaida: null };

  let corpo = montarCorpoAlerta(infoTemp, estado, placar, tempoDisplay);
  if (opcoes.entradaEspecialTexto) {
    corpo = `➜ ENTRAR: ${opcoes.entradaEspecialTexto}\n${corpo}`;
  }
  const texto = montarMsgAlerta(display, jogo, tempoDisplay, placar, placar, links, corpo);
  const ids = await sendTelegram(texto);

  estado.msgIds[stratKey] = {
    ids, placarAlerta: placar, tempoAlerta: tempoDisplay, stratKey,
    indicadores, semEfAtivoPeriodo: {},
    ladoAlvo: opcoes.ladoAlvo || null,
    entradaConfirmada: !!opcoes.entradaReal,
  };

  if (opcoes.entradaReal) {
    const pendLive = registrarPendente({ ...jogo }, `${stratKey}_live`, 'live');
    pendLive.condicao = tipoIndicador;
    pendLive.msgIds = ids;
    salvarArquivo(PEND_FILE, pendentes);
  }
  return true;
}

// Reconstrói e reedita a mensagem de um alerta JÁ ativo — chamado sempre
// que algo novo entra (indicador, placar, confiabilidade, aviso de saída).
async function rerenderizarAlerta(jogo, estado, stratKey, info) {
  const tempoNum = parseInt(jogo.tempo) || estado.ultimoMinuto || 0;
  const tempoDisplay = jogo.tempo === 'Intervalo' ? 'HT' : tempoNum;
  const golsCasa = parseInt(jogo.gols_casa) || 0, golsFora = parseInt(jogo.gols_fora) || 0;
  const placarAtual = `${golsCasa}x${golsFora}`;
  const links = linksExchanges(jogo.urls_exchanges || {});
  const display = STRAT_DISPLAY[stratKey] || stratKey;

  const corpo = montarCorpoAlerta(info, estado, placarAtual, tempoDisplay);
  const texto = montarMsgAlerta(display, jogo, info.tempoAlerta, info.placarAlerta, `${placarAtual} · ${tempoDisplay}'`, links, corpo);
  await editTelegram(info.ids, texto);
}

// Re-renderiza todo alerta ativo de um jogo quando o placar muda (chamado
// pelo monitorarLive) — pula os do Grupo 1, que têm sua própria máquina de
// estados e já incluem os indicadores nas próprias mensagens.
async function atualizarPlacarNasMensagens(jogo, estado, placarAtual, hoje) {
  for (const [stratKey, info] of Object.entries(estado.msgIds || {})) {
    if (!info?.ids?.length) continue;
    if (info.grupo1Status) continue;
    await rerenderizarAlerta(jogo, estado, stratKey, info);
  }
  if (estado.msgConsolidada?.ids?.length && !estado.msgConsolidada.travado) {
    await rerenderizarConsolidado(jogo, estado);
  }
}

const LADO_STRATS_PROPRIOS = [
  'favorito_ht_gonza', 'lay_away_manu', 'lay_manu4', 'back_gonza_xg',
  'lay_xg',
  'lay_0x1_ia', 'lay_1x0_ia',
  'lay_gol_visit', 'lay_gol_mand',
];

// Estas 6 só existem (por definição) até o minuto 20 — entrada por
// fragilidade bem no início do jogo. Depois do min 20, não abre alerta
// NOVO, mas se já foi aberto, continua reconhecendo indicador novo.
const LADO_STRATS_LIMITE_MIN20 = [
  'lay_0x1_ia', 'lay_1x0_ia', 'lay_gol_visit', 'lay_gol_mand',
];

const GOLS_STRATS_PROPRIOS = [
  'over05', 'over15_ia', 'ambas_marcam', 'ambas_marcam_xg',
  'am_xg', 'felipe_over15', 'gol_no_final', 'over05_ht',
];

function periodoValidoParaGols(stratKey, is1T, is2T, tempoNum) {
  if (stratKey === 'over05_ht')   return is1T;
  if (stratKey === 'gol_no_final') return is2T && tempoNum <= REGRAS_ENTRADA.gol_no_final.limiteMinuto;
  if (GOLS_STRATS_SO_2T.includes(stratKey)) return false; // essas 4 têm fluxo próprio (ver processarGolsMin45)
  return true;
}

// ── GOLS_STRATS_SO_2T (Felipe Over1.5, Ambas Marcam, Ambas Marcam xG,
// Over 1.5) — 11/08: o padrão de momentum pode ser detectado a qualquer
// momento do 1T, mas o ALERTA só dispara exatamente quando o jogo chega
// no minuto 45, olhando o placar naquele instante: 0x0 → sugere Over 0,5
// (jogo todo); 1 gol no total → sugere Over 1,5 (jogo todo); 2+ gols →
// descarta de vez, nunca dispara nesse jogo pra essa estratégia.
async function processarGolsMin45(jogo, estado, pendJogo, tempoNum, golsCasa, golsFora) {
  estado.padraoGols2T = estado.padraoGols2T || {};
  estado.min45Avaliado = estado.min45Avaliado || {};
  const favorito = getFavorito(jogo);

  for (const stratKey of GOLS_STRATS_SO_2T) {
    if (!pendJogo.some(p => p.strat === stratKey)) continue;
    if (estado.min45Avaliado[stratKey]) continue; // já decidiu (disparou ou descartou)

    // Detecta o padrão (pode acontecer em qualquer minuto do 1T)
    if (!estado.padraoGols2T[stratKey] && tempoNum < 45) {
      const pgFav = checaPressaoGonza(jogo, estado, favorito, tempoNum);
      const ja = checaJogoAberto(jogo, tempoNum);
      let tipoIndicador = null, valor = null;
      if (pgFav && pgFav.tipo === 'completo') { tipoIndicador = 'gonza'; valor = pgFav.minutoChute; }
      else if (pgFav && pgFav.tipo === 'gonza2') { tipoIndicador = 'gonza2'; valor = pgFav.minutoChute; }
      else if (ja) { tipoIndicador = 'aberto'; valor = `${ja.minCasa}-${ja.minFora}`; }
      if (tipoIndicador) estado.padraoGols2T[stratKey] = { tipoIndicador, valor };
    }

    // Chegou no minuto 45 (ou passou direto pro intervalo) → decide agora
    if (tempoNum >= 45) {
      estado.min45Avaliado[stratKey] = true;
      const padrao = estado.padraoGols2T[stratKey];
      const totalGols = golsCasa + golsFora;
      if (padrao && totalGols <= 1) {
        estado.stratsDisparadas = estado.stratsDisparadas || {};
        estado.stratsDisparadas[stratKey] = true;
        const entradaTexto = totalGols === 0 ? 'Over 0,5 (jogo todo)' : 'Over 1,5 (jogo todo)';
        await dispararAlertaIndicador(jogo, estado, stratKey, padrao.tipoIndicador, '1T', padrao.valor, {
          entradaReal: true, entradaEspecialTexto: entradaTexto,
        });
      }
      // se não tinha padrão registrado, ou já tinha 2+ gols → descarta, sem disparar
    }
  }
}

function getLadoAlvoEstrategia(stratKey, jogo, hoje, pendJogo) {
  switch (stratKey) {
    case 'favorito_ht_gonza':
    case 'lay_away_manu':
    case 'lay_manu4':
    case 'back_gonza_xg':
    case 'lay_0x1_ia':
    case 'lay_gol_visit':
      return 'casa';
    case 'lay_1x0_ia':
    case 'lay_gol_mand':
      return 'fora';
    case 'lay_xg': {
      const p = (pendJogo || []).find(x => x.strat === 'lay_xg');
      return p?.lay_team === 'home' ? 'casa' : 'fora';
    }
    default:
      return null;
  }
}

// Checa aviso de saída (reação do oponente / cartão vermelho) — só faz
// sentido pra quem tem lado definido, e só dispara 1x por jogo.
function checarAvisoSaida(jogo, info, ladoAlvo, tempoNum) {
  if (!ladoAlvo || info.avisoSaida) return false;
  const ladoOp = ladoOposto(ladoAlvo);
  const reacaoOp = checaReacaoOponente(jogo, ladoOp, tempoNum);
  if (reacaoOp) {
    let descricao;
    if (reacaoOp.tipo === 'momentum_forte') descricao = `momentum ${reacaoOp.valor} + ${reacaoOp.chute === 'chute_no_gol' ? 'chute no gol' : 'chute pra fora'} (min ${reacaoOp.minuto})`;
    else if (reacaoOp.tipo === 'media_sustentada') descricao = `média ${reacaoOp.media} sustentada nos últ. 5min`;
    else descricao = `${reacaoOp.qtd} chutes nos últ. 5min`;
    info.avisoSaida = `⚠️ Oponente reagiu — ${descricao}\n⚠️ Considerar proteção/saída`;
    return true;
  }
  const vermelho = (jogo.eventos || []).find(e => e.tipo_evento === 'cartao_vermelho' && e.lado === ladoAlvo);
  if (vermelho) {
    info.avisoSaida = `🔴 Cartão vermelho nosso (min ${vermelho.minuto})\n⚠️ Saída recomendada`;
    return true;
  }
  return false;
}

// Registra na estrutura info um resultado de checaPressaoGonza (se veio
// completo/gonza2, conta como entrada real; sem_eficiencia é só observação
// até que apareça completo/gonza2/aberto de verdade). Devolve true se algo
// mudou (precisa re-renderizar).
function registrarPressaoGonza(info, pg, periodo, stratKey) {
  if (!pg) {
    info.semEfAtivoPeriodo = info.semEfAtivoPeriodo || {};
    info.semEfAtivoPeriodo[periodo] = false;
    return false;
  }
  let mudou = false;
  if (pg.tipo === 'completo' || pg.tipo === 'gonza2') {
    const chave = pg.tipo === 'completo' ? 'gonza' : 'gonza2';
    if (registrarIndicador(info, chave, periodo, pg.minutoChute)) {
      mudou = true;
      if (!info.entradaConfirmada) {
        info.entradaConfirmada = true;
        confirmarEntradaReal(info, stratKey, pg.tipo);
      }
    }
    info.semEfAtivoPeriodo = info.semEfAtivoPeriodo || {};
    info.semEfAtivoPeriodo[periodo] = false;
  } else if (pg.tipo === 'sem_eficiencia') {
    info.semEfAtivoPeriodo = info.semEfAtivoPeriodo || {};
    if (!info.semEfAtivoPeriodo[periodo]) {
      if (registrarIndicador(info, 'semEf', periodo, info.__tempoAtualParaSemEf)) mudou = true;
      info.semEfAtivoPeriodo[periodo] = true;
    }
  }
  return mudou;
}

function confirmarEntradaReal(info, stratKey, condicao) {
  const pendLive = registrarPendente({ ...info.__jogoParaRegistro }, `${stratKey}_live`, 'live');
  pendLive.condicao = condicao;
  pendLive.msgIds = info.ids;
  salvarArquivo(PEND_FILE, pendentes);
}

async function processarIndicadoresProprios(jogo, estado, jogoId, hoje) {
  if (jogo.tempo === 'Intervalo' || jogo.tempo === 'Encerrado') return;
  const tempoNum   = parseInt(jogo.tempo) || 0;
  const jaPassouHT = !!estado.passouHT;
  const is1T       = !jaPassouHT;
  const is2T       = jaPassouHT;
  const periodoAtual = is1T ? '1T' : '2T';
  const favorito   = getFavorito(jogo);
  const golsCasa   = parseInt(jogo.gols_casa) || 0;
  const golsFora   = parseInt(jogo.gols_fora) || 0;

  const pendJogo = pendentes.filter(p =>
    p.data === hoje && p.result === 'pendente' &&
    (p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`)
  );

  estado.stratsDisparadas = estado.stratsDisparadas || {}; // stratKey -> true (já entrou em algum alerta, consolidado ou próprio)

  // ── ESTRATÉGIAS DE LADO ──────────────────────────────────────
  for (const stratKey of LADO_STRATS_PROPRIOS) {
    if (!pendJogo.some(p => p.strat === stratKey)) continue;
    const ladoAlvo = getLadoAlvoEstrategia(stratKey, jogo, hoje, pendJogo);
    if (!ladoAlvo) continue;

    const limitadaMin20 = LADO_STRATS_LIMITE_MIN20.includes(stratKey);
    const jaDisparou = estado.stratsDisparadas[stratKey];

    if (!jaDisparou) {
      if (limitadaMin20 && tempoNum > 20) continue; // janela de entrada já fechou

      const pg = checaPressaoGonza(jogo, estado, ladoAlvo, tempoNum);
      const ja = checaJogoAberto(jogo, tempoNum);
      let entradaReal = false, tipoIndicador = null, valor = null;

      if (pg && pg.tipo === 'completo') { entradaReal = true; tipoIndicador = 'gonza'; valor = pg.minutoChute; }
      else if (pg && pg.tipo === 'gonza2') { entradaReal = true; tipoIndicador = 'gonza2'; valor = pg.minutoChute; }
      else if (ja) { entradaReal = true; tipoIndicador = 'aberto'; valor = `${ja.minCasa}-${ja.minFora}`; }
      else if (pg && pg.tipo === 'sem_eficiencia') { entradaReal = false; tipoIndicador = 'semEf'; valor = tempoNum; }

      if (tipoIndicador) {
        estado.stratsDisparadas[stratKey] = true;
        const placarAlerta = `${golsCasa}x${golsFora}`;
        const abriu = await dispararOuAtualizarConsolidado(jogo, estado, stratKey, tempoNum, placarAlerta, { entradaReal, tipoIndicador, valorIndicador: valor });
        if (!abriu) {
          // consolidado já travado — abre mensagem própria pra essa estratégia
          await dispararAlertaIndicador(jogo, estado, stratKey, tipoIndicador, periodoAtual, valor, { ladoAlvo, entradaReal });
        }
      }
    } else if (estado.msgIds[stratKey]) {
      // essa estratégia abriu mensagem PRÓPRIA (consolidado já tinha travado
      // quando ela disparou) — segue o fluxo antigo pra ela.
      const info = estado.msgIds[stratKey];
      let mudou = false;
      const pg = checaPressaoGonza(jogo, estado, ladoAlvo, tempoNum);
      info.__tempoAtualParaSemEf = tempoNum;
      info.__jogoParaRegistro = jogo;
      if (registrarPressaoGonza(info, pg, periodoAtual, stratKey)) mudou = true;
      const ja = checaJogoAberto(jogo, tempoNum);
      if (ja) {
        const val = `${ja.minCasa}-${ja.minFora}`;
        if (registrarIndicador(info, 'aberto', periodoAtual, val)) {
          mudou = true;
          if (!info.entradaConfirmada) { info.entradaConfirmada = true; confirmarEntradaReal(info, stratKey, 'aberto'); }
        }
      }
      if (checarAvisoSaida(jogo, info, ladoAlvo, tempoNum)) mudou = true;
      if (mudou && !info.grupo1Status) await rerenderizarAlerta(jogo, estado, stratKey, info);
    } else if (estado.msgConsolidada && !estado.msgConsolidada.travado &&
               estado.msgConsolidada.estrategias.some(e => e.stratKey === stratKey)) {
      // estratégia já está no consolidado — só atualiza indicador/aviso dele
      estado.msgConsolidada.__tempoAtualParaSemEf = tempoNum;
      estado.msgConsolidada.__jogoParaRegistro = jogo;
      const pg = checaPressaoGonza(jogo, estado, ladoAlvo, tempoNum);
      let mudou = registrarPressaoGonza(estado.msgConsolidada, pg, periodoAtual, stratKey);
      const ja = checaJogoAberto(jogo, tempoNum);
      if (ja) {
        const val = `${ja.minCasa}-${ja.minFora}`;
        if (registrarIndicador(estado.msgConsolidada, 'aberto', periodoAtual, val)) mudou = true;
      }
      if (checarAvisoSaida(jogo, estado.msgConsolidada, ladoAlvo, tempoNum)) mudou = true;
      if (mudou) await rerenderizarConsolidado(jogo, estado);
    }
  }

  // ── ESTRATÉGIAS DE GOLS ───────────────────────────────────────
  await processarGolsMin45(jogo, estado, pendJogo, tempoNum, golsCasa, golsFora);

  for (const stratKey of GOLS_STRATS_PROPRIOS) {
    if (!pendJogo.some(p => p.strat === stratKey)) continue;
    if (!periodoValidoParaGols(stratKey, is1T, is2T, tempoNum)) continue;
    if (!placarValidoParaGols(stratKey, golsCasa, golsFora)) continue;

    const ladoZebraLocal = ladoOposto(favorito);
    const pgFav = checaPressaoGonza(jogo, estado, favorito, tempoNum);
    const pgZebra = (stratKey === 'gol_no_final') ? checaPressaoGonza(jogo, estado, ladoZebraLocal, tempoNum) : null;
    const ja = checaJogoAberto(jogo, tempoNum);
    const foraDoConsolidado = STRATS_FORA_DO_CONSOLIDADO.includes(stratKey);
    const jaDisparou = estado.stratsDisparadas[stratKey];

    if (!jaDisparou) {
      let pg = pgFav;
      if ((!pgFav || pgFav.tipo !== 'completo') && pgZebra?.tipo === 'completo') pg = pgZebra;
      else if (!pgFav && pgZebra) pg = pgZebra;

      let entradaReal = false, tipoIndicador = null, valor = null;
      if (pg && pg.tipo === 'completo') { entradaReal = true; tipoIndicador = 'gonza'; valor = pg.minutoChute; }
      else if (pg && pg.tipo === 'gonza2') { entradaReal = true; tipoIndicador = 'gonza2'; valor = pg.minutoChute; }
      else if (ja) { entradaReal = true; tipoIndicador = 'aberto'; valor = `${ja.minCasa}-${ja.minFora}`; }
      else if (pg && pg.tipo === 'sem_eficiencia') { entradaReal = false; tipoIndicador = 'semEf'; valor = tempoNum; }

      if (tipoIndicador) {
        estado.stratsDisparadas[stratKey] = true;
        if (foraDoConsolidado) {
          await dispararAlertaIndicador(jogo, estado, stratKey, tipoIndicador, periodoAtual, valor, { entradaReal });
        } else {
          const placarAlerta = `${golsCasa}x${golsFora}`;
          const abriu = await dispararOuAtualizarConsolidado(jogo, estado, stratKey, tempoNum, placarAlerta, { entradaReal, tipoIndicador, valorIndicador: valor });
          if (!abriu) {
            await dispararAlertaIndicador(jogo, estado, stratKey, tipoIndicador, periodoAtual, valor, { entradaReal });
          }
        }
      }
    } else if (estado.msgIds[stratKey]) {
      const info = estado.msgIds[stratKey];
      let mudou = false;
      info.__tempoAtualParaSemEf = tempoNum;
      info.__jogoParaRegistro = jogo;
      for (const pg of [pgFav, pgZebra]) {
        if (registrarPressaoGonza(info, pg, periodoAtual, stratKey)) mudou = true;
      }
      if (ja) {
        const val = `${ja.minCasa}-${ja.minFora}`;
        if (registrarIndicador(info, 'aberto', periodoAtual, val)) {
          mudou = true;
          if (!info.entradaConfirmada) { info.entradaConfirmada = true; confirmarEntradaReal(info, stratKey, 'aberto'); }
        }
      }
      if (mudou) await rerenderizarAlerta(jogo, estado, stratKey, info);
    } else if (!foraDoConsolidado && estado.msgConsolidada && !estado.msgConsolidada.travado &&
               estado.msgConsolidada.estrategias.some(e => e.stratKey === stratKey)) {
      estado.msgConsolidada.__tempoAtualParaSemEf = tempoNum;
      estado.msgConsolidada.__jogoParaRegistro = jogo;
      let mudou = false;
      for (const pg of [pgFav, pgZebra]) {
        if (registrarPressaoGonza(estado.msgConsolidada, pg, periodoAtual, stratKey)) mudou = true;
      }
      if (ja) {
        const val = `${ja.minCasa}-${ja.minFora}`;
        if (registrarIndicador(estado.msgConsolidada, 'aberto', periodoAtual, val)) mudou = true;
      }
      if (mudou) await rerenderizarConsolidado(jogo, estado);
    }
  }
}

const GRUPO1_STRATS = ['favorito_ht_gonza','lay_away_manu','lay_manu4','back_gonza_xg','lay_xg'];

// Grupo 1 tem sua própria máquina de estados (quem marca primeiro decide o
// resultado), mas as transições de "reação" agora usam os indicadores
// próprios em vez de raio+índices. O conceito de "Gol Limite" (conversão
// via raio no 2T) deixou de existir — o estado "red" agora é terminal.
async function processarEstadoGrupo1(jogo, estado, jogoId, hoje) {
  const golsCasa = parseInt(jogo.gols_casa) || 0;
  const golsFora = parseInt(jogo.gols_fora) || 0;
  const tempo     = jogo.tempo === 'Intervalo' ? (estado.ultimoMinuto || 45) : (parseInt(jogo.tempo) || 0);
  const isHT      = jogo.tempo === 'Intervalo';
  const links     = linksExchanges(jogo.urls_exchanges || {});

  // Transição de estado (green/atencao/reacao/red) — igual pros dois casos
  // (mensagem própria ou dentro do consolidado). Devolve o novo status, ou
  // null se nada mudou.
  function calcularTransicao(statusAtual, minutoGolContraAtual, alvoGols, contraGols, alvo) {
    if (!statusAtual) {
      if (alvoGols > contraGols) return { status: 'green' };
      if (contraGols > alvoGols) return { status: 'atencao', minutoGolContra: tempo };
      return null;
    }
    if (statusAtual === 'atencao') {
      if (alvoGols > contraGols) return { status: 'green' };
      if (tempo > 60 && !isHT) return { status: 'red' };
      const pgReacao = checaPressaoGonza(jogo, estado, alvo, tempo);
      const jaReacao = checaJogoAberto(jogo, tempo);
      const temReacao = (pgReacao && (pgReacao.tipo === 'completo' || pgReacao.tipo === 'gonza2')) || !!jaReacao;
      if (temReacao && tempo > (minutoGolContraAtual || 0)) return { status: 'reacao' };
      return null;
    }
    return null; // 'reacao' e 'red' são terminais
  }

  function alvoDaStrat(stratKey) {
    if (stratKey === 'lay_xg') {
      const pendLayXg = pendentes.find(p => p.condicao === 'lay_xg' && p.data === hoje &&
        (p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`));
      return pendLayXg?.lay_team === 'home' ? 'casa' : 'fora';
    }
    return 'casa';
  }

  const rotuloStatus = {
    atencao: '⚠️ time contra na frente — avaliar reação',
    reacao: '🔄 reação confirmada — considerar Lay contra o time da frente',
    red: '❌ sem reação confirmada',
    green: '✅ green',
  };

  // ── Caso 1: estratégia com mensagem PRÓPRIA (fallback, consolidado já travado quando ela abriu) ──
  for (const stratKey of GRUPO1_STRATS) {
    const info = estado.msgIds[stratKey];
    if (!info || !info.ids?.length) continue;
    if (info.grupo1Status === 'green') continue;

    const alvo = alvoDaStrat(stratKey);
    const alvoGols = alvo === 'casa' ? golsCasa : golsFora;
    const contraGols = alvo === 'casa' ? golsFora : golsCasa;
    const t = calcularTransicao(info.grupo1Status, info.minutoGolContra, alvoGols, contraGols, alvo);
    if (!t) continue;
    info.grupo1Status = t.status;
    if (t.minutoGolContra) info.minutoGolContra = t.minutoGolContra;

    const extras = montarLinhasIndicadores(info).join('\n');
    const extrasTxt = extras ? `\n${extras}` : '';
    const avisoTxt = info.avisoSaida ? `\n${info.avisoSaida}` : '';
    const confExtra = estado.confiabilidadeBloco ? `\n${estado.confiabilidadeBloco}` : '';
    const corpoExtra = `${extrasTxt}${avisoTxt}${confExtra}`;
    const display = STRAT_DISPLAY[stratKey] || stratKey;
    const fixo = `${display}\n⚽ <b>${jogo.mandante} x ${jogo.visitante}</b>\n⏱ ${info.tempoAlerta}' · 📊 ${info.placarAlerta}\n─────────────────`;
    await editTelegram(info.ids, `${fixo}\n${rotuloStatus[t.status]} · ${golsCasa}x${golsFora} (min ${tempo})${corpoExtra}${links}`);
  }

  // ── Caso 2: estratégia dentro do alerta CONSOLIDADO ──────────────
  if (estado.msgConsolidada?.ids?.length) {
    let mudouAlgo = false;
    for (const e of estado.msgConsolidada.estrategias) {
      if (!GRUPO1_STRATS.includes(e.stratKey)) continue;
      if (e.grupo1Status === 'green') continue;

      const alvo = alvoDaStrat(e.stratKey);
      const alvoGols = alvo === 'casa' ? golsCasa : golsFora;
      const contraGols = alvo === 'casa' ? golsFora : golsCasa;
      const t = calcularTransicao(e.grupo1Status, e.minutoGolContra, alvoGols, contraGols, alvo);
      if (!t) continue;
      e.grupo1Status = t.status;
      if (t.minutoGolContra) e.minutoGolContra = t.minutoGolContra;
      mudouAlgo = true;
    }
    if (mudouAlgo && !estado.msgConsolidada.travado) await rerenderizarConsolidado(jogo, estado);
  }
}

async function processarAlertasLive(jogo, estado, jogoId, hoje) {
  // 26/07 — toda a lógica antiga baseada em raio/índices (resumo_pressao)
  // foi removida daqui. Praticamente tudo migrou pra dentro de
  // processarIndicadoresProprios. Só sobra aqui o caso especial do
  // Over 1.5 HT (upgrade do Over 0.5 HT quando já tem exatamente 1 gol).
  const tempoNum = parseInt(jogo.tempo) || 0;
  const isHT = jogo.tempo === 'Intervalo';
  const is1T = !isHT && !estado.passouHT;
  const golsCasa = parseInt(jogo.gols_casa) || 0;
  const golsFora = parseInt(jogo.gols_fora) || 0;
  const total = golsCasa + golsFora;

  const pendJogo = pendentes.filter(p =>
    p.data === hoje && p.result === 'pendente' &&
    (p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`)
  );

  if (pendJogo.some(p => p.strat === 'over05_ht') && !estado.msgIds['over15_ht']) {
    if (is1T && total === 1 && tempoNum <= 20) {
      const favorito = getFavorito(jogo);
      const pg = checaPressaoGonza(jogo, estado, favorito, tempoNum) || checaPressaoGonza(jogo, estado, ladoOposto(favorito), tempoNum);
      const ja = checaJogoAberto(jogo, tempoNum);
      if (pg && pg.tipo === 'completo') {
        await dispararAlertaIndicador(jogo, estado, 'over15_ht', 'gonza', '1T', pg.minutoChute, { entradaReal: true });
      } else if (pg && pg.tipo === 'gonza2') {
        await dispararAlertaIndicador(jogo, estado, 'over15_ht', 'gonza2', '1T', pg.minutoChute, { entradaReal: true });
      } else if (ja) {
        await dispararAlertaIndicador(jogo, estado, 'over15_ht', 'aberto', '1T', `${ja.minCasa}-${ja.minFora}`, { entradaReal: true });
      } else if (pg && pg.tipo === 'sem_eficiencia') {
        await dispararAlertaIndicador(jogo, estado, 'over15_ht', 'semEf', '1T', tempoNum, { entradaReal: false });
      }
    }
  }
}
async function processarFimDeJogo(jogoId, estado, hoje) {
  console.log(`[FIM] ${jogoId}`);
  const jogo = estado.jogo;
  if (!jogo) return;

  const jaResolvidoAntes = pendentes.some(p =>
    p.data === hoje &&
    (p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`) &&
    p.result !== 'pendente'
  );
  if (jaResolvidoAntes) {
    console.log(`[FIM] ${jogoId} já tinha sido resolvido anteriormente — pulando reenvio.`);
    return;
  }

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
  const placarFT = placarFTApi;

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

  for (const p of pendJogo) {
    p.final  = placarFT;
    p.ht     = estado.htPlacar || '';
    const res = calcularResultado(p.strat, golsCasa, golsFora, htH, htA);
    p.result  = res || 'resolvido';
  }
  salvarArquivo(PEND_FILE, pendentes);

  for (const [stratKey, info] of Object.entries(estado.msgIds || {})) {
    if (!info?.ids?.length) continue;

    if (info.grupo1Status === 'green' || info.grupo1Status === 'red') continue;

    const stratBase = stratKey.replace(/_live$/, '');
    const pLive = pendJogo.find(p => {
      const ps = p.strat.replace(/_live$/, '');
      return ps === stratBase || ps === stratKey;
    });

    let res;
    if (!info.entradaConfirmada) {
      res = 'nao_entra'; // só teve Pressão sem eficiência, nunca virou entrada real
    } else {
      res = pLive?.result || calcularResultado(stratBase, golsCasa, golsFora, htH, htA);
    }
    let emoji;
    if (res === 'green')        emoji = '✅ GREEN';
    else if (res === 'red')     emoji = '❌ RED';
    else if (res === 'nao_entra') emoji = '⚪ NÃO ENTROU (condição não bateu)';
    else                        emoji = '⏳ AVALIAR MANUALMENTE';
    const display = STRAT_DISPLAY[stratKey] || stratKey;

    // Preserva todo o histórico acumulado (indicadores + aviso de saída +
    // confiabilidade) — nunca reescreve do zero, só acrescenta o resultado.
    const partes = [...montarLinhasIndicadores(info)];
    if (info.avisoSaida) partes.push(info.avisoSaida);
    if (estado.confiabilidadeBloco) partes.push(estado.confiabilidadeBloco);
    const htTexto = estado.htPlacar || '-';
    partes.push(`${emoji} · HT: ${htTexto} · FT: ${placarFT}`);
    const corpo = partes.join('\n');

    const textoFinal = `${display}\n⚽ <b>${jogo.mandante} x ${jogo.visitante}</b>\n⏱ ${info.tempoAlerta}' · 📊 ${info.placarAlerta}\n─────────────────\n${corpo}${links}`;
    await editTelegram(info.ids, textoFinal);
  }

  // ── Fecha o alerta CONSOLIDADO, se existir ─────────────────────
  if (estado.msgConsolidada?.ids?.length) {
    const msgCons = estado.msgConsolidada;

    // Resultado original de cada estratégia ativa (Opção A — sempre
    // preservado, independente do resultado da entrada sugerida).
    const linhasEstrategias = msgCons.estrategias.map(e => {
      const stratBase = e.stratKey.replace(/_live$/, '');
      const pLive = pendJogo.find(p => {
        const ps = p.strat.replace(/_live$/, '');
        return ps === stratBase || ps === e.stratKey;
      });
      const res = pLive?.result || calcularResultado(stratBase, golsCasa, golsFora, htH, htA);
      const emoji = res === 'green' ? '✅' : res === 'red' ? '❌' : '⚪';
      const display = STRAT_DISPLAY[e.stratKey] || e.stratKey;
      return `  ${emoji} ${display} (${e.tempoNum}' · ${e.placarAlerta})`;
    }).join('\n');

    // Fecha a entrada sugerida com o placar final, se ainda não tinha travado.
    if (!msgCons.travado) {
      const gr = checarGreenConsolidado(jogo, estado, msgCons.entradaSugerida);
      msgCons.entradaGreen = gr.green || (msgCons.entradaSugerida ? true : false);
      msgCons.entradaMinutoGreen = gr.minutoGreen;
      if (!gr.green && msgCons.entradaSugerida) {
        // jogo acabou e a entrada sugerida não bateu green ainda pelo
        // critério ao vivo — resolve como RED aqui no fechamento.
        msgCons.entradaGreen = false;
        msgCons.entradaRed = true;
      }
    }

    const partes = [...montarLinhasIndicadores(msgCons)];
    if (msgCons.avisoSaida) partes.push(msgCons.avisoSaida);
    if (msgCons.entradaSugerida) {
      let linhaEntrada = `➜ ENTRADA: ${msgCons.entradaSugerida.texto}`;
      if (msgCons.entradaGreen) {
        linhaEntrada += `\n✅ GREEN` + (msgCons.entradaMinutoGreen ? ` — gol aos ${msgCons.entradaMinutoGreen}'` : '');
      } else if (msgCons.entradaRed) {
        linhaEntrada += `\n❌ RED`;
      }
      partes.push(linhaEntrada);
    }
    if (estado.confiabilidadeBloco) partes.push(estado.confiabilidadeBloco);
    const htTexto = estado.htPlacar || '-';
    partes.push(`📊 HT: ${htTexto} · FT: ${placarFT}`);
    const corpo = partes.join('\n');

    const textoFinal = `⚽ <b>${jogo.mandante} x ${jogo.visitante}</b>\n⏱ Alertas ativos:\n${linhasEstrategias}\n─────────────────\n${corpo}${links}`;
    await editTelegram(msgCons.ids, textoFinal);
  }

  // Só manda o aviso solto de "FIM DE JOGO" se o jogo teve pelo menos 1
  // alerta de estratégia de verdade — evita poluir o chat com jogos que o
  // servidor só estava monitorando (Seleção IA/Filtro/Estratégia registrada
  // no pré-jogo) mas nenhum indicador bateu durante a partida.
  if (Object.keys(estado.msgIds || {}).length > 0 || estado.msgConsolidada?.ids?.length) {
    await sendTelegram(`🏁 <b>FIM DE JOGO</b>\n⚽ ${jogo.mandante} x ${jogo.visitante}\n📊 FT: ${placarFT}`);
  }
}

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

app.get('/', (req, res) => res.json({
  status: 'ok', version: 'server_45',
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

const TIPO_EVENTO_LABEL_MS = {
  chute_no_gol: 'chute no gol', chute_para_fora: 'chute pra fora',
  chute_bloqueado: 'bloqueado', chute_na_trave: 'na trave',
  raio: 'raio', escanteio: 'escanteio', gol: 'GOL',
  cartao_amarelo: 'cartão amarelo', cartao_vermelho: 'cartão vermelho',
};

function msEventosDaJanela(jogo, lado, minutos) {
  const evs = (jogo.eventos || []).filter(e => e.lado === lado && minutos.includes(e.minuto));
  if (!evs.length) return '—';
  return evs.map(e => `${e.minuto}' ${TIPO_EVENTO_LABEL_MS[e.tipo_evento] || e.tipo_evento}`).join(', ');
}

function msJanelasDestaque5min(jogo, lado, minutos) {
  if (minutos.length < 5) return [];
  const campo  = lado === 'casa' ? 'valor_casa' : 'valor_fora';
  const oposto = lado === 'casa' ? 'valor_fora' : 'valor_casa';
  function valor(min, campoAlvo) {
    const m = (jogo.momentum || []).find(x => x.minuto === min);
    return m ? (m[campoAlvo] || 0) : 0;
  }
  const min0 = minutos[0], minN = minutos[minutos.length - 1];
  const destaques = [];
  for (let i = min0; i <= minN - 4; i++) {
    let limpa = true;
    const vals = [];
    for (let k = i; k <= i + 4; k++) {
      if (valor(k, oposto) !== 0) limpa = false;
      vals.push(valor(k, campo));
    }
    if (!limpa) continue;
    const media = vals.reduce((s, v) => s + Math.abs(v), 0) / 5;
    if (media >= 136) destaques.push({ faixa: `${i}-${i + 4}`, media: Math.round(media * 100) / 100 });
  }
  return destaques;
}

function msSequenciasMomentum(jogo, lado, periodo) {
  const campo  = lado === 'casa' ? 'valor_casa' : 'valor_fora';
  const oposto = lado === 'casa' ? 'valor_fora' : 'valor_casa';
  const m = (jogo.momentum || [])
    .filter(x => periodo === '1T' ? x.minuto <= 45.5 : x.minuto > 45.5)
    .sort((a, b) => a.minuto - b.minuto);

  const seqs = []; let atual = null;
  m.forEach(x => {
    if (x[oposto] === 0 && x[campo] !== 0) { if (!atual) atual = []; atual.push({ minuto: x.minuto, valor: x[campo] }); }
    else if (x[oposto] !== 0) { if (atual && atual.length) seqs.push(atual); atual = null; }
  });
  if (atual && atual.length) seqs.push(atual);

  return seqs.map(s => {
    const minutos = s.map(x => x.minuto);
    const media = s.reduce((sum, x) => sum + Math.abs(x.valor), 0) / s.length;
    return {
      faixa: minutos.length > 1 ? `${minutos[0]}-${minutos[minutos.length - 1]}` : `${minutos[0]}`,
      valores: s.map(x => Math.round(x.valor * 100) / 100),
      media: Math.round(media * 100) / 100,
      eventos: msEventosDaJanela(jogo, lado, minutos),
      janelasDestaque: msJanelasDestaque5min(jogo, lado, minutos),
    };
  });
}

function msContarChutes(jogo, lado, periodo) {
  const periodoApi = periodo === '1T' ? '1_tempo' : '2_tempo';
  const evs = (jogo.eventos || []).filter(e =>
    e.lado === lado && e.periodo === periodoApi && e.tipo_evento.startsWith('chute')
  );
  return {
    no_gol:    evs.filter(e => e.tipo_evento === 'chute_no_gol').length,
    pra_fora:  evs.filter(e => e.tipo_evento === 'chute_para_fora').length,
    bloqueado: evs.filter(e => e.tipo_evento === 'chute_bloqueado').length,
    na_trave:  evs.filter(e => e.tipo_evento === 'chute_na_trave').length,
  };
}

function msBlocoTime(jogo, lado, periodo, nomeTime) {
  const seqs   = msSequenciasMomentum(jogo, lado, periodo);
  const chutes = msContarChutes(jogo, lado, periodo);
  const ladoTxt = lado === 'casa' ? 'casa' : 'fora';

  let html = `<div class="ms-card"><p class="ms-team">${nomeTime} <span class="ms-muted">(${ladoTxt})</span></p>`;
  if (!seqs.length) {
    html += `<p class="ms-muted ms-small">sem sequências nesse período</p>`;
  } else {
    seqs.forEach(s => {
      const destaque = Math.abs(s.media) >= 136 ? ' ms-good' : '';
      html += `<div class="ms-seq">
        <div class="ms-muted ms-small">min ${s.faixa} &middot; ${s.valores.join(',')}</div>
        <div class="ms-seq-row"><span class="ms-media${destaque}">média ${s.media}</span><span class="ms-muted ms-small">${s.eventos}</span></div>`;
      if (s.janelasDestaque && s.janelasDestaque.length) {
        s.janelasDestaque.forEach(j => {
          html += `<div class="ms-janela-destaque">🟣 janela ${j.faixa} → ${j.media} (BATE)</div>`;
        });
      }
      html += `</div>`;
    });
  }
  html += `<div class="ms-chutes">
    <div><div class="ms-num">${chutes.no_gol}</div><div class="ms-muted ms-small">no gol</div></div>
    <div><div class="ms-num">${chutes.pra_fora}</div><div class="ms-muted ms-small">pra fora</div></div>
    <div><div class="ms-num">${chutes.bloqueado}</div><div class="ms-muted ms-small">bloqueado</div></div>
    <div><div class="ms-num">${chutes.na_trave}</div><div class="ms-muted ms-small">na trave</div></div>
  </div></div>`;
  return html;
}

function msHTMLJogo(jogo) {
  const tempoTxt = jogo.tempo === 'Intervalo' ? 'Intervalo' : jogo.tempo === 'Encerrado' ? 'Encerrado' : `${jogo.tempo}'`;
  let html = `<div class="ms-jogo">
    <div class="ms-jogo-header">
      <p class="ms-jogo-nome">${jogo.mandante} x ${jogo.visitante}</p>
      <p class="ms-muted ms-small">${tempoTxt} &middot; placar ${jogo.gols_casa}x${jogo.gols_fora}</p>
    </div>
    <p class="ms-periodo">1º tempo</p>
    <div class="ms-grid">${msBlocoTime(jogo, 'casa', '1T', jogo.mandante)}${msBlocoTime(jogo, 'fora', '1T', jogo.visitante)}</div>`;

  const temDados2T = (jogo.momentum || []).some(m => m.minuto > 45.5 && (m.valor_casa !== 0 || m.valor_fora !== 0));
  if (temDados2T) {
    html += `<p class="ms-periodo">2º tempo</p>
    <div class="ms-grid">${msBlocoTime(jogo, 'casa', '2T', jogo.mandante)}${msBlocoTime(jogo, 'fora', '2T', jogo.visitante)}</div>`;
  }
  html += `</div>`;
  return html;
}

function msPaginaHTML(corpo) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>FUTATS — Momentum Status</title>
  <style>
    body { background:#0e0e10; color:#e8e8e6; font-family:-apple-system,Segoe UI,Roboto,sans-serif; margin:0; padding:16px; }
    h1 { font-size:16px; font-weight:600; margin:0 0 16px; }
    .ms-jogo { background:#18181b; border-radius:12px; padding:14px 16px; margin-bottom:16px; }
    .ms-jogo-header { display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
    .ms-jogo-nome { font-size:15px; font-weight:600; margin:0; }
    .ms-periodo { font-size:12px; font-weight:600; color:#9a9a96; margin:14px 0 6px; text-transform:uppercase; letter-spacing:.04em; }
    .ms-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px,1fr)); gap:10px; }
    .ms-card { background:#212124; border-radius:10px; padding:10px 12px; }
    .ms-team { font-size:13px; font-weight:600; margin:0 0 8px; }
    .ms-seq { font-size:13px; margin-bottom:7px; padding-bottom:7px; border-bottom:1px solid #2c2c30; }
    .ms-seq:last-of-type { border-bottom:none; }
    .ms-seq-row { display:flex; justify-content:space-between; align-items:baseline; gap:8px; margin-top:2px; flex-wrap:wrap; }
    .ms-media { font-weight:600; }
    .ms-good { color:#5dcaa5; }
    .ms-janela-destaque { font-size:11px; color:#c08bf0; margin-top:3px; font-weight:600; }
    .ms-muted { color:#9a9a96; }
    .ms-small { font-size:11px; }
    .ms-chutes { margin-top:8px; background:#18181b; border-radius:8px; padding:8px; display:grid; grid-template-columns:repeat(4,1fr); gap:4px; text-align:center; }
    .ms-num { font-size:14px; font-weight:600; }
    .ms-empty { color:#9a9a96; font-size:14px; }
  </style></head><body>
  <h1>FUTATS — Momentum Status <span style="color:#9a9a96;font-weight:400;">(atualiza a cada 30s)</span></h1>
  ${corpo}
  </body></html>`;
}

app.get('/momentum-status', async (req, res) => {
  try {
    const hoje = dataHoje();
    const filtroTodos = req.query.todos === '1';
    const filtroJogo  = (req.query.jogo || '').trim().toLowerCase();

    let jogosLive = [];
    try {
      const rLive = await futatsGet('api-games-live');
      jogosLive = rLive[0]?.eventos || [];
    } catch (e) {
      return res.send(msPaginaHTML('<p class="ms-empty">Não consegui consultar a API live agora.</p>'));
    }

    let jogosRelevantes;
    if (filtroJogo) {
      jogosRelevantes = jogosLive.filter(jogo =>
        jogo.mandante.toLowerCase().includes(filtroJogo) || jogo.visitante.toLowerCase().includes(filtroJogo)
      );
      if (!jogosRelevantes.length) {
        return res.send(msPaginaHTML(`<p class="ms-empty">Nenhum jogo na live agora com "${req.query.jogo}" no nome.</p>`));
      }
    } else if (filtroTodos) {
      jogosRelevantes = jogosLive;
      if (!jogosRelevantes.length) {
        return res.send(msPaginaHTML('<p class="ms-empty">Nenhum jogo na live agora.</p>'));
      }
    } else {
      const stratsRelevantes = new Set([...LADO_STRATS_PROPRIOS, ...GOLS_STRATS_PROPRIOS]);
      const pendRelevantes = pendentes.filter(p =>
        p.data === hoje && p.result === 'pendente' && stratsRelevantes.has(p.strat)
      );
      if (!pendRelevantes.length) {
        return res.send(msPaginaHTML('<p class="ms-empty">Nenhuma estratégia nossa pendente hoje. Use ?todos=1 pra ver todos os jogos da live, ou ?jogo=nome pra buscar um específico.</p>'));
      }
      jogosRelevantes = jogosLive.filter(jogo =>
        pendRelevantes.some(p => p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`)
      );
      if (!jogosRelevantes.length) {
        return res.send(msPaginaHTML('<p class="ms-empty">Nenhum jogo com estratégia nossa pendente está na live agora. Use ?todos=1 pra ver todos os jogos da live, ou ?jogo=nome pra buscar um específico.</p>'));
      }
    }

    const corpo = jogosRelevantes.map(msHTMLJogo).join('');
    res.send(msPaginaHTML(`<p><a href="/momentum-status/historico">📜 Ver histórico de jogos encerrados</a></p>${corpo}`));
  } catch (e) {
    res.status(500).send('Erro ao gerar status: ' + e.message);
  }
});

// ── Exportar histórico bruto de momentum (JSON completo) ──────────
// Rota temporária pra baixar o arquivo direto do Volume e analisar fora.
// Uso: /interno/exportar-momentum?token=SEU_INTERNAL_TOKEN
app.get('/interno/exportar-momentum', (req, res) => {
  if (!INTERNAL_TOKEN || req.query.token !== INTERNAL_TOKEN) {
    return res.status(403).send('Token inválido.');
  }
  if (!fs.existsSync(MOMENTUM_HISTORICO_FILE)) {
    return res.status(404).send('Arquivo momentum_historico.json não encontrado.');
  }
  res.download(MOMENTUM_HISTORICO_FILE, 'momentum_historico.json');
});

// ── Histórico do momentum — jogos já encerrados e arquivados ──────
// Lista todos os jogos arquivados (com filtro opcional por data/time),
// cada um linkando pra reabrir o gráfico completo dele.
app.get('/momentum-status/historico', (req, res) => {
  const filtroData = (req.query.data || '').trim();
  const filtroJogo  = (req.query.jogo || '').trim().toLowerCase();

  const linhas = [];
  for (const [jogoId, registros] of Object.entries(momentumHistorico)) {
    registros.forEach((reg, idx) => {
      const jogo = reg.jogo || {};
      const dataJogo = (jogo.data || '').slice(0, 10);
      if (filtroData && dataJogo !== filtroData) return;
      if (filtroJogo &&
          !(jogo.mandante || '').toLowerCase().includes(filtroJogo) &&
          !(jogo.visitante || '').toLowerCase().includes(filtroJogo)) return;
      linhas.push({ jogoId, idx, dataJogo, jogo, reg });
    });
  }
  linhas.sort((a, b) => (b.reg.encerradoEm || 0) - (a.reg.encerradoEm || 0));

  if (!linhas.length) {
    return res.send(msPaginaHTML('<p class="ms-empty">Nenhum jogo arquivado ainda (ou nenhum bate com o filtro). Jogos só são arquivados 1h depois de encerrados.</p>'));
  }

  const corpoLinhas = linhas.map(({ jogoId, idx, dataJogo, jogo, reg }) => `
    <div class="ms-jogo">
      <div class="ms-jogo-header">
        <p class="ms-jogo-nome">${jogo.mandante} x ${jogo.visitante}</p>
        <p class="ms-muted ms-small">${dataJogo} &middot; placar final ${reg.ultimoPlacar || '-'} (HT: ${reg.htPlacar || '-'})</p>
      </div>
      <a href="/momentum-status/historico/${encodeURIComponent(jogoId)}?idx=${idx}">Ver gráfico completo</a>
    </div>`).join('');

  res.send(msPaginaHTML(`<p class="ms-muted" style="margin-bottom:12px;">${linhas.length} jogo(s) arquivado(s)</p>${corpoLinhas}`));
});

// Reabre o gráfico completo de UM jogo já encerrado, reaproveitando a
// mesma função de desenho usada nos jogos ao vivo (msHTMLJogo).
app.get('/momentum-status/historico/:jogoId', (req, res) => {
  const jogoId = req.params.jogoId;
  const idx = parseInt(req.query.idx) || 0;
  const registros = momentumHistorico[jogoId];
  if (!registros || !registros[idx]) {
    return res.status(404).send(msPaginaHTML('<p class="ms-empty">Jogo não encontrado no histórico.</p>'));
  }
  const reg = registros[idx];
  const jogoParaDesenho = {
    ...reg.jogo,
    momentum: reg.momentum,
    eventos: reg.eventos,
    tempo: 'Encerrado',
  };
  const corpo = `<p><a href="/momentum-status/historico">← Voltar pro histórico</a></p>${msHTMLJogo(jogoParaDesenho)}`;
  res.send(msPaginaHTML(corpo));
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
  await sendTelegram('✅ FUTATS Server v45b funcionando! 🎯');
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

app.get('/buscar-agora', async (req, res) => {
  try {
    const hoje = dataHoje();
    const antes = pendentes.filter(p => p.tipo === 'pre' && p.data === hoje).length;
    await buscarPreJogo();
    const depois = pendentes.filter(p => p.tipo === 'pre' && p.data === hoje).length;
    const novos = Math.max(0, depois - antes);
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>FUTATS — Buscar Agora</title>
    <style>
      body { background:#0e0e10; color:#e8e8e6; font-family:-apple-system,Segoe UI,Roboto,sans-serif; margin:0; padding:20px; }
      h2 { font-size:18px; margin:0 0 12px; }
      p { font-size:14px; color:#cfcfcc; }
      a { color:#8ab4f8; text-decoration:none; }
      .num { color:#5dcaa5; font-weight:600; }
    </style></head><body>
      <h2>✅ Busca concluída</h2>
      <p><span class="num">${novos}</span> nova(s) estratégia(s) registrada(s) agora.</p>
      <p>Total de pendentes pré-jogo hoje: <span class="num">${depois}</span></p>
      <p><a href="/pendentes">Ver todos os pendentes</a> · <a href="/momentum-status">Ver Momentum Status</a></p>
    </body></html>`);
  } catch (e) {
    res.status(500).send('Erro ao buscar: ' + e.message);
  }
});

app.listen(PORT, async () => {
  console.log(`FUTATS Server v45b na porta ${PORT}`);

  await buscarPreJogo();

  agendarHoraBRT(8,  0, buscarPreJogo);
  agendarHoraBRT(12, 30, buscarPreJogo);
  agendarHoraBRT(19, 0, buscarPreJogo);

  setInterval(monitorarLive, 60 * 1000);

  agendarHoraBRT(8,  0, enviarCardMatinal);
  agendarHoraBRT(18, 0, enviarResumoDia);
  agendarHoraBRT(0,  0, enviarResumoECard);

  await sendTelegram(
    '🚀 <b>FUTATS Server v45b iniciado!</b>\n' +
    '✅ Horários das APIs ajustados conforme documentação\n' +
    '✅ Resumo NÃO é mais reenviado automaticamente ao reiniciar\n' +
    '✅ HT pego direto da API (gols_casa_ht/gols_fora_ht)\n' +
    '✅ Fix is2T/is1T — campo periodo (inexistente na API) removido, usa histórico do jogo\n' +
    '✅ Gol no Final / Over 0,5 2T — raio confirmado via periodo do evento (precisão total)\n' +
    '✅ Lay 0x1/1x0/0x2/0x3/Goleada — só até min 20\n' +
    '✅ Fix Over 0,5 Gonza (Gol Limite) — mercado agora é total+0,5 após min 60 / total+1,5 antes, nunca mais fixo em Over 1,5\n' +
    '🆕 Indicadores próprios Pressão Gonza & Jogo Aberto (substituem o raio do futats.com nas entradas)\n' +
    '✅ Fix: indicadores próprios agora respeitam a janela de cada estratégia (gol_no_final só 2T/min80, over05_ht só 1T, lay_0x1_ia/1x0_ia/0x2_manu/0x3/gol_visit/gol_mand até min 20)\n' +
    '✅ Fix: placar/minuto das mensagens dos indicadores próprios agora atualiza a cada ciclo (antes ficava congelado no momento da entrada)\n' +
    '✅ Gol no Final agora checa Pressão Gonza nos dois lados (favorito e zebra), não só no favorito\n' +
    '🆕 Estratégias de gols já alertadas (raio antigo ou indicador próprio) agora recebem confirmação extra na mesma mensagem quando o outro indicador também bate (Pressão Gonza ou Jogo Aberto)\n' +
    '🆕 Reconfirmação por período: qualquer estratégia (lado ou gols) já alertada agora anota até 1x por tempo (1T/2T) quando Pressão Gonza ou Jogo Aberto bate de novo, sem duplicar alerta'
  );

  await enviarCardMatinal();
});
