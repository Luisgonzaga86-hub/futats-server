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

const DATA_FILE   = path.join(__dirname, 'dados.json');
const PEND_FILE   = path.join(__dirname, 'pendentes.json');
const ESTADO_FILE = path.join(__dirname, 'estado_live.json');

function lerArquivo(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function salvarArquivo(file, data) {
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
}

let dadosHist = lerArquivo(DATA_FILE, []);
let pendentes = lerArquivo(PEND_FILE, []);

// Estado live por jogo — persistido em arquivo (estado_live.json) a cada
// ciclo do monitorarLive, pra sobreviver a um restart do Railway. Sem isso,
// reiniciar com jogo rolando perdia o controle de mensagens já enviadas
// (gerando duplicatas), o placar do HT, e a noção de 1T/2T do jogo.
let estadoLive = lerArquivo(ESTADO_FILE, {});
// Reseta "ultimaVez" de tudo que foi restaurado — sem isso, o tempo que
// passou durante o restart contaria como "sumiu do live" e forçaria o
// encerramento de jogos que ainda estão rolando de verdade.
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
  // Timeout de 10s — se a API do futats.com não responder nesse prazo,
  // a chamada é abortada (sem retry — só falha e o próximo ciclo tenta de novo).
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

// ── INDICADORES DE PRESSÃO (resumo_pressao da API) ────────────
// Extrai % pressão, índice de pressão e eficiência de um período específico.
// periodo: 'total' | '1_tempo' | '2_tempo' | 'ult_10min'
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

// Condição "Grupo 1" — pressão/índice/eficiência do time mandante (ou espelhado pro visitante)
// alvo: 'casa' ou 'fora' — qual lado deve estar dominando
function checaCondicaoGrupo1(jogo, periodo, alvo) {
  const ind = getIndicadores(jogo, periodo);
  if (alvo === 'casa') {
    return ind.pctCasa >= 65 && ind.idxCasa >= 20 && ind.idxFora <= 9 &&
           ind.efCasa >= 0.17 && ind.efFora <= 0.09;
  } else {
    return ind.pctFora >= 65 && ind.idxFora >= 20 && ind.idxCasa <= 9 &&
           ind.efFora >= 0.17 && ind.efCasa <= 0.09;
  }
}

// Condição "modo reação" (favorito perdendo, últimos 10min) — mais rígida
function checaCondicaoReacao(jogo, alvo) {
  const ind = getIndicadores(jogo, 'ult_10min');
  if (alvo === 'casa') {
    return ind.pctCasa >= 70 && ind.idxCasa >= 20 && ind.idxFora <= 7 &&
           ind.efCasa >= 0.20 && ind.efFora <= 0.07;
  } else {
    return ind.pctFora >= 70 && ind.idxFora >= 20 && ind.idxCasa <= 7 &&
           ind.efFora >= 0.20 && ind.efCasa <= 0.07;
  }
}

// Condição "Indicador do Gonza" — jogo empatado, raio dos dois times APÓS o
// gol mais recente (que gerou o empate), índice >=15 ambos, eficiência um>=0.20 outro>0.10
function checaIndicadorGonza(jogo, estado, periodo) {
  const ind = getIndicadores(jogo, periodo);
  const idxOk = ind.idxCasa >= 15 && ind.idxFora >= 15;
  const efOk  = (ind.efCasa >= 0.20 && ind.efFora > 0.10) || (ind.efFora >= 0.20 && ind.efCasa > 0.10);
  if (!idxOk || !efOk) return false;

  // Minuto do último gol (qualquer lado) — raios precisam ser DEPOIS dele
  const golsEventos = (jogo.eventos || []).filter(e => e.tipo_evento === 'gol');
  const minutoUltimoGol = golsEventos.length ? Math.max(...golsEventos.map(e => e.minuto)) : 0;

  const periodoFiltro = periodo === '1_tempo' ? '1_tempo' : periodo === '2_tempo' ? '2_tempo' : null;
  const raiosValidos = (jogo.eventos || []).filter(e =>
    e.tipo_evento === 'raio' &&
    e.minuto > minutoUltimoGol &&
    (!periodoFiltro || e.periodo === periodoFiltro)
  );
  const temRaioCasaAposGol = raiosValidos.some(e => e.lado === 'casa');
  const temRaioForaAposGol = raiosValidos.some(e => e.lado === 'fora');

  return temRaioCasaAposGol && temRaioForaAposGol;
}

// ════════════════════════════════════════════════════════════════
// ── INDICADORES PRÓPRIOS — PRESSÃO GONZA & JOGO ABERTO ──────────
// ════════════════════════════════════════════════════════════════
// Substituem a dependência do "raio" do futats.com (que só dispara em
// múltiplos de 5min, sempre atrasado em relação à pressão real) por um
// cálculo direto cima do momentum[] + eventos[], a cada ciclo (90s).
//
// PRESSÃO GONZA (estratégias de LADO — nosso time precisa marcar e o
// oponente não): janela de 5 minutos-calendário consecutivos terminando
// no minuto atual, com o oponente em momentum=0 o tempo todo (janela
// "limpa"). Dentro dela:
//   • média (módulo) >= 136 + chute no gol do nosso lado + eficiência
//     (período correto) >= 0.17  → "completo" (entrada real confirmada)
//   • média (módulo) >= 180, mesmo sem chute no gol               → "sem_eficiencia"
//     (só observação — fica monitorando até confirmar ou o jogo acabar)
//
// JOGO ABERTO: os dois lados com pico de momentum >=150 (módulo) + algum
// chute, dentro de até 2 minutos um do outro. Pra estratégias de GOLS é
// gatilho de entrada; pra estratégias de LADO é sinal de saída/atenção.
//
// CONDIÇÃO DE SAÍDA/PROTEÇÃO (lado já com entrada aberta) — o OPONENTE
// mostrou reação real, qualquer uma destas (janela de 5min terminando
// no minuto atual):
//   • pico >=150 (módulo) + chute (no gol OU pra fora) no mesmo minuto
//   • média (módulo) dos 5 minutos > 100
//   • 2 chutes (qualquer tipo) dentro da janela
// + cartão vermelho do nosso lado = saída imediata, sempre.
// ════════════════════════════════════════════════════════════════

function round2(n) { return Math.round(n * 100) / 100; }

function ladoOposto(lado) { return lado === 'casa' ? 'fora' : 'casa'; }

// Valor de momentum de um lado num minuto específico (0 se não houver dado)
function valorMomento(jogo, minuto, lado) {
  const m = (jogo.momentum || []).find(x => x.minuto === minuto);
  if (!m) return 0;
  return (lado === 'casa' ? m.valor_casa : m.valor_fora) || 0;
}

// Janela dos últimos 5 minutos-calendário (consecutivos, incluindo zeros)
// terminando no minutoAtual. ladoAlvo = de quem queremos a "força";
// também devolve o valor do lado oposto em cada minuto (pra checar limpeza).
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

// Eficiência do nosso lado no período "correto": ult_10min no 1T sempre;
// no 2T, usa resumo_pressao['2_tempo'] enquanto faltarem menos de 10min
// de jogo no 2T (dados ainda muito recentes pro ult_10min fazer sentido),
// e troca pra ult_10min depois disso. estado.minutoInicio2T é marcado em
// monitorarLive no primeiro tick numérico após o intervalo.
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

// ── PRESSÃO GONZA ──────────────────────────────────────────────
// Retorna null (não bate nada) ou { tipo: 'completo'|'sem_eficiencia', media, minutoChute?, eficiencia? }
function checaPressaoGonza(jogo, estado, ladoAlvo, minutoAtual) {
  if (!minutoAtual || minutoAtual < 5) return null;
  const janela = janelaUltimos5(jogo, ladoAlvo, minutoAtual);
  // janela limpa: oponente em 0 nos 5 minutos inteiros
  if (!janela.every(j => j.oposto === 0)) return null;

  const media   = janela.reduce((s, j) => s + Math.abs(j.alvo), 0) / 5;
  const minutos = janela.map(j => j.minuto);
  const chutes  = (jogo.eventos || []).filter(e =>
    e.lado === ladoAlvo && minutos.includes(e.minuto) && e.tipo_evento.startsWith('chute')
  );
  const chuteGol = chutes.find(c => c.tipo_evento === 'chute_no_gol');

  if (media >= 136 && chuteGol) {
    const efNosso = getEficienciaPeriodoAtual(jogo, estado, ladoAlvo);
    if (efNosso >= 0.17) {
      return { tipo: 'completo', media: round2(media), minutoChute: chuteGol.minuto, eficiencia: round2(efNosso) };
    }
  }
  if (media >= 180) {
    return { tipo: 'sem_eficiencia', media: round2(media) };
  }
  return null;
}

// ── CONDIÇÃO DE SAÍDA/PROTEÇÃO — reação real do oponente ───────
function checaReacaoOponente(jogo, ladoOponente, minutoAtual) {
  if (!minutoAtual || minutoAtual < 5) return null;
  const janela  = janelaUltimos5(jogo, ladoOponente, minutoAtual); // .alvo = valor do oponente
  const minutos = janela.map(j => j.minuto);

  // 1) pico >=150 (módulo) + chute (no gol OU pra fora) no MESMO minuto
  for (const j of janela) {
    if (Math.abs(j.alvo) >= 150) {
      const chute = (jogo.eventos || []).find(e =>
        e.lado === ladoOponente && e.minuto === j.minuto &&
        (e.tipo_evento === 'chute_no_gol' || e.tipo_evento === 'chute_para_fora')
      );
      if (chute) return { tipo: 'momentum_forte', minuto: j.minuto, valor: j.alvo, chute: chute.tipo_evento };
    }
  }

  // 2) média dos 5 minutos (módulo) > 100
  const media = janela.reduce((s, j) => s + Math.abs(j.alvo), 0) / 5;
  if (media > 100) return { tipo: 'media_sustentada', media: round2(media) };

  // 3) 2 chutes (qualquer tipo) dentro da janela
  const chutesNaJanela = (jogo.eventos || []).filter(e =>
    e.lado === ladoOponente && minutos.includes(e.minuto) && e.tipo_evento.startsWith('chute')
  );
  if (chutesNaJanela.length >= 2) return { tipo: 'dois_chutes', qtd: chutesNaJanela.length };

  return null;
}

// ── JOGO ABERTO — os dois lados com pico+chute, perto no tempo ──
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
    case 'lay_0x1_ia':           return (ftH === 0 && ftA === 1) ? 'red' : 'green';
    case 'lay_1x0_ia':           return (ftH === 1 && ftA === 0) ? 'red' : 'green';
    case 'lay_0x2_manu':         return (ftH === 0 && ftA === 2) ? 'red' : 'green';
    case 'lay_0x3':               return (ftH === 0 && ftA === 3) ? 'red' : 'green';
    case 'lay_gol_visit':        return (ftA - ftH >= 4 && ftA > ftH) ? 'red' : 'green';
    case 'lay_gol_mand':         return (ftH - ftA >= 4 && ftH > ftA) ? 'red' : 'green';
    case 'favorito_ht_gonza':
    case 'lay_away_manu':
    case 'lay_manu4':            return ftA > ftH ? 'red' : 'green';
    case 'lay_xg':                return null;
    case 'back_favorito':
    case 'back_fav_ht':
    case 'back_gonza_xg':        return ftH > ftA ? 'green' : 'red';
    case 'recup_favorito':       return null;
    case 'over05':               return (htH === 0 && htA === 0) ? (tot > 0 ? 'green' : 'red') : 'nao_entra';
    case 'over15_ia':
    case 'felipe_over15':        return tot > 1 ? 'green' : 'red';
    case 'over25_ia':            return tot > 2 ? 'green' : 'red';
    case 'over05_ht':            return tot > 0 ? 'green' : 'red';
    case 'over15_ht':            return tot > 1 ? 'green' : 'red';
    case 'ambas_marcam':
    case 'am':
    case 'am_xg':                return (ftH > 0 && ftA > 0) ? 'green' : 'red';
    case 'ambas_marcam_xg':       return (ftH > 0 && ftA > 0) ? 'green' : 'red';
    case 'gol_no_final':         return (ftH + ftA) > (htH + htA) ? 'green' : 'red';
    case 'corr_lay_fav':
    case 'corr_lay_zebra':       return null;
    default:                     return tot > 0 ? 'green' : 'red';
  }
}

// ── DISPLAY NAMES ─────────────────────────────────────────────
const STRAT_DISPLAY = {
  back_favorito:        '🤖 Back Favorito',
  recup_favorito:       '🤖 Recuperação Favorito',
  gol_no_final:         '🤖 Gol no Final',
  over05_ht:            '🤖 Over 0.5 HT',
  over15_ht:            '🤖 Over 1.5 HT',
  over15_ia:            '🤖 Over 1.5',
  over25_ia:            '🤖 Over 2.5',
  ambas_marcam:         '🤖 Ambas Marcam',
  lay_0x1_ia:           '🤖 Lay Resultado 0x1',
  lay_1x0_ia:           '🤖 Lay Resultado 1x0',
  lay_gol_visit:        '🤖 Lay Goleada Visitante',
  lay_gol_mand:         '🤖 Lay Goleada Mandante',
  corr_lay_fav:         '🤖 Correção Lay Favorito',
  corr_lay_zebra:       '🤖 Correção Lay Zebra',
  favorito_ht_gonza:    '🔵 Favorito ht Gonza',
  felipe_over15:        '🟠 Felipe Over 1.5',
  lay_away_manu:        '⚪ Lay Away Manu',
  lay_manu4:            '⚪ Lay Manu 4',
  back_gonza_xg:        '🔵 Back Gonza com xG',
  lay_0x2_manu:         '🪗 Lay 0x2 Manu',
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
  'Recuperação Favorito':   'recup_favorito',
  'Gol no Final':           'gol_no_final',
  'Over 0.5 HT':            'over05_ht',
  'Over 1.5':               'over15_ia',
  'Over 2.5':               'over25_ia',
  'Ambas Marcam':           'ambas_marcam',
  'Lay Resultado 0x1':      'lay_0x1_ia',
  'Lay Resultado 1x0':      'lay_1x0_ia',
  'Lay Goleada Visitante':  'lay_gol_visit',
  'Lay Goleada Mandante':   'lay_gol_mand',
  'Correção Lay Favorito':  'corr_lay_fav',
  'Correção Lay Zebra':     'corr_lay_zebra',
};

const FILTRO_PARA_STRAT = {
  'Favorito ht Gonza':  'favorito_ht_gonza',
  'Felipe over 1.5':    'felipe_over15',
  'lay away Manu':      'lay_away_manu',
  'Lay Manu 4':         'lay_manu4',
  'back gonza com xg':  'back_gonza_xg',
  'lay 0x2 Manu':       'lay_0x2_manu',
  'lay 0x3':            'lay_0x3',
  'ambas marcam xg':    'ambas_marcam_xg',
};

const ESTRAT_PARA_STRAT = {
  'Over 0,5 Gonza':   'over05',
  'Lay xg':           'lay_xg',
  'ambas gonza':      'am',
  'ambos xg pro':     'am_xg',
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
      // CORREÇÃO: o array momentum vem pré-preenchido com ~92 entradas (1 a 90.5)
      // desde o INÍCIO do jogo, com os minutos futuros zerados — NÃO é incremental.
      // Por isso não podemos usar Math.max(momentum.minuto) para saber o minuto
      // atual do jogo; usamos o campo jogo.tempo diretamente.
      const tempoAtualNum = parseInt(jogo.tempo) || estado.ultimoMinuto || 0;
      if (jogo.tempo !== 'Intervalo' && tempoAtualNum > 0) {
        estado.ultimoMinuto = tempoAtualNum;
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

      // Salvar placar HT — usa os campos diretos da API (gols_casa_ht/gols_fora_ht).
      // Esses campos existem desde o início do jogo (zerados), então só os fixamos
      // quando o jogo já estiver de fato no intervalo ou depois dele.
      if (jogo.tempo === 'Intervalo' && !estado.htPlacar) {
        const htCasaApi = parseInt(jogo.gols_casa_ht);
        const htForaApi = parseInt(jogo.gols_fora_ht);
        estado.htPlacar = (!isNaN(htCasaApi) && !isNaN(htForaApi))
          ? `${htCasaApi}x${htForaApi}`
          : placarAtual; // fallback caso a API não envie os campos _ht nesse jogo
        estado.passouHT = true;
        console.log(`[HT] ${jogoId} → HT: ${estado.htPlacar}`);
      }
      // Se por algum motivo a API NUNCA reportar 'Intervalo' para esse jogo
      // (caso raro, ex: falha pontual de dados), usamos um threshold bem alto
      // (60min) como rede de segurança — isso nunca vai capturar acréscimos
      // normais do 1T (que ficam tipicamente entre 45-50min), evitando o bug
      // antigo de contar acréscimos como 2T.
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

      // Marca o minuto exato em que o 2T começou de verdade (primeiro tick
      // numérico após o intervalo) — usado pelos indicadores próprios
      // (Pressão Gonza) pra saber quando usar resumo_pressao['2_tempo']
      // (primeiros 10min do 2T) vs ult_10min (depois disso).
      if (estado.passouHT && estado.minutoInicio2T == null && jogo.tempo !== 'Intervalo') {
        const tNumInicio2T = parseInt(jogo.tempo) || 0;
        if (tNumInicio2T > 0) estado.minutoInicio2T = tNumInicio2T;
      }

      // ── Detectar pênaltis/prorrogação e congelar placar do tempo normal ──
      // NOTA: o campo 'periodo' não existe na API real — detecção feita só por
      // texto em 'tempo' (ex: pode vir como 'Penaltis', 'Prorrogação' em alguns casos).
      const tempoStr    = String(jogo.tempo   || '').toLowerCase();
      const ehPenaltisOuProrrogacao =
        tempoStr.includes('penalt') || tempoStr.includes('prorrog');
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
      await processarIndicadoresProprios(jogo, estado, jogoId, hoje);
      await processarEstadoGrupo1(jogo, estado, jogoId, hoje);
      await processarIndicadorGonzaUniversal(jogo, estado, jogoId, hoje);
    }

    // Persiste o estado live a cada ciclo — é o que permite sobreviver a um
    // restart do Railway sem perder mensagens ativas, placar do HT, etc.
    salvarArquivo(ESTADO_FILE, estadoLive);
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
  const tempo = jogo.tempo === 'Intervalo' ? 'HT' : (parseInt(jogo.tempo) || 0);
  const links = linksExchanges(estado.jogo?.urls_exchanges || {});
  const linksIndicador = linksExchanges(jogo.urls_exchanges || {});

  for (const [stratKey, info] of Object.entries(estado.msgIds || {})) {
    if (!info?.ids?.length) continue;
    // Estratégias do Grupo 1 têm sua própria máquina de estados — não
    // sobrescrever aqui, ela é tratada em processarEstadoGrupo1.
    if (info.grupo1Status) continue;

    if (info.indicadorTipo) {
      // Mensagens dos indicadores próprios (Pressão Gonza/Jogo Aberto):
      // mantém a linha do indicador (ou o último status, se já evoluiu —
      // ex: "oponente reagiu") e só atualiza o placar/minuto ao redor dela.
      const extras = (info.linhasExtras || []).join('\n');
      const conteudo = (info.ultimoStatusTexto || info.linhaIndicador || '') + (extras ? `\n${extras}` : '');
      const novoTexto = info.formatoSimplificado
        ? `${conteudo}\n⚽ <b>${jogo.mandante} x ${jogo.visitante}</b>\n⏱ ${tempo}' · 📊 ${placarAtual}`
        : montarMsgAlerta(
            `${STRAT_DISPLAY[stratKey] || stratKey}\n${conteudo}`, jogo,
            info.tempoAlerta, info.placarAlerta, `${placarAtual} · ${tempo}'`, linksIndicador
          );
      await editTelegram(info.ids, novoTexto);
      continue;
    }

    const display = STRAT_DISPLAY[stratKey] || stratKey;
    const extras = (info.linhasExtras || []).join('\n');
    const statusLinha = `📊 Placar atual: ${placarAtual} · ${tempo}'` + (extras ? `\n${extras}` : '');
    info.ultimoStatusTexto = statusLinha;
    const novoTexto = montarMsgAlerta(
      display, jogo, info.tempoAlerta, info.placarAlerta,
      `${placarAtual} · ${tempo}'`, links, statusLinha
    );
    await editTelegram(info.ids, novoTexto);
  }
}

// ── INDICADOR DO GONZA — universal, em qualquer jogo monitorado ──
// Sempre que a condição bater (raio dos dois times APÓS o último gol, índice
// >=15 ambos, eficiência um>=0.20 outro>0.10), adiciona uma linha extra em
// TODAS as mensagens ativas daquele jogo — sem nunca remover o que já tinha.
async function processarIndicadorGonzaUniversal(jogo, estado, jogoId, hoje) {
  if (jogo.tempo === 'Intervalo') return;
  const golsCasa = parseInt(jogo.gols_casa) || 0;
  const golsFora = parseInt(jogo.gols_fora) || 0;
  // Só faz sentido em jogo empatado (qualquer placar X-X)
  if (golsCasa !== golsFora) return;

  const jaPassouHT = !!estado.passouHT;
  const periodoAtual = jaPassouHT ? '2_tempo' : '1_tempo';
  const tempo = parseInt(jogo.tempo) || 0;

  if (!checaIndicadorGonza(jogo, estado, periodoAtual)) return;

  // Já marcamos esse período pra esse jogo? Não repete.
  const chaveIndicador = `indicadorGonza_${periodoAtual}`;
  if (estado[chaveIndicador]) return;
  estado[chaveIndicador] = true;

  const links = linksExchanges(jogo.urls_exchanges || {});
  const labelPeriodo = periodoAtual === '1_tempo' ? '1T' : '2T';

  for (const [stratKey, info] of Object.entries(estado.msgIds || {})) {
    if (!info?.ids?.length) continue;
    const display = STRAT_DISPLAY[stratKey] || stratKey;
    const linhaFixa = `${display}\n⚽ <b>${jogo.mandante} x ${jogo.visitante}</b>\n⏱ ${info.tempoAlerta}' · 📊 ${info.placarAlerta}\n─────────────────`;
    const statusAtual = info.ultimoStatusTexto || `📊 Placar atual: ${golsCasa}x${golsFora} · ${tempo}'`;
    const novoTexto = `${linhaFixa}\n${statusAtual}\n🪗 Indicador do Gonza (${labelPeriodo}, min ${tempo}) — jogo aberto!${links}`;
    await editTelegram(info.ids, novoTexto);
  }
}


// ════════════════════════════════════════════════════════════════
// ── ORQUESTRADOR — PRESSÃO GONZA & JOGO ABERTO ──────────────────
// ════════════════════════════════════════════════════════════════

// Estratégias de LADO (precisam que um time específico marque e o outro
// não) onde os indicadores próprios se aplicam. Ficam de fora: corr_lay_fav
// e corr_lay_zebra (janela de só 5min do próprio jogo, lógica legada
// diferente — não dá pra formar uma janela de momentum de 5min ali).
const LADO_STRATS_PROPRIOS = [
  'favorito_ht_gonza', 'lay_away_manu', 'lay_manu4', 'back_gonza_xg',
  'back_favorito', 'lay_xg', 'recup_favorito',
  'lay_0x1_ia', 'lay_1x0_ia', 'lay_0x2_manu', 'lay_0x3',
  'lay_gol_visit', 'lay_gol_mand',
];

// Estas 6 só existem (pela definição original, raio antigo) até o minuto 20
// — entrada por momento de fragilidade bem no início do jogo. O indicador
// próprio respeita o mesmo limite: não abre entrada nova depois do min 20,
// e também não participa da conversão pra Gol Limite no 2T (não faz sentido
// pra uma estratégia que é, por definição, só sobre os primeiros 20min).
const LADO_STRATS_LIMITE_MIN20 = [
  'lay_0x1_ia', 'lay_1x0_ia', 'lay_0x2_manu', 'lay_0x3', 'lay_gol_visit', 'lay_gol_mand',
];

// Estratégias de GOLS — Pressão Gonza aplicado a favor do favorito do jogo
// + Jogo Aberto como gatilho extra, somado ao que já existe (raio antigo).
const GOLS_STRATS_PROPRIOS = [
  'over05', 'over15_ia', 'over25_ia', 'ambas_marcam', 'ambas_marcam_xg',
  'am', 'am_xg', 'felipe_over15', 'gol_no_final', 'over05_ht',
];

// over05_ht só existe no 1T (por definição — é "HT", antes do intervalo).
// gol_no_final só existe no 2T, até o min 80 (mesma janela do raio antigo).
// As demais (over05, Grupo 5/6) valem nos dois períodos.
function periodoValidoParaGols(stratKey, is1T, is2T, tempoNum) {
  if (stratKey === 'over05_ht')   return is1T;
  if (stratKey === 'gol_no_final') return is2T && tempoNum <= 80;
  return true;
}

// Resolve qual lado é o "nosso" pra cada estratégia de lado (mesma lógica
// já usada em processarAlertasLive/processarEstadoGrupo1 pra cada uma).
function getLadoAlvoEstrategia(stratKey, jogo, hoje, pendJogo) {
  switch (stratKey) {
    case 'favorito_ht_gonza':
    case 'lay_away_manu':
    case 'lay_manu4':
    case 'back_gonza_xg':
    case 'lay_0x1_ia':
    case 'lay_0x2_manu':
    case 'lay_0x3':
    case 'lay_gol_visit':
      return 'casa';
    case 'lay_1x0_ia':
    case 'lay_gol_mand':
      return 'fora';
    case 'back_favorito':
    case 'recup_favorito':
      return getFavorito(jogo);
    case 'lay_xg': {
      const p = (pendJogo || []).find(x => x.strat === 'lay_xg');
      return p?.lay_team === 'home' ? 'casa' : 'fora';
    }
    default:
      return null;
  }
}

// Dispara um alerta novo usando os indicadores próprios (não duplica se já
// existir alerta dessa estratégia por qualquer caminho — raio antigo ou
// indicador novo). registrarComoEntradaReal=false → só observação, ainda
// não conta no resultado final (caso do "Pressão Gonza sem eficiência").
async function dispararIndicadorProprio(jogo, estado, stratKey, linhaIndicador, indicadorTipo, registrarComoEntradaReal, formatoSimplificado = false) {
  if (estado.msgIds[stratKey]) return false;

  const tempoNum     = parseInt(jogo.tempo) || estado.ultimoMinuto || 0;
  const isHTAgora     = jogo.tempo === 'Intervalo';
  const tempoDisplay = isHTAgora ? 'HT' : tempoNum;
  const golsCasa = parseInt(jogo.gols_casa) || 0, golsFora = parseInt(jogo.gols_fora) || 0;
  const placar   = `${golsCasa}x${golsFora}`;
  const links    = linksExchanges(jogo.urls_exchanges || {});
  const display  = STRAT_DISPLAY[stratKey] || stratKey;

  const textoCompleto = formatoSimplificado
    ? `${linhaIndicador}\n⚽ <b>${jogo.mandante} x ${jogo.visitante}</b>\n⏱ ${tempoDisplay}' · 📊 ${placar}`
    : montarMsgAlerta(`${display}\n${linhaIndicador}`, jogo, tempoDisplay, placar, placar, links);

  const ids = await sendTelegram(textoCompleto);

  // Marca de uma vez o "slot" do período em que essa entrada aconteceu,
  // pra reconfirmação (checarReconfirmacao) não duplicar a mesma janela
  // como se fosse uma reconfirmação nova no mesmo período.
  const slotEntrada = estado.passouHT ? '2T' : '1T';
  const notados = { pg1T: false, pg2T: false, ja1T: false, ja2T: false };
  if (indicadorTipo === 'pressao_completo' || indicadorTipo === 'pressao_sem_eficiencia') notados['pg' + slotEntrada] = true;
  else if (indicadorTipo === 'jogo_aberto') notados['ja' + slotEntrada] = true;

  estado.msgIds[stratKey] = {
    ids, placarAlerta: placar, tempoAlerta: tempoDisplay, stratKey,
    indicadorTipo, formatoSimplificado, linhaIndicador, notados,
  };

  if (registrarComoEntradaReal) {
    const pendLive = registrarPendente({ ...jogo }, `${stratKey}_live`, 'live');
    pendLive.condicao = indicadorTipo;
    pendLive.msgIds   = ids;
    salvarArquivo(PEND_FILE, pendentes);
  }
  return true;
}

// Monitora uma estratégia de LADO já alertada (por qualquer caminho):
// 1) upgrade de "sem eficiência" pra "completo" (registra a entrada real
//    só nesse momento); 2) reação do oponente (aviso de saída/proteção);
// 3) cartão vermelho nosso (saída imediata).
async function atualizarIndicadorProprio(jogo, estado, stratKey, ladoAlvo) {
  const info = estado.msgIds[stratKey];
  if (!info || !info.ids?.length) return;
  if (jogo.tempo === 'Intervalo') return; // não recalcula janela de momentum no intervalo
  if (info.grupo1Status === 'green' || info.grupo1Status === 'red' ||
      info.grupo1Status === 'red_reacao' || info.grupo1Status === 'red_gonza') return;

  const tempoNum = parseInt(jogo.tempo) || estado.ultimoMinuto || 0;
  const links    = linksExchanges(jogo.urls_exchanges || {});
  const fixo     = `${STRAT_DISPLAY[stratKey] || stratKey}\n⚽ <b>${jogo.mandante} x ${jogo.visitante}</b>\n⏱ ${info.tempoAlerta}' · 📊 ${info.placarAlerta}\n─────────────────`;

  // 1) Upgrade "sem eficiência" → "completo" (só se foi nosso indicador que disparou)
  if (info.indicadorTipo === 'pressao_sem_eficiencia' && !info.pressaoConfirmada) {
    const pg = checaPressaoGonza(jogo, estado, ladoAlvo, tempoNum);
    if (pg && pg.tipo === 'completo') {
      info.pressaoConfirmada = true;
      const pendLive = registrarPendente({ ...jogo }, `${stratKey}_live`, 'live');
      pendLive.condicao = 'pressao_gonza_confirmada';
      pendLive.msgIds   = info.ids;
      salvarArquivo(PEND_FILE, pendentes);
      const statusTexto = `🟣 Pressão Gonza confirmada — chute no gol min ${pg.minutoChute}\n✅ Entrada confirmada`;
      info.ultimoStatusTexto = statusTexto;
      await editTelegram(info.ids, `${fixo}\n${statusTexto}${links}`);
    }
    return; // não checa saída no mesmo ciclo em que acabou de confirmar (ou ainda não confirmou)
  }

  if (!ladoAlvo) return; // estratégia de gols não tem "saída" pra monitorar aqui

  // 2) Reação do oponente — aviso de saída/proteção (só 1x por jogo)
  if (!info.saidaAvisada) {
    const ladoOp  = ladoOposto(ladoAlvo);
    const reacao  = checaReacaoOponente(jogo, ladoOp, tempoNum);
    if (reacao) {
      info.saidaAvisada = true;
      let descricao;
      if (reacao.tipo === 'momentum_forte') {
        descricao = `momentum ${reacao.valor} + ${reacao.chute === 'chute_no_gol' ? 'chute no gol' : 'chute pra fora'} (min ${reacao.minuto})`;
      } else if (reacao.tipo === 'media_sustentada') {
        descricao = `média ${reacao.media} sustentada nos últ. 5min`;
      } else {
        descricao = `${reacao.qtd} chutes nos últ. 5min`;
      }
      const statusBase = info.ultimoStatusTexto || `📊 Placar atual: ${jogo.gols_casa}x${jogo.gols_fora}`;
      const statusTexto = `${statusBase}\n⚠️ Oponente reagiu — ${descricao}\n⚠️ Considerar proteção/saída`;
      info.ultimoStatusTexto = statusTexto;
      await editTelegram(info.ids, `${fixo}\n${statusTexto}${links}`);
      return;
    }
  }

  // 3) Cartão vermelho do nosso lado — saída imediata, sempre
  if (!info.cartaoVermelhoAvisado) {
    const vermelho = (jogo.eventos || []).find(e => e.tipo_evento === 'cartao_vermelho' && e.lado === ladoAlvo);
    if (vermelho) {
      info.cartaoVermelhoAvisado = true;
      const statusTexto = `🔴 Cartão vermelho nosso (min ${vermelho.minuto})\n⚠️ Saída recomendada`;
      info.ultimoStatusTexto = statusTexto;
      await editTelegram(info.ids, `${fixo}\n${statusTexto}${links}`);
    }
  }
}

// Reconfirmação dos indicadores — vale pra QUALQUER estratégia já alertada
// (lado ou gols, por raio antigo ou pelos nossos indicadores). No máximo
// 1 nota por indicador (Pressão Gonza / Jogo Aberto) POR PERÍODO (1T/2T) —
// ou seja, no máximo 2 notas de cada um no jogo inteiro. Nunca duplica
// alerta nem re-registra pendente — só acrescenta uma linha na mensagem.
async function checarReconfirmacao(jogo, estado, stratKey, ladoOuFavorito, hoje) {
  const info = estado.msgIds[stratKey];
  if (!info?.ids?.length) return;
  if (jogo.tempo === 'Intervalo') return;
  if (info.golLimiteConversao) return; // mensagem terminal/simplificada, sem reconfirmação
  if (info.grupo1Status === 'green' || info.grupo1Status === 'red' ||
      info.grupo1Status === 'red_reacao' || info.grupo1Status === 'red_gonza') return;

  const tempoNum = parseInt(jogo.tempo) || 0;
  const slot     = estado.passouHT ? '2T' : '1T';
  info.notados = info.notados || { pg1T: false, pg2T: false, ja1T: false, ja2T: false };

  let linhaNova = null;

  if (!info.notados['pg' + slot]) {
    let pg = checaPressaoGonza(jogo, estado, ladoOuFavorito, tempoNum);
    let rotuloLado = '';
    if (stratKey === 'gol_no_final') {
      const pgZebra = checaPressaoGonza(jogo, estado, ladoOposto(ladoOuFavorito), tempoNum);
      if (pg?.tipo !== 'completo' && pgZebra?.tipo === 'completo') { pg = pgZebra; rotuloLado = ' (zebra)'; }
    }
    if (pg) {
      info.notados['pg' + slot] = true;
      linhaNova = pg.tipo === 'completo'
        ? `🟣 Pressão Gonza${rotuloLado} reconfirmou (${slot}) — média ${pg.media}, chute no gol min ${pg.minutoChute}`
        : `🟣 Pressão Gonza sem eficiência${rotuloLado} reconfirmou (${slot}) — média ${pg.media}`;
    }
  }

  if (!linhaNova && !info.notados['ja' + slot]) {
    const ja = checaJogoAberto(jogo, tempoNum);
    if (ja) {
      info.notados['ja' + slot] = true;
      linhaNova = `🟠 Jogo Aberto reconfirmou (${slot}) — os dois lados reagindo (min ${ja.minCasa}-${ja.minFora})`;
    }
  }
  if (!linhaNova) return;

  info.linhasExtras = info.linhasExtras || [];
  info.linhasExtras.push(linhaNova);

  const links   = linksExchanges(jogo.urls_exchanges || {});
  const placar  = `${jogo.gols_casa}x${jogo.gols_fora}`;
  const extras  = info.linhasExtras.join('\n');

  if (info.indicadorTipo) {
    const conteudo = (info.ultimoStatusTexto || info.linhaIndicador || '') + `\n${extras}`;
    const novoTexto = info.formatoSimplificado
      ? `${conteudo}\n⚽ <b>${jogo.mandante} x ${jogo.visitante}</b>\n⏱ ${tempoNum}' · 📊 ${placar}`
      : montarMsgAlerta(`${STRAT_DISPLAY[stratKey] || stratKey}\n${conteudo}`, jogo, info.tempoAlerta, info.placarAlerta, `${placar} · ${tempoNum}'`, links);
    await editTelegram(info.ids, novoTexto);
  } else {
    const statusLinha = `📊 Placar atual: ${placar} · ${tempoNum}'\n${extras}`;
    info.ultimoStatusTexto = statusLinha;
    const novoTexto = montarMsgAlerta(STRAT_DISPLAY[stratKey] || stratKey, jogo, info.tempoAlerta, info.placarAlerta, `${placar} · ${tempoNum}'`, links, statusLinha);
    await editTelegram(info.ids, novoTexto);
  }
}

// Orquestrador principal — chamado a cada ciclo (90s) pra todo jogo live.
async function processarIndicadoresProprios(jogo, estado, jogoId, hoje) {
  if (jogo.tempo === 'Intervalo' || jogo.tempo === 'Encerrado') return;
  const tempoNum   = parseInt(jogo.tempo) || 0;
  const jaPassouHT = !!estado.passouHT;
  const is1T       = !jaPassouHT;
  const is2T       = jaPassouHT;
  const favorito   = getFavorito(jogo);

  const pendJogo = pendentes.filter(p =>
    p.data === hoje && p.result === 'pendente' &&
    (p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`)
  );

  // ── ESTRATÉGIAS DE LADO ──────────────────────────────────────
  for (const stratKey of LADO_STRATS_PROPRIOS) {
    if (!pendJogo.some(p => p.strat === stratKey)) continue;
    const ladoAlvo = getLadoAlvoEstrategia(stratKey, jogo, hoje, pendJogo);
    if (!ladoAlvo) continue; // ex: lay_xg sem lay_team definido ainda

    if (!estado.msgIds[stratKey]) {
      const limitadaMin20 = LADO_STRATS_LIMITE_MIN20.includes(stratKey);
      if (is1T && (!limitadaMin20 || tempoNum <= 20)) {
        // 1º Tempo: dispara normal (Pressão Gonza). Jogo Aberto aqui é só
        // sinal de atenção pra quem JÁ entrou — não dispara entrada nova.
        const pg = checaPressaoGonza(jogo, estado, ladoAlvo, tempoNum);
        if (pg) {
          if (pg.tipo === 'completo') {
            await dispararIndicadorProprio(jogo, estado, stratKey,
              `🟣 Pressão Gonza — média ${pg.media}, chute no gol min ${pg.minutoChute}`,
              'pressao_completo', true);
          } else {
            await dispararIndicadorProprio(jogo, estado, stratKey,
              `🟣 Pressão Gonza sem eficiência — média ${pg.media} (aguardando chute no gol)`,
              'pressao_sem_eficiencia', false);
          }
        }
      } else if (is2T && !limitadaMin20) {
        // 2º Tempo: se qualquer um dos dois indicadores bater, não entra
        // mais em lado — converte direto pra Gol Limite (mensagem simples).
        // (As 6 estratégias "até min 20" ficam de fora dessa conversão —
        // são definidas só pelos primeiros 20min, não tem Gol Limite pra elas.)
        const pg = checaPressaoGonza(jogo, estado, ladoAlvo, tempoNum);
        const ja = checaJogoAberto(jogo, tempoNum);
        if (pg && pg.tipo === 'completo') {
          if (await dispararIndicadorProprio(jogo, estado, stratKey,
              '🟢 Indicador Pressão Gonza Confirmado', 'gol_limite_pressao', false, true)) {
            const pendLive = registrarPendente({ ...jogo }, `${stratKey}_live`, 'live');
            pendLive.condicao = 'gol_limite_pressao';
            pendLive.golLimiteConversao = true;
            pendLive.placarNaConversao  = `${jogo.gols_casa}x${jogo.gols_fora}`;
            pendLive.msgIds = estado.msgIds[stratKey].ids;
            salvarArquivo(PEND_FILE, pendentes);
            estado.msgIds[stratKey].golLimiteConversao = true;
          }
        } else if (ja) {
          if (await dispararIndicadorProprio(jogo, estado, stratKey,
              '🟡 Indicador Jogo Aberto Confirmado', 'gol_limite_jogo_aberto', false, true)) {
            const pendLive = registrarPendente({ ...jogo }, `${stratKey}_live`, 'live');
            pendLive.condicao = 'gol_limite_jogo_aberto';
            pendLive.golLimiteConversao = true;
            pendLive.placarNaConversao  = `${jogo.gols_casa}x${jogo.gols_fora}`;
            pendLive.msgIds = estado.msgIds[stratKey].ids;
            salvarArquivo(PEND_FILE, pendentes);
            estado.msgIds[stratKey].golLimiteConversao = true;
          }
        }
      }
    } else {
      // Já alertado (por qualquer caminho) — monitora upgrade/saída/cartão
      // + reconfirmação por período (máx 1 por indicador por tempo).
      await atualizarIndicadorProprio(jogo, estado, stratKey, ladoAlvo);
      await checarReconfirmacao(jogo, estado, stratKey, ladoAlvo, hoje);
    }
  }

  // ── ESTRATÉGIAS DE GOLS ───────────────────────────────────────
  for (const stratKey of GOLS_STRATS_PROPRIOS) {
    if (!pendJogo.some(p => p.strat === stratKey)) continue;
    if (!periodoValidoParaGols(stratKey, is1T, is2T, tempoNum)) continue;

    if (estado.msgIds[stratKey]) {
      // Já alertado (raio antigo ou nosso indicador) — reconfirmação por
      // período (máx 1 por indicador por tempo), igual ao lado.
      await checarReconfirmacao(jogo, estado, stratKey, favorito, hoje);
      continue;
    }

    // Gol no Final é simétrico por definição (índice dos dois lados,
    // eficiência de QUALQUER um deles) — então o Pressão Gonza também
    // checa os dois lados aqui, não só o favorito. As outras estratégias
    // de gols continuam só a favor do favorito, como definido.
    const ladoZebra  = ladoOposto(favorito);
    const pgFavorito = checaPressaoGonza(jogo, estado, favorito, tempoNum);
    const pgZebra    = (stratKey === 'gol_no_final') ? checaPressaoGonza(jogo, estado, ladoZebra, tempoNum) : null;

    let pg = pgFavorito, rotuloLado = '(favorito)';
    if (pgFavorito?.tipo !== 'completo' && pgZebra?.tipo === 'completo') {
      pg = pgZebra; rotuloLado = '(zebra)';
    } else if (!pgFavorito && pgZebra) {
      pg = pgZebra; rotuloLado = '(zebra)';
    }

    const ja = checaJogoAberto(jogo, tempoNum);
    const golLimiteTxt = is2T ? ' (Gol Limite)' : '';

    if (pg && pg.tipo === 'completo') {
      await dispararIndicadorProprio(jogo, estado, stratKey,
        `🟣 Pressão Gonza ${rotuloLado} — média ${pg.media}, chute no gol min ${pg.minutoChute}${golLimiteTxt}`,
        'pressao_completo', true);
    } else if (ja) {
      await dispararIndicadorProprio(jogo, estado, stratKey,
        `🟠 Jogo Aberto — os dois lados reagindo (min ${ja.minCasa}-${ja.minFora})${golLimiteTxt}`,
        'jogo_aberto', true);
    } else if (pg && pg.tipo === 'sem_eficiencia') {
      await dispararIndicadorProprio(jogo, estado, stratKey,
        `🟣 Pressão Gonza ${rotuloLado} sem eficiência — média ${pg.media} (aguardando chute no gol)${golLimiteTxt}`,
        'pressao_sem_eficiencia', false);
    }
  }
}

// Estados possíveis (info.grupo1Status):
//   null/undefined → ainda não tomou gol, monitorando normalmente
//   'green'        → mandante marcou primeiro, encerrado
//   'atencao'      → visitante na frente, avaliando reação até o min 60
//   'reacao'       → reação confirmada, considerar lay contra visitante
//   'red'          → chegou no min 60 sem reação, encerrado em RED
//   'red_reacao'   → depois do RED, reação ainda confirmou (Gol Limite)
//   'red_gonza'    → depois do RED, Indicador do Gonza apareceu (Gol Limite)
const GRUPO1_STRATS = ['favorito_ht_gonza','lay_away_manu','lay_manu4','back_gonza_xg','back_favorito','lay_xg'];

async function processarEstadoGrupo1(jogo, estado, jogoId, hoje) {
  const golsCasa = parseInt(jogo.gols_casa) || 0;
  const golsFora = parseInt(jogo.gols_fora) || 0;
  const tempo     = jogo.tempo === 'Intervalo' ? (estado.ultimoMinuto || 45) : (parseInt(jogo.tempo) || 0);
  const isHT      = jogo.tempo === 'Intervalo';
  const jaPassouHT = !!estado.passouHT;
  const links     = linksExchanges(jogo.urls_exchanges || {});
  const favorito  = getFavorito(jogo);

  for (const stratKey of GRUPO1_STRATS) {
    const info = estado.msgIds[stratKey];
    if (!info || !info.ids?.length) continue;
    if (info.grupo1Status === 'green' || info.grupo1Status === 'red_reacao' || info.grupo1Status === 'red_gonza') continue; // já fechado

    // Determina o lado alvo (mandante fixo, ou favorito dinâmico, ou lay_team manual)
    let alvo = 'casa';
    if (stratKey === 'back_favorito') alvo = favorito;
    if (stratKey === 'lay_xg') {
      const pendLayXg = pendentes.find(p => p.condicao === 'lay_xg' && p.data === hoje &&
        (p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`));
      alvo = pendLayXg?.lay_team === 'home' ? 'casa' : 'fora';
    }
    const alvoGols = alvo === 'casa' ? golsCasa : golsFora;
    const contraGols = alvo === 'casa' ? golsFora : golsCasa;

    const display = STRAT_DISPLAY[stratKey] || stratKey;
    const fixo = `${display}\n⚽ <b>${jogo.mandante} x ${jogo.visitante}</b>\n⏱ ${info.tempoAlerta}' · 📊 ${info.placarAlerta}\n─────────────────`;

    // Estado inicial: ainda sem gol decidido
    if (!info.grupo1Status) {
      if (alvoGols > contraGols) {
        // Alvo marcou primeiro → GREEN, encerra
        info.grupo1Status = 'green';
        await editTelegram(info.ids, `${fixo}\n✅ GREEN · ${golsCasa}x${golsFora} (min ${tempo})${links}`);
      } else if (contraGols > alvoGols) {
        // Time contra marcou → modo atenção
        info.grupo1Status = 'atencao';
        info.minutoGolContra = tempo;
        await editTelegram(info.ids, `${fixo}\n⚠️ Time contra na frente (${golsCasa}x${golsFora}, min ${tempo}) — avaliar reação${links}`);
      }
      continue;
    }

    // Estado "atenção" — monitora reação até o minuto 60
    if (info.grupo1Status === 'atencao') {
      if (alvoGols > contraGols) {
        info.grupo1Status = 'green';
        await editTelegram(info.ids, `${fixo}\n✅ GREEN · ${golsCasa}x${golsFora} (min ${tempo})${links}`);
        continue;
      }
      if (tempo > 60 && !isHT) {
        info.grupo1Status = 'red';
        await editTelegram(info.ids, `${fixo}\n❌ RED · ${golsCasa}x${golsFora} (min 60) — sem reação confirmada${links}`);
        continue;
      }
      // Checa reação (últimos 10min)
      if (checaCondicaoReacao(jogo, alvo)) {
        const raioNovoAlvo = (jogo.eventos || []).some(e =>
          e.tipo_evento === 'raio' && e.lado === alvo && e.minuto > (info.minutoGolContra || 0)
        );
        if (raioNovoAlvo) {
          info.grupo1Status = 'reacao';
          await editTelegram(info.ids, `${fixo}\n🔄 Reação confirmada (min ${tempo}) — considerar Lay contra o time da frente até o fim do 1T${links}`);
        }
      }
      continue;
    }

    // Estado "reacao" — já confirmado, só falta o fim de jogo decidir (tratado em processarFimDeJogo)
    if (info.grupo1Status === 'reacao') continue;

    // Estado "red" — depois do RED no min 60, monitora reação atrasada ou Indicador do Gonza
    if (info.grupo1Status === 'red') {
      const periodoAtual = jaPassouHT ? '2_tempo' : '1_tempo';
      if (checaCondicaoReacao(jogo, alvo)) {
        const raioNovoAlvo = (jogo.eventos || []).some(e =>
          e.tipo_evento === 'raio' && e.lado === alvo && e.minuto > 60
        );
        if (raioNovoAlvo) {
          info.grupo1Status = 'red_reacao';
          await editTelegram(info.ids, `${fixo}\n❌ RED · ${golsCasa}x${golsFora} (min 60)\n🔄 Reação confirmada (${tempo}') — avaliar Gol Limite${links}`);
          continue;
        }
      }
      if (checaIndicadorGonza(jogo, estado, periodoAtual)) {
        info.grupo1Status = 'red_gonza';
        await editTelegram(info.ids, `${fixo}\n❌ RED · ${golsCasa}x${golsFora} (min 60)\n🪗 Indicador do Gonza (${tempo}') — avaliar Gol Limite${links}`);
      }
    }
  }
}

// ── Alertas live ──────────────────────────────────────────────
async function processarAlertasLive(jogo, estado, jogoId, hoje) {
  const tempoNum = parseInt(jogo.tempo) || 0;
  const ehIntervalo = jogo.tempo === 'Intervalo';
  // tempo: usado nas condições numéricas (<=20, etc) — fica 0 no intervalo, igual antes
  const tempo    = tempoNum;
  // tempoDisplay: usado só para exibição na mensagem — mostra "HT" no intervalo
  const tempoDisplay = ehIntervalo ? 'HT' : tempoNum;
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
  // CORREÇÃO CRÍTICA: o campo 'periodo' NÃO EXISTE na API real (confirmado em
  // teste ao vivo em 22/06/2026) — a lógica antiga dependia de um campo que
  // nunca chegou a vir preenchido, causando bugs silenciosos (ex: Gol no Final
  // nunca disparando). Agora usamos apenas o histórico do próprio jogo
  // (estado.passouHT, setado quando detectamos 'Intervalo' ou tempo > 45min)
  // como sinal confiável de que estamos no 2º tempo.
  const jaPassouHT = !!estado.passouHT;
  const is2T = !isHT && jaPassouHT;
  const is1T = !isHT && !jaPassouHT;

  const evNovos   = jogo.eventos || [];
  // CORREÇÃO: antes contava QUALQUER raio do jogo inteiro (cumulativo), então
  // um raio do 1T ficava "travado" como true pro resto do jogo todo, mesmo
  // já estando no 2T há muito tempo. Agora só conta raio do período ATUAL
  // (mesma lógica já usada com sucesso em raiosCasa2T/raiosFora2T abaixo).
  const periodoAtualRaio = jaPassouHT ? '2_tempo' : '1_tempo';
  const raiosCasa = evNovos.filter(e => e.tipo_evento === 'raio' && e.lado === 'casa' && e.periodo === periodoAtualRaio);
  const raiosFora = evNovos.filter(e => e.tipo_evento === 'raio' && e.lado === 'fora' && e.periodo === periodoAtualRaio);
  const raioFav   = favorito === 'casa' ? raiosCasa.length > 0 : raiosFora.length > 0;
  const raioZebra = favorito === 'casa' ? raiosFora.length > 0 : raiosCasa.length > 0;
  const raioMand  = raiosCasa.length > 0;
  const raioVisit = raiosFora.length > 0;
  const temRaio   = raioMand || raioVisit;

  // Raio confirmado no 2º tempo REAL — usa o campo 'periodo' de cada evento
  // individual (existe e é confiável), em vez de inferir do estado geral do
  // jogo. Isso garante precisão mesmo durante os acréscimos do 1T.
  const raiosCasa2T = evNovos.filter(e => e.tipo_evento === 'raio' && e.lado === 'casa' && e.periodo === '2_tempo');
  const raiosFora2T = evNovos.filter(e => e.tipo_evento === 'raio' && e.lado === 'fora' && e.periodo === '2_tempo');
  const temRaio2T    = raiosCasa2T.length > 0 || raiosFora2T.length > 0;

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
      display + linhaInfo, jogo, tempoDisplay, placar, placar, links
    );

    const ids = await sendTelegram(textoCompleto);

    estado.msgIds[stratKey] = {
      ids,
      placarAlerta: placar,
      tempoAlerta:  tempoDisplay,
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

  // 1. BACK FAVORITO — segue o lado do favorito (casa ou fora)
  if (pendJogo.some(p => p.strat === 'back_favorito')) {
    const periodoAtual = isHT ? null : (jaPassouHT ? '2_tempo' : '1_tempo');
    const minuteLimite2T = 60;
    const favPerdendo = (favorito==='casa' && golsFora-golsCasa===1) || (favorito==='fora' && golsCasa-golsFora===1);

    if (!isHT && periodoAtual) {
      // 0x0 — condição padrão do Grupo 1 no período atual + raio do favorito
      if (total === 0 && raioFav && checaCondicaoGrupo1(jogo, periodoAtual, favorito))
        await alertar('back_favorito', `0x0 + Raio do Favorito! (${periodoAtual==='1_tempo'?'1T':'2T'})`, 'back_favorito_live');

      // Favorito perdendo por 1 — condição de reação (últimos 10min) + raio do favorito
      else if (favPerdendo && raioFav && checaCondicaoReacao(jogo, favorito)) {
        const limiteMin = periodoAtual === '1_tempo' ? 999 : minuteLimite2T; // 1T sempre vale; 2T só até o min 60
        if (tempo <= limiteMin)
          await alertar('back_favorito', 'Favorito perdendo + Reação confirmada (Raio)!', 'back_favorito_live');
      }
    }
  }

  // 2. RECUPERAÇÃO FAVORITO — mesma lógica de reação do Back Favorito, só 1T
  if (pendJogo.some(p => p.strat === 'recup_favorito')) {
    const favPerdendo1 = (favorito==='casa' && golsFora-golsCasa===1) || (favorito==='fora' && golsCasa-golsFora===1);
    if (!isHT && !jaPassouHT && favPerdendo1 && raioFav && checaCondicaoReacao(jogo, favorito))
      await alertar('recup_favorito', 'Favorito perdendo por 1 + Reação confirmada (Raio)!', 'recup_favorito_live');
  }

  // 3. GOL NO FINAL — raio confirmado no 2T + índices (pressão/eficiência) do
  // Indicador do Gonza nos últimos 10min. Vale na hora do raio ou depois dele
  // (enquanto o gol não saiu), até no máximo o minuto 80.
  if (pendJogo.some(p => p.strat === 'gol_no_final')) {
    if (temRaio2T && tempo <= 80) {
      const ind = getIndicadores(jogo, 'ult_10min');
      const idxOk = ind.idxCasa >= 15 && ind.idxFora >= 15;
      const efOk  = (ind.efCasa >= 0.20 && ind.efFora > 0.10) || (ind.efFora >= 0.20 && ind.efCasa > 0.10);
      if (idxOk && efOk)
        await alertar('gol_no_final', 'Raio no 2T + índices do Indicador do Gonza (últ. 10min)!', 'gol_no_final_live');
    }
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

  // ── GRUPO 5/6 — OVER GOLS E AMBAS MARCAM (lógica unificada) ──
  // 0x0 até min 60: usa o Indicador do Gonza completo (raio dos 2 + índices)
  // 1x0/0x1: precisa do raio do time que está atrás + índices do Indicador do Gonza
  function processarGrupo5e6(stratKey, nomeDisplay) {
    return (async () => {
      if (!pendJogo.some(p => p.strat === stratKey)) return;
      if (isHT) return;
      const periodoAtual = jaPassouHT ? '2_tempo' : '1_tempo';

      // 1º TEMPO + 0x0 → exige Indicador completo (2 raios, período inteiro do 1T).
      // Isso confirma que o jogo está realmente aberto pelos dois lados antes de entrar.
      if (total === 0 && periodoAtual === '1_tempo' && checaIndicadorGonza(jogo, estado, periodoAtual)) {
        await alertar(stratKey, `Indicador do Gonza 🪗 (1T) — jogo aberto!`, `${stratKey}_live`);
        return;
      }

      // QUALQUER OUTRA SITUAÇÃO (já saiu gol, OU 2T mesmo com 0x0) → só 1 raio
      // (de qualquer time) + esse time precisa ter índice>=20 e eficiência>=0.20
      // nos últimos 10min — sem importar o time da frente, pois qualquer gol qualifica.
      const raioCasaAgora = raioMand;
      const raioForaAgora = raioVisit;
      if (raioCasaAgora || raioForaAgora) {
        const ind = getIndicadores(jogo, 'ult_10min');
        const ladoDoRaio = raioCasaAgora ? 'casa' : 'fora';
        const idxRaio = ladoDoRaio === 'casa' ? ind.idxCasa : ind.idxFora;
        const efRaio  = ladoDoRaio === 'casa' ? ind.efCasa  : ind.efFora;
        if (idxRaio >= 20 && efRaio >= 0.20)
          await alertar(stratKey, `${placar} + Raio (últ. 10min, índice≥20/eficiência≥0.20) — Gol Limite!`, `${stratKey}_live`);
      }
    })();
  }

  await processarGrupo5e6('over15_ia', 'Over 1.5');
  await processarGrupo5e6('over25_ia', 'Over 2.5');
  await processarGrupo5e6('ambas_marcam', 'Ambas Marcam');
  await processarGrupo5e6('ambas_marcam_xg', 'Ambas Marcam xG');
  await processarGrupo5e6('am', 'Ambas Gonza');
  await processarGrupo5e6('am_xg', 'Ambos xG Pro');
  await processarGrupo5e6('felipe_over15', 'Felipe Over 1.5');

  // 8. LAY 0x1 (IA) — 1 alerta por jogo, até min 20, lay contra visitante
  // (condição espelhada do Grupo 1: mandante precisa estar dominando)
  if (pendJogo.some(p => p.strat === 'lay_0x1_ia')) {
    if (tempo <= 20 && !isHT) {
      const periodoAtual = jaPassouHT ? '2_tempo' : '1_tempo';
      if (raioMand && total === 0 && checaCondicaoGrupo1(jogo, periodoAtual, 'casa'))
        await alertar('lay_0x1_ia', '0x0 + Raio do Mandante (até min 20)!', 'lay_0x1_ia_live');
      else if (raioMand && golsCasa === 0 && golsFora === 1)
        await alertar('lay_0x1_ia', '⚠️ Placar 0x1! Raio Mandante — feche e aguarde!', 'lay_0x1_ia_live');
    }
  }

  // 9. LAY 1x0 (IA) — 1 alerta por jogo, até min 20, lay contra mandante
  // (condição espelhada do Grupo 1: visitante precisa estar dominando)
  if (pendJogo.some(p => p.strat === 'lay_1x0_ia')) {
    if (tempo <= 20 && !isHT) {
      const periodoAtual = jaPassouHT ? '2_tempo' : '1_tempo';
      if (raioVisit && total === 0 && checaCondicaoGrupo1(jogo, periodoAtual, 'fora'))
        await alertar('lay_1x0_ia', '0x0 + Raio do Visitante (até min 20)!', 'lay_1x0_ia_live');
      else if (raioVisit && golsCasa === 1 && golsFora === 0)
        await alertar('lay_1x0_ia', '⚠️ Placar 1x0! Raio Visitante — feche e aguarde!', 'lay_1x0_ia_live');
    }
  }

  // 10. LAY GOLEADA VISITANTE — até min 20, lay contra visitante (mandante dominando)
  if (pendJogo.some(p => p.strat === 'lay_gol_visit')) {
    if (tempo <= 20 && !isHT) {
      const periodoAtual = jaPassouHT ? '2_tempo' : '1_tempo';
      if (raioMand && checaCondicaoGrupo1(jogo, periodoAtual, 'casa'))
        await alertar('lay_gol_visit', 'Raio do Mandante (até min 20)!', 'lay_gol_visit_live');
    }
  }

  // 11. LAY GOLEADA MANDANTE — até min 20, lay contra mandante (visitante dominando)
  if (pendJogo.some(p => p.strat === 'lay_gol_mand')) {
    if (tempo <= 20 && !isHT) {
      const periodoAtual = jaPassouHT ? '2_tempo' : '1_tempo';
      if (raioVisit && checaCondicaoGrupo1(jogo, periodoAtual, 'fora'))
        await alertar('lay_gol_mand', 'Raio do Visitante (até min 20)!', 'lay_gol_mand_live');
    }
  }

  // 12. CORREÇÃO LAY FAVORITO
  if (pendJogo.some(p => p.strat === 'corr_lay_fav')) {
    if (tempo <= 5 && !isHT && raioZebra)
      await alertar('corr_lay_fav', `Raio da Zebra no min ${tempo}!`, 'corr_lay_fav_live');
  }

  // 13. CORREÇÃO LAY ZEBRA
  if (pendJogo.some(p => p.strat === 'corr_lay_zebra')) {
    if (tempo <= 5 && !isHT && raioFav)
      await alertar('corr_lay_zebra', `Raio do Favorito no min ${tempo}!`, 'corr_lay_zebra_live');
  }

  // ── FILTROS ───────────────────────────────────────────────

  // ── GRUPO 1 — fixos no mandante: FAVORITO HT GONZA / LAY AWAY MANU / LAY MANU 4 / BACK GONZA xG
  for (const sf of ['favorito_ht_gonza','lay_away_manu','lay_manu4','back_gonza_xg']) {
    if (!pendJogo.some(p => p.strat === sf)) continue;
    if (isHT) continue;
    const periodoAtual = jaPassouHT ? '2_tempo' : '1_tempo';
    const mandantePerdendo = golsFora > golsCasa;

    if (total === 0 && raioMand && checaCondicaoGrupo1(jogo, periodoAtual, 'casa'))
      await alertar(sf, `0x0 + Raio do Mandante! (${periodoAtual==='1_tempo'?'1T':'2T'}) · Lay Visitante · Odd: ${oddFora.toFixed(2)}`, `${sf}_live`);
    else if (mandantePerdendo && raioMand && checaCondicaoReacao(jogo, 'casa')) {
      const limiteMin = periodoAtual === '1_tempo' ? 999 : 60;
      if (tempo <= limiteMin)
        await alertar(sf, `Mandante perdendo + Reação confirmada (Raio)! · Lay Visitante · Odd: ${oddFora.toFixed(2)}`, `${sf}_live`);
    }
  }

  // LAY 0x2 MANU — até min 20, lay contra visitante (mandante dominando)
  if (pendJogo.some(p => p.strat === 'lay_0x2_manu')) {
    if (tempo <= 20 && !isHT && golsCasa === 0 && golsFora <= 2 && raioMand) {
      const periodoAtual = jaPassouHT ? '2_tempo' : '1_tempo';
      if (checaCondicaoGrupo1(jogo, periodoAtual, 'casa'))
        await alertar('lay_0x2_manu', `Raio Mandante (até min 20) · ${placar}!`, 'lay_0x2_manu_live');
    }
  }

  // LAY 0x3 — até min 20, lay contra visitante (mandante dominando)
  if (pendJogo.some(p => p.strat === 'lay_0x3')) {
    if (tempo <= 20 && !isHT && golsCasa === 0 && golsFora <= 3 && raioMand) {
      const periodoAtual = jaPassouHT ? '2_tempo' : '1_tempo';
      if (checaCondicaoGrupo1(jogo, periodoAtual, 'casa'))
        await alertar('lay_0x3', `Raio Mandante (até min 20) · ${placar}!`, 'lay_0x3_live');
    }
  }

  // LAY xG — usa o time indicado manualmente no index (lay_team: 'home' ou 'away')
  // como o lado de MAIOR xG a ser layado (mesma lógica do Grupo 1, aplicada
  // ao lado indicado, podendo ser casa ou fora dependendo do jogo)
  if (pendJogo.some(p => p.strat === 'lay_xg')) {
    const pendLayXg = pendJogo.find(p => p.strat === 'lay_xg');
    const layHome   = pendLayXg?.lay_team === 'home';
    const ladoAlvo  = layHome ? 'casa' : 'fora'; // lado de maior xG, que será layado
    const placarAlvoPerdendo = layHome ? (golsFora > golsCasa) : (golsCasa > golsFora);
    const raioAlvo  = layHome ? raioMand : raioVisit;

    if (!isHT && pendLayXg?.lay_team) {
      const periodoAtual = jaPassouHT ? '2_tempo' : '1_tempo';
      if (total === 0 && raioAlvo && checaCondicaoGrupo1(jogo, periodoAtual, ladoAlvo))
        await alertar('lay_xg', `0x0 + Raio do time de maior xG! (${periodoAtual==='1_tempo'?'1T':'2T'})`, 'lay_xg_live');
      else if (placarAlvoPerdendo && raioAlvo && checaCondicaoReacao(jogo, ladoAlvo)) {
        const limiteMin = periodoAtual === '1_tempo' ? 999 : 60;
        if (tempo <= limiteMin)
          await alertar('lay_xg', 'Time de maior xG perdendo + Reação confirmada (Raio)!', 'lay_xg_live');
      }
    }
  }

  // ATOLADA MASTER — versão nova baseada no Indicador do Gonza, mas com
  // exigência mais rígida: eficiência >= 0.20 em AMBOS os times (não só um),
  // jogo 0x0. Só para jogos do nosso card (AM xG pendente).
  if (pendJogo.some(p => p.strat === 'am_xg')) {
    if (!isHT && total === 0) {
      const periodoAtual = jaPassouHT ? '2_tempo' : '1_tempo';
      const ind = getIndicadores(jogo, periodoAtual);
      const idxOk = ind.idxCasa >= 15 && ind.idxFora >= 15;
      const efAmbosOk = ind.efCasa >= 0.20 && ind.efFora >= 0.20;
      if (idxOk && efAmbosOk && checaIndicadorGonza(jogo, estado, periodoAtual))
        await alertar('atolada_master', `Atolada Master do Gonza 🪗 (${periodoAtual==='1_tempo'?'1T':'2T'}) — 0x0 + eficiência alta dos dois!`, 'atolada_master_live');
    }
  }

  // ── OVER 0,5 GONZA — 7 cenários derivados de mercado ──────────
  if (pendJogo.some(p => p.strat === 'over05')) {
    if (isHT) {
      // Intervalo: lembrete simples (mantido como estava)
      if (total === 0 && tevRaioMand)
        await alertar('over05', 'Intervalo 0x0 · Verificar CHUVA DE GOLS no 2º tempo', 'over05_live');
    } else if (!jaPassouHT) {
      // ── 1º TEMPO, 0x0, até min 20 → exige Indicador completo (2 raios) ──
      if (tempo <= 20 && total === 0 && checaIndicadorGonza(jogo, estado, '1_tempo')) {
        await alertar('over05', 'Indicador do Gonza 🪗 (1T, até min 20) — entrar Over 1,5 HT!', 'over05_live');
      } else if (raioMand || raioVisit) {
        // Já saiu gol (total>=1), OU passou do min 20 ainda 0x0 → só 1 raio +
        // índice>=20/eficiência>=0.20 (últ. 10min) do time do raio
        const ind = getIndicadores(jogo, 'ult_10min');
        const ladoDoRaio = raioMand ? 'casa' : 'fora';
        const idxRaio = ladoDoRaio === 'casa' ? ind.idxCasa : ind.idxFora;
        const efRaio  = ladoDoRaio === 'casa' ? ind.efCasa  : ind.efFora;
        if (idxRaio >= 20 && efRaio >= 0.20)
          await alertar('over05', `${placar} + Raio (últ. 10min) — entrar Over 1,5 HT / Over 0,5 HT!`, 'over05_live');
      }
    } else {
      // ── 2º TEMPO — só 1 raio + índice>=20/eficiência>=0.20 (últ. 10min) ──
      // (mesmo com jogo ainda 0x0 no 2T, não exige mais o Indicador completo)
      // Limite de minuto 80 — depois disso não há tempo hábil pra mercado de over.
      if (tempo <= 80 && (raioMand || raioVisit)) {
        const ind = getIndicadores(jogo, 'ult_10min');
        const ladoDoRaio = raioMand ? 'casa' : 'fora';
        const idxRaio = ladoDoRaio === 'casa' ? ind.idxCasa : ind.idxFora;
        const efRaio  = ladoDoRaio === 'casa' ? ind.efCasa  : ind.efFora;
        if (idxRaio >= 20 && efRaio >= 0.20) {
          // Até o min 60: "over à frente" = total + 1,5 (antecipa +1 gol).
          // Depois do min 60 (Gol Limite): só precisa de +1 gol = total + 0,5.
          const golLimite = tempo > 60;
          const mercado = `Over ${(total + (golLimite ? 0.5 : 1.5)).toFixed(1).replace('.', ',')}`;
          const limitTexto = golLimite ? ' (Gol Limite)' : '';
          await alertar('over05', `${placar} + Raio (últ. 10min) — entrar ${mercado}${limitTexto}!`, 'over05_live');
        }
      }
    }
  }
}

// ── FIM DE JOGO ───────────────────────────────────────────────
async function processarFimDeJogo(jogoId, estado, hoje) {
  console.log(`[FIM] ${jogoId}`);
  const jogo = estado.jogo;
  if (!jogo) return;

  // Evitar reprocessar/reenviar "FIM DE JOGO" para jogos que já foram resolvidos
  // antes (ex: servidor reiniciou e a API ainda retorna o jogo por um tempo).
  // Se já existe pelo menos um pendente desse jogo com resultado != 'pendente',
  // significa que esse jogo já foi processado anteriormente.
  const jaResolvidoAntes = pendentes.some(p =>
    p.data === hoje &&
    (p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`) &&
    p.result !== 'pendente'
  );
  if (jaResolvidoAntes) {
    console.log(`[FIM] ${jogoId} já tinha sido resolvido anteriormente — pulando reenvio.`);
    return;
  }

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
    // Conversão pra Gol Limite (indicadores próprios no 2T, estratégia de
    // lado virou mercado de gols): qualquer gol a partir da conversão = green.
    if (p.golLimiteConversao) {
      const [pcConv, pfConv] = (p.placarNaConversao || '0x0').split('x').map(Number);
      const totalNaConversao = (pcConv||0) + (pfConv||0);
      p.result = (golsCasa + golsFora) > totalNaConversao ? 'green' : 'red';
      continue;
    }
    const res = calcularResultado(p.strat, golsCasa, golsFora, htH, htA);
    p.result  = res || 'resolvido';
  }
  salvarArquivo(PEND_FILE, pendentes);

  // Editar todas as mensagens ativas com resultado
  for (const [stratKey, info] of Object.entries(estado.msgIds || {})) {
    if (!info?.ids?.length) continue;

    // Estratégias do Grupo 1 com estado já fechado pela própria máquina de
    // estados (green/red/red_reacao/red_gonza) não devem ser sobrescritas aqui.
    if (info.grupo1Status === 'green' || info.grupo1Status === 'red' ||
        info.grupo1Status === 'red_reacao' || info.grupo1Status === 'red_gonza') continue;

    const stratBase = stratKey.replace(/_live$/, '');
    const pLive = pendJogo.find(p => {
      const ps = p.strat.replace(/_live$/, '');
      return ps === stratBase || ps === stratKey;
    });

    let res;
    // Pressão Gonza "sem eficiência" que NUNCA confirmou (sem pendente
    // registrado) — não conta como entrada de verdade, sempre "não entrou",
    // independente do que a estratégia normal diria.
    if (info.indicadorTipo === 'pressao_sem_eficiencia' && !info.pressaoConfirmada) {
      res = 'nao_entra';
    } else {
      res = pLive?.result || calcularResultado(stratBase, golsCasa, golsFora, htH, htA);
    }
    let emoji;
    if (res === 'green')        emoji = '✅ GREEN';
    else if (res === 'red')     emoji = '❌ RED';
    else if (res === 'nao_entra') emoji = '⚪ NÃO ENTROU (condição não bateu)';
    else                        emoji = '⏳ AVALIAR MANUALMENTE';
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

// ── /momentum-status — consulta visual (não altera nada, só lê) ─
// Mostra, pra cada jogo live que tenha alguma estratégia nossa pendente,
// as sequências de momentum (min/valores/média/eventos) e a contagem de
// chutes por tipo, separado por 1º e 2º tempo, dos dois lados.
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

// Dentro de uma sequência (já "limpa" por definição), varre todas as
// janelas de 5min-calendário possíveis e marca as que batem o piso do
// Pressão Gonza (média >=136) — é a mesma régua usada nos alertas,
// só que aqui é puramente visual (não confere chute no gol/eficiência,
// só o tamanho do momentum, pra dar uma visão rápida de onde "bateria").
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
    const stratsRelevantes = new Set([...LADO_STRATS_PROPRIOS, ...GOLS_STRATS_PROPRIOS]);
    const pendRelevantes = pendentes.filter(p =>
      p.data === hoje && p.result === 'pendente' && stratsRelevantes.has(p.strat)
    );
    if (!pendRelevantes.length) {
      return res.send(msPaginaHTML('<p class="ms-empty">Nenhuma estratégia nossa pendente hoje.</p>'));
    }

    let jogosLive = [];
    try {
      const rLive = await futatsGet('api-games-live');
      jogosLive = rLive[0]?.eventos || [];
    } catch (e) {
      return res.send(msPaginaHTML('<p class="ms-empty">Não consegui consultar a API live agora.</p>'));
    }

    const jogosRelevantes = jogosLive.filter(jogo =>
      pendRelevantes.some(p => p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`)
    );

    if (!jogosRelevantes.length) {
      return res.send(msPaginaHTML('<p class="ms-empty">Nenhum jogo com estratégia nossa pendente está na live agora.</p>'));
    }

    const corpo = jogosRelevantes.map(msHTMLJogo).join('');
    res.send(msPaginaHTML(corpo));
  } catch (e) {
    res.status(500).send('Erro ao gerar status: ' + e.message);
  }
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

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`FUTATS Server v45b na porta ${PORT}`);

  // Buscar jogos pré-jogo imediatamente ao subir
  await buscarPreJogo();

  // Agendar buscarPreJogo nos horários recomendados pela documentação das APIs:
  // IA: 7:30-8:30, 12:00-13:00, 18:30-19:30
  // Filtros: 7:45-8:45, 12:15-13:15, 18:45-19:45
  // Estratégias: sem horário fixo (a critério) — reaproveitamos os mesmos horários
  agendarHoraBRT(8,  0, buscarPreJogo);
  agendarHoraBRT(12, 30, buscarPreJogo);
  agendarHoraBRT(19, 0, buscarPreJogo);

  // Monitoramento live (recomendação: 1-2 minutos)
  setInterval(monitorarLive, 60 * 1000);

  // Agendar: 08h card matinal · 18h resumo parcial · 00h resumo do dia anterior + card novo dia
  agendarHoraBRT(8,  0, enviarCardMatinal);
  agendarHoraBRT(18, 0, enviarResumoDia);
  agendarHoraBRT(0,  0, enviarResumoECard);

  // Avisos de inicio
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

  // Enviar card do dia imediatamente ao subir (apenas o card, não o resumo)
  await enviarCardMatinal();
});
