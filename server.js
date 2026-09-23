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
const TG_CHAT_ID_VALIDACAO = process.env.TG_CHAT_ID_VALIDACAO || '-5508923205';
const PORT        = process.env.PORT        || 3000;
const FUTATS_TOKEN = 'w8e6q2xa';
const FUTATS_BASE  = 'https://gz.futats.com/opta';

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

async function garantirConfiabilidade(jogoId, estado, jogo) {
  if (estado.confiabilidadeBloco) return;
  if (estado.encerrado) return;
  const agora = Date.now();
  if (estado.confiabilidadeUltimaTentativa && (agora - estado.confiabilidadeUltimaTentativa) < CONFIABILIDADE_RETRY_MS) return;
  estado.confiabilidadeUltimaTentativa = agora;

  const conf = await buscarConfiabilidadePreLive(jogo);
  if (!conf || !conf.encontrado) {
    console.log(`[confiabilidade] ${jogoId} → não encontrado ainda (tenta de novo em até ${CONFIABILIDADE_RETRY_MS / 60000}min).`);
    return;
  }

  estado.confiabilidadeBloco = formatarBlocoConfiabilidade(conf);
  estado.overs = conf.overs || null;
  console.log(`[confiabilidade] ${jogoId} → bloco carregado.${estado.overs ? ' (com overs)' : ''}`);

  if (estado.encerrado) {
    console.log(`[confiabilidade] ${jogoId} → jogo já encerrado, não re-renderiza (evita sobrescrever o resultado final).`);
    return;
  }

  console.log(`[confiabilidade] ${jogoId} → re-renderizando alertas ativos.`);
  for (const [stratKey, info] of Object.entries(estado.msgIds || {})) {
    if (!info?.ids?.length) continue;
    if (info.grupo1Status) continue;
    await rerenderizarAlerta(jogo, estado, stratKey, info);
  }
  if (estado.msgConsolidada?.ids?.length && !estado.msgConsolidada.travado) {
    await rerenderizarConsolidado(jogo, estado);
  }

  if (estado.novoIndicador?.jaAlertado && estado.validacaoMsgIds?.length) {
    await reeditarValidacaoComOdds(jogo, estado);
  }
}

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DATA_FILE   = path.join(DATA_DIR, 'dados.json');
const PEND_FILE   = path.join(DATA_DIR, 'pendentes.json');
const ESTADO_FILE = path.join(DATA_DIR, 'estado_live.json');
const MOMENTUM_HISTORICO_FILE = path.join(DATA_DIR, 'momentum_historico.json');
const VALIDACAO_FILE = path.join(DATA_DIR, 'validacao_novos_indicadores.json');
const OBSERVADOR_FILE = path.join(DATA_DIR, 'observador_log.json');
const ARQUIVAR_APOS_MS = 60 * 60 * 1000;

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
let validacaoNovosIndicadores = lerArquivo(VALIDACAO_FILE, []);
let observadorLog = lerArquivo(OBSERVADOR_FILE, []);

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

async function sendTelegramPessoal(msg, extra = {}) {
  const ids = [];
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID_VALIDACAO, text: msg, parse_mode: 'HTML', disable_web_page_preview: true, ...extra })
    });
    const d = await r.json();
    if (d.ok) ids.push({ chatId: TG_CHAT_ID_VALIDACAO, messageId: d.result.message_id });
  } catch(e) { console.error('TG send (validação) error:', e.message); }
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

const TIPOS_CHUTE = ['chute_no_gol', 'chute_para_fora', 'chute_bloqueado', 'chute_na_trave'];

function checaTrocacaoGonza(jogo, minutoAtual) {
  if (!minutoAtual || minutoAtual < 1) return null;
  const eventos = jogo.eventos || [];
  const casaPorMin = {};
  const foraPorMin = {};
  for (const e of eventos) {
    if (!TIPOS_CHUTE.includes(e.tipo_evento)) continue;
    if (e.minuto > minutoAtual || e.minuto > 45) continue;
    const alvo = e.lado === 'casa' ? casaPorMin : foraPorMin;
    (alvo[e.minuto] = alvo[e.minuto] || []).push(e.tipo_evento);
  }
  const comuns = Object.keys(casaPorMin)
    .map(Number)
    .filter(m => foraPorMin[m])
    .sort((a, b) => a - b);
  return comuns.length ? comuns[0] : null;
}

function checaTrocacaoGonza2T(jogo, ateMin) {
  const eventos = jogo.eventos || [];
  const casaPorMin = {};
  const foraPorMin = {};
  for (const e of eventos) {
    if (!TIPOS_CHUTE.includes(e.tipo_evento)) continue;
    if (e.minuto < 46 || e.minuto > ateMin) continue;
    const alvo = e.lado === 'casa' ? casaPorMin : foraPorMin;
    (alvo[e.minuto] = alvo[e.minuto] || []).push(e.tipo_evento);
  }
  const comuns = Object.keys(casaPorMin)
    .map(Number)
    .filter(m => foraPorMin[m])
    .sort((a, b) => a - b);
  return comuns.length ? comuns[0] : null;
}

function checaTempestadeCruzadaGonza(jogo, minutoAtual) {
  if (!minutoAtual || minutoAtual < 2) return null;
  const eventos = jogo.eventos || [];
  const casaPorMin = {};
  const foraPorMin = {};
  for (const e of eventos) {
    if (!TIPOS_CHUTE.includes(e.tipo_evento)) continue;
    if (e.minuto > minutoAtual || e.minuto > 45) continue;
    const alvo = e.lado === 'casa' ? casaPorMin : foraPorMin;
    (alvo[e.minuto] = alvo[e.minuto] || []).push(e.tipo_evento);
  }
  const todosMin = [...new Set([...Object.keys(casaPorMin), ...Object.keys(foraPorMin)].map(Number))].sort((a, b) => a - b);
  for (const m of todosMin) {
    if (casaPorMin[m] && foraPorMin[m + 1] && m + 1 <= 45) return m + 1;
    if (foraPorMin[m] && casaPorMin[m + 1] && m + 1 <= 45) return m + 1;
  }
  return null;
}

function checaTempestadeCruzadaGonza2T(jogo, ateMin) {
  const eventos = jogo.eventos || [];
  const casaPorMin = {};
  const foraPorMin = {};
  for (const e of eventos) {
    if (!TIPOS_CHUTE.includes(e.tipo_evento)) continue;
    if (e.minuto < 46 || e.minuto > ateMin) continue;
    const alvo = e.lado === 'casa' ? casaPorMin : foraPorMin;
    (alvo[e.minuto] = alvo[e.minuto] || []).push(e.tipo_evento);
  }
  const todosMin = [...new Set([...Object.keys(casaPorMin), ...Object.keys(foraPorMin)].map(Number))].sort((a, b) => a - b);
  for (const m of todosMin) {
    if (casaPorMin[m] && foraPorMin[m + 1] && m + 1 <= ateMin) return m + 1;
    if (foraPorMin[m] && casaPorMin[m + 1] && m + 1 <= ateMin) return m + 1;
  }
  return null;
}

function getBucketDinamico(golsCasa, golsFora) {
  const total = golsCasa + golsFora;
  if (total === 0) return '05';
  if (total === 1) return '15';
  if (total === 2) return '25';
  return '35';
}

function pctParaOdd(pct0a100) {
  if (pct0a100 == null || pct0a100 <= 0) return null;
  return Math.round((100 / pct0a100) * 100) / 100;
}

const ESTRATEGIAS_COMBO_HT  = ['favorito_ht_gonza', 'back_gonza_xg', 'lay_away_manu', 'lay_manu4', 'over05_ht', 'over15_ia', 'lay_0x1_ia'];
const ESTRATEGIAS_COMBO_GOL = ['over05_ht', 'over15_ia', 'lay_0x1_ia', 'favorito_ht_gonza', 'back_gonza_xg', 'lay_away_manu'];

function checaComboEstrategia(jogo, hoje, listaEstrategias) {
  const pendJogo = pendentes.filter(p =>
    p.data === hoje && p.tipo === 'pre' &&
    (p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`)
  );
  return [...new Set(pendJogo.filter(p => listaEstrategias.includes(p.strat)).map(p => p.strat))];
}

const contadorCasoBPorHora = {};
function registrarCasoBNaHora() {
  const chave = agoraBRT().toISOString().slice(0, 13);
  contadorCasoBPorHora[chave] = (contadorCasoBPorHora[chave] || 0) + 1;
  return contadorCasoBPorHora[chave];
}

function contaChutesAteMin(jogo, ateMin) {
  const eventos = jogo.eventos || [];
  const totais = eventos.filter(e => e.periodo === '1_tempo' && TIPOS_CHUTE.includes(e.tipo_evento) && e.minuto <= ateMin).length;
  const noGol = eventos.filter(e => e.periodo === '1_tempo' && e.tipo_evento === 'chute_no_gol' && e.minuto <= ateMin).length;
  return { totais, noGol };
}

function montarTextoValidacao(ni, jogo, estado, tempoDisplay, placarAtualDisplay) {
  const links = linksExchanges(jogo.urls_exchanges || {});
  const partes = [];

  if (ni.comboTag) partes.push(ni.comboTag);
  partes.push(`${ni.label} (VALIDAÇÃO)`);
  partes.push(`⚽ <b>${jogo.mandante} x ${jogo.visitante}</b>`);
  partes.push(`⏱ ${ni.minutoBatido}' · 📊 ${ni.placarNoMomento}`);
  partes.push('─────────────────');
  if (ni.caso === 'B_janela_41_45') {
    partes.push(`⏱ Placar segue igual até o ${ni.minutoConfirmacao}'`);
  }
  if (ni.estrategiasTexto) partes.push(ni.estrategiasTexto);
  partes.push(`➜ ENTRAR: ${ni.mercadoTexto}`);
  if (ni.linhaOddJogo) partes.push(ni.linhaOddJogo);
  if (ni.linhaOddJogoHT) partes.push(ni.linhaOddJogoHT);
  partes.push(`📊 Placar atual: ${placarAtualDisplay} · ${tempoDisplay}'`);

  return partes.filter(Boolean).join('\n') + links;
}

async function reeditarValidacaoComOdds(jogo, estado) {
  const ni = estado.novoIndicador;
  if (!ni || !estado.overs) return;
  if (ni.oddJogoJaPreenchida) return;

  if (ni.caso === 'A_ate_min10') {
    const mercadoHT = `over${ni.bucketNoMomento}HT`;
    const oddJogoHT = estado.overs[mercadoHT];
    if (oddJogoHT != null) {
      const odd = pctParaOdd(oddJogoHT);
      if (odd != null) {
        ni.linhaOddJogo = `📊 Odd justa do jogo (pré-live, ${ni.mercadoTexto}): ${odd.toFixed(2)} (${oddJogoHT.toFixed(0)}%)`;
        ni.oddJogoJaPreenchida = true;
      }
    }
  } else if (ni.caso === 'B_janela_41_45') {
    const mercadoFT = `over${ni.bucketNoMomento}`;
    const oddJogoFT = estado.overs[mercadoFT];
    if (oddJogoFT != null) {
      const odd = pctParaOdd(oddJogoFT);
      if (odd != null) {
        ni.linhaOddJogo = `📊 Odd justa do jogo (pré-live, ${ni.mercadoTexto}): ${odd.toFixed(2)} (${oddJogoFT.toFixed(0)}%)`;
        ni.oddJogoJaPreenchida = true;
      }
    }
    const mercadoHT = `over${ni.bucketNoMomento}HT`;
    const oddJogoHT = estado.overs[mercadoHT];
    if (oddJogoHT != null) {
      const oddHT = pctParaOdd(oddJogoHT);
      if (oddHT != null) {
        const labelHT = { '05': 'Over 0,5 HT', '15': 'Over 1,5 HT' }[ni.bucketNoMomento] || 'Over HT';
        ni.linhaOddJogoHT = `🧮 Prévia HT (placar do 41' como base) — ${labelHT}: ${oddHT.toFixed(2)} (${oddJogoHT.toFixed(0)}%)`;
      }
    }
  }

  if (!ni.oddJogoJaPreenchida && !ni.linhaOddJogoHT) return;

  const golsCasa = parseInt(jogo.gols_casa) || 0;
  const golsFora = parseInt(jogo.gols_fora) || 0;
  const placarAtual = `${golsCasa}x${golsFora}`;
  const tempoNum = parseInt(jogo.tempo) || ni.minutoBatido;
  const texto = montarTextoValidacao(ni, jogo, estado, tempoNum, placarAtual);
  await editTelegram(estado.validacaoMsgIds, texto);
}

async function processarTrocacaoTempestade(jogo, estado, jogoId, hoje) {
  if (estado.passouHT) return;
  const tempoNum = parseInt(jogo.tempo) || 0;
  if (!tempoNum || jogo.tempo === 'Intervalo') return;

  estado.novoIndicador = estado.novoIndicador || null;

  const tr = checaTrocacaoGonza(jogo, tempoNum);
  const te = checaTempestadeCruzadaGonza(jogo, tempoNum);
  const candidatos = [];
  if (tr != null) candidatos.push({ tipo: 'trocacao_gonza', min: tr, label: '🥊 Trocação Gonza' });
  if (te != null) candidatos.push({ tipo: 'tempestade_cruzada_gonza', min: te, label: '⛈️ Tempestade Cruzada Gonza' });
  if (!candidatos.length) return;

  if (!estado.novoIndicador) {
    candidatos.sort((a, b) => a.min - b.min);
    const escolhido = candidatos[0];
    const golsCasa = parseInt(jogo.gols_casa) || 0;
    const golsFora = parseInt(jogo.gols_fora) || 0;
    estado.novoIndicador = {
      tipo: escolhido.tipo,
      label: escolhido.label,
      minutoBatido: escolhido.min,
      placarNoMomento: `${golsCasa}x${golsFora}`,
      bucketNoMomento: getBucketDinamico(golsCasa, golsFora),
      jaAlertado: false,
    };
  }

  const ni = estado.novoIndicador;
  if (ni.jaAlertado) return;

  const golsCasa = parseInt(jogo.gols_casa) || 0;
  const golsFora = parseInt(jogo.gols_fora) || 0;
  const placarAtual = `${golsCasa}x${golsFora}`;

  if (ni.minutoBatido <= 10) {
    ni.jaAlertado = true;
    ni.caso = 'A_ate_min10';

    const mercadoLabel = {
      '05': 'Over 0,5 HT', '15': 'Over 1,5 HT', '25': 'Over 2,5 HT', '35': 'Over 3,5 HT',
    }[ni.bucketNoMomento] || 'Over HT';
    ni.mercadoTexto = mercadoLabel;

    const oddJogoHT = estado.overs ? estado.overs[`over${ni.bucketNoMomento}HT`] : null;
    if (oddJogoHT != null) {
      const odd = pctParaOdd(oddJogoHT);
      if (odd != null) {
        ni.linhaOddJogo = `📊 Odd justa do jogo (pré-live, ${mercadoLabel}): ${odd.toFixed(2)} (${oddJogoHT.toFixed(0)}%)`;
        ni.oddJogoJaPreenchida = true;
      }
    }

    const comboHT = checaComboEstrategia(jogo, hoje, ESTRATEGIAS_COMBO_HT);
    if (comboHT.length) {
      ni.comboTag = '⭐🥇 COMBO FORTE ⭐';
      ni.estrategiasTexto = comboHT.map(k => STRAT_DISPLAY[k] || k).join(' · ');
    }

    const registro = {
      jogoId, jogo: `${jogo.mandante} x ${jogo.visitante}`, data: hoje,
      tipo: ni.tipo, minutoBatido: ni.minutoBatido, placarNoMomento: ni.placarNoMomento,
      bucket: ni.bucketNoMomento, mercado: mercadoLabel, caso: 'A_ate_min10',
      comboEstrategias: comboHT.length ? comboHT : null,
      status: 'pendente',
    };
    validacaoNovosIndicadores.push(registro);
    salvarArquivo(VALIDACAO_FILE, validacaoNovosIndicadores);
    estado.validacaoIndex = validacaoNovosIndicadores.length - 1;

    const texto = montarTextoValidacao(ni, jogo, estado, tempoNum, placarAtual);
    const ids = await sendTelegramPessoal(texto);
    estado.validacaoMsgIds = ids;
    return;
  }

  if (tempoNum >= 41 && tempoNum <= 45) {
    if (placarAtual !== ni.placarNoMomento) {
      ni.jaAlertado = true;
      return;
    }
    ni.jaAlertado = true;
    ni.caso = 'B_janela_41_45';
    ni.minutoConfirmacao = tempoNum;

    const mercadoLabelFT = {
      '05': 'Over 0,5', '15': 'Over 1,5', '25': 'Over 2,5', '35': 'Over 3,5',
    }[ni.bucketNoMomento] || 'Over';
    ni.mercadoTexto = `${mercadoLabelFT} Limite (jogo todo)`;

    const oddJogoFT = estado.overs ? estado.overs[`over${ni.bucketNoMomento}`] : null;
    if (oddJogoFT != null) {
      const odd = pctParaOdd(oddJogoFT);
      if (odd != null) {
        ni.linhaOddJogo = `📊 Odd justa do jogo (pré-live, ${ni.mercadoTexto}): ${odd.toFixed(2)} (${oddJogoFT.toFixed(0)}%)`;
        ni.oddJogoJaPreenchida = true;
      }
    }
    const oddJogoHT = estado.overs ? estado.overs[`over${ni.bucketNoMomento}HT`] : null;
    if (oddJogoHT != null) {
      const oddHT = pctParaOdd(oddJogoHT);
      if (oddHT != null) {
        const labelHT = { '05': 'Over 0,5 HT', '15': 'Over 1,5 HT' }[ni.bucketNoMomento] || 'Over HT';
        ni.linhaOddJogoHT = `🧮 Prévia HT (placar do 41' como base) — ${labelHT}: ${oddHT.toFixed(2)} (${oddJogoHT.toFixed(0)}%)`;
      }
    }

    const comboGol = checaComboEstrategia(jogo, hoje, ESTRATEGIAS_COMBO_GOL);
    let filtroChutesInfo = null;
    if (comboGol.length) {
      ni.comboTag = '⭐🥇 COMBO FORTE ⭐';
      ni.estrategiasTexto = comboGol.map(k => STRAT_DISPLAY[k] || k).join(' · ');
    } else {
      const contagemHora = registrarCasoBNaHora();
      if (contagemHora >= 3) {
        const { totais, noGol } = contaChutesAteMin(jogo, 41);
        filtroChutesInfo = { totais, noGol, passou: totais >= 14 && noGol >= 3 };
        if (filtroChutesInfo.passou) {
          ni.comboTag = `⚡🥊 Combo (filtro de chutes, ${totais} chutes / ${noGol} no gol) ⚡`;
        } else {
          ni.semDestaqueHoraCheia = true;
          ni.filtroChutesTexto = `Não passou no filtro de chutes dessa hora cheia (${totais} totais / ${noGol} no gol)`;
        }
      }
    }

    const registro = {
      jogoId, jogo: `${jogo.mandante} x ${jogo.visitante}`, data: hoje,
      tipo: ni.tipo, minutoBatido: ni.minutoBatido, placarNoMomento: ni.placarNoMomento,
      bucket: ni.bucketNoMomento, mercado: ni.mercadoTexto, caso: 'B_janela_41_45',
      comboEstrategias: comboGol.length ? comboGol : null,
      filtroChutes: filtroChutesInfo,
      status: 'pendente',
    };
    validacaoNovosIndicadores.push(registro);
    salvarArquivo(VALIDACAO_FILE, validacaoNovosIndicadores);
    estado.validacaoIndex = validacaoNovosIndicadores.length - 1;

    const texto = montarTextoValidacao(ni, jogo, estado, tempoNum, placarAtual);
    const ids = await sendTelegramPessoal(texto);
    estado.validacaoMsgIds = ids;
    return;
  }
}

async function confirmarValidacaoNoHT(jogo, estado) {
  if (estado.validacaoIndex == null) return;
  const registro = validacaoNovosIndicadores[estado.validacaoIndex];
  if (!registro || registro.status !== 'pendente') return;
  if (registro.caso !== 'A_ate_min10') return;

  const [baseCasa, baseFora] = registro.placarNoMomento.split('x').map(Number);
  const golsCasaHT = parseInt(jogo.gols_casa_ht);
  const golsForaHT = parseInt(jogo.gols_fora_ht);
  if (isNaN(golsCasaHT) || isNaN(golsForaHT)) return;

  const totalBase = baseCasa + baseFora;
  const totalHT = golsCasaHT + golsForaHT;
  const green = totalHT > totalBase;

  registro.status = green ? 'green' : 'red';
  registro.htFinal = `${golsCasaHT}x${golsForaHT}`;
  salvarArquivo(VALIDACAO_FILE, validacaoNovosIndicadores);

  const emoji = green ? '✅ GREEN' : '❌ RED';
  const texto = `${emoji} — Validação ${registro.tipo === 'trocacao_gonza' ? '🥊 Trocação Gonza' : '⛈️ Tempestade Cruzada Gonza'}\n⚽ ${registro.jogo}\n⏱ ${registro.minutoBatido}' · 📊 ${registro.placarNoMomento} → HT: ${registro.htFinal}\n➜ Mercado: ${registro.mercado}`;
  await sendTelegramPessoal(texto);
}

async function confirmarValidacaoNoFim(estado, golsCasaFT, golsForaFT, placarFT) {
  if (estado.validacaoIndex == null) return;
  const registro = validacaoNovosIndicadores[estado.validacaoIndex];
  if (!registro || registro.status !== 'pendente') return;
  if (registro.caso !== 'B_janela_41_45') return;

  const [baseCasa, baseFora] = registro.placarNoMomento.split('x').map(Number);
  const totalBase = baseCasa + baseFora;
  const totalFT = golsCasaFT + golsForaFT;
  const green = totalFT > totalBase;

  registro.status = green ? 'green' : 'red';
  registro.ftFinal = placarFT;
  salvarArquivo(VALIDACAO_FILE, validacaoNovosIndicadores);

  const emoji = green ? '✅ GREEN' : '❌ RED';
  const texto = `${emoji} — Validação ${registro.tipo === 'trocacao_gonza' ? '🥊 Trocação Gonza' : '⛈️ Tempestade Cruzada Gonza'}\n⚽ ${registro.jogo}\n⏱ ${registro.minutoBatido}' · 📊 ${registro.placarNoMomento} → FT: ${registro.ftFinal}\n➜ Mercado: ${registro.mercado}`;
  await sendTelegramPessoal(texto).catch(() => {});
}

const REGRAS_ODDS_JUSTAS = {
  favorito_ht_gonza: {
    geral: { n:2848, over05HT:0.7626, over15HT:0.4129, over05:0.9554, over15:0.8153, over25:0.6225, over35:0.3789 },
    ht0: { n:676, over05:0.8121, over15:0.4778, over25:0.2263, over35:0.0754 },
    ht1: { n:996, over05:1.0, over15:0.8263, over25:0.5341, over35:0.254 },
    ht2: { n:1176, over05:1.0, over15:1.0, over25:0.9252, over35:0.659 },
  },
  back_gonza_xg: {
    geral: { n:1518, over05HT:0.7661, over15HT:0.419, over05:0.9578, over15:0.8195, over25:0.6173, over35:0.3834 },
    ht0: { n:355, over05:0.8197, over15:0.493, over25:0.2, over35:0.0761 },
    ht1: { n:527, over05:1.0, over15:0.8216, over25:0.5332, over35:0.2543 },
    ht2: { n:636, over05:1.0, over15:1.0, over25:0.9198, over35:0.6619 },
  },
  lay_away_manu: {
    geral: { n:1145, over05HT:0.7546, over15HT:0.3895, over05:0.9581, over15:0.8105, over25:0.5974, over35:0.3616 },
    ht0: { n:281, over05:0.8292, over15:0.5125, over25:0.1993, over35:0.0641 },
    ht1: { n:418, over05:1.0, over15:0.8086, over25:0.512, over35:0.2153 },
    ht2: { n:446, over05:1.0, over15:1.0, over25:0.9283, over35:0.6861 },
  },
  lay_manu4: {
    geral: { n:493, over05HT:0.7748, over15HT:0.3996, over05:0.9615, over15:0.8377, over25:0.6308, over35:0.3834 },
    ht0: { n:111, over05:0.8288, over15:0.5766, over25:0.2613, over35:0.0631 },
    ht1: { n:185, over05:1.0, over15:0.8216, over25:0.5297, over35:0.2108 },
    ht2: { n:197, over05:1.0, over15:1.0, over25:0.934, over35:0.7259 },
  },
  felipe_over15: {
    geral: { n:2265, over05HT:0.721, over15HT:0.3762, over05:0.9435, over15:0.7965, over25:0.5753, over35:0.3426 },
    ht0: { n:632, over05:0.7975, over15:0.4731, over25:0.1994, over35:0.0759 },
    ht1: { n:781, over05:1.0, over15:0.8361, over25:0.5288, over35:0.2292 },
    ht2: { n:852, over05:1.0, over15:1.0, over25:0.8967, over35:0.6444 },
  },
  ambas_marcam_xg: {
    geral: { n:2157, over05HT:0.7246, over15HT:0.3639, over05:0.9416, over15:0.7854, over25:0.5559, over35:0.3421 },
    ht0: { n:594, over05:0.7879, over15:0.4579, over25:0.1869, over35:0.0774 },
    ht1: { n:778, over05:1.0, over15:0.8188, over25:0.4987, over35:0.2249 },
    ht2: { n:785, over05:1.0, over15:1.0, over25:0.8917, over35:0.6586 },
  },
  over05: {
    geral: { n:794, over05HT:0.6612, over15HT:0.364, over05:0.9484, over15:0.7796, over25:0.5655, over35:0.3753 },
    ht0: { n:269, over05:0.8476, over15:0.513, over25:0.2528, over35:0.1301 },
    ht1: { n:236, over05:1.0, over15:0.8136, over25:0.4958, over35:0.2542 },
    ht2: { n:289, over05:1.0, over15:1.0, over25:0.9135, over35:0.7024 },
  },
  gol_no_final: {
    geral: { n:433, over05HT:0.6767, over15HT:0.3533, over05:0.9284, over15:0.7436, over25:0.515, over35:0.2933 },
    ht0: { n:140, over05:0.7786, over15:0.4429, over25:0.1786, over35:0.0857 },
    ht1: { n:140, over05:1.0, over15:0.7643, over25:0.4429, over35:0.2071 },
    ht2: { n:153, over05:1.0, over15:1.0, over25:0.8889, over35:0.5621 },
  },
  over05_ht: {
    geral: { n:398, over05HT:0.7513, over15HT:0.4447, over05:0.9623, over15:0.8492, over25:0.6608, over35:0.4598 },
    ht0: { n:99, over05:0.8485, over15:0.5354, over25:0.2727, over35:0.1212 },
    ht1: { n:122, over05:1.0, over15:0.8852, over25:0.582, over35:0.3033 },
    ht2: { n:177, over05:1.0, over15:1.0, over25:0.9322, over35:0.7571 },
  },
  over15_ia: {
    geral: { n:352, over05HT:0.7926, over15HT:0.446, over05:0.9659, over15:0.8466, over25:0.6506, over35:0.4659 },
    ht0: { n:73, over05:0.8356, over15:0.5479, over25:0.274, over35:0.1096 },
    ht1: { n:122, over05:1.0, over15:0.8279, over25:0.5328, over35:0.3197 },
    ht2: { n:157, over05:1.0, over15:1.0, over25:0.9172, over35:0.7452 },
  },
  ambas_marcam: {
    geral: { n:246, over05HT:0.7154, over15HT:0.4228, over05:0.9309, over15:0.8008, over25:0.6016, over35:0.4024 },
    ht0: { n:70, over05:0.7571, over15:0.4571, over25:0.2, over35:0.1143 },
    ht1: { n:72, over05:1.0, over15:0.8472, over25:0.5417, over35:0.2639 },
    ht2: { n:104, over05:1.0, over15:1.0, over25:0.9135, over35:0.6923 },
  },
  lay_0x1_ia: {
    geral: { n:579, over05HT:0.7789, over15HT:0.418, over05:0.9758, over15:0.8359, over25:0.6149, over35:0.4249 },
    ht0: { n:128, over05:0.8906, over15:0.5625, over25:0.2422, over35:0.1484 },
    ht1: { n:209, over05:1.0, over15:0.8134, over25:0.5024, over35:0.2727 },
    ht2: { n:242, over05:1.0, over15:1.0, over25:0.9091, over35:0.7025 },
  },
  lay_1x0_ia: {
    geral: { n:286, over05HT:0.7308, over15HT:0.3986, over05:0.9545, over15:0.8182, over25:0.6049, over35:0.4231 },
    ht0: { n:77, over05:0.8312, over15:0.5455, over25:0.2597, over35:0.1818 },
    ht1: { n:95, over05:1.0, over15:0.8211, over25:0.5053, over35:0.2526 },
    ht2: { n:114, over05:1.0, over15:1.0, over25:0.9211, over35:0.7281 },
  },
  lay_gol_visit: {
    geral: { n:487, over05HT:0.6612, over15HT:0.3142, over05:0.9302, over15:0.7351, over25:0.4784, over35:0.2793 },
    ht0: { n:165, over05:0.7939, over15:0.4303, over25:0.1697, over35:0.0667 },
    ht1: { n:169, over05:1.0, over15:0.7929, over25:0.426, over35:0.2071 },
    ht2: { n:153, over05:1.0, over15:1.0, over25:0.8693, over35:0.5882 },
  },
  lay_gol_mand: {
    geral: { n:216, over05HT:0.6991, over15HT:0.2917, over05:0.9306, over15:0.7639, over25:0.5093, over35:0.3194 },
    ht0: { n:65, over05:0.7692, over15:0.4308, over25:0.1692, over35:0.1077 },
    ht1: { n:88, over05:1.0, over15:0.8409, over25:0.4886, over35:0.2045 },
    ht2: { n:63, over05:1.0, over15:1.0, over25:0.8889, over35:0.6984 },
  },
};

function taxaEstrategia(stratKey, contexto, mercado) {
  const bloco = REGRAS_ODDS_JUSTAS[stratKey];
  if (!bloco || !bloco[contexto]) return null;
  const v = bloco[contexto][mercado];
  return (v == null) ? null : v;
}

function montarLinhasOdds(stratKey, is1T, golsCasa, golsFora, htTotal, overs) {
  const linhas = [];
  const bucket = getBucketDinamico(golsCasa, golsFora);
  const mercadoFT = `over${bucket}`;
  const labelFT = { '05':'Over 0,5', '15':'Over 1,5', '25':'Over 2,5', '35':'Over 3,5' }[bucket];

  const contexto = is1T ? 'geral' : (htTotal === 0 ? 'ht0' : (htTotal === 1 ? 'ht1' : 'ht2'));

  if (is1T) {
    const mercadoHT = bucket === '05' ? 'over05HT' : 'over15HT';
    const labelHT = bucket === '05' ? 'Over 0,5 HT' : 'Over 1,5 HT';
    const taxaEstHT = stratKey ? taxaEstrategia(stratKey, 'geral', mercadoHT) : null;
    const taxaJogoHT = overs ? overs[mercadoHT] : null;

    if (taxaEstHT != null) {
      linhas.push(`📈 Odd justa estratégia (${labelHT}, pré-live): ${(1/taxaEstHT).toFixed(2)}`);
    }
    if (taxaJogoHT != null) {
      const oddJogoHT = pctParaOdd(taxaJogoHT);
      if (oddJogoHT != null) {
        linhas.push(`📊 Odd justa do jogo (pré-live, ${labelHT}): ${oddJogoHT.toFixed(2)} (${taxaJogoHT.toFixed(0)}%)`);
      }
    }
    if (taxaEstHT != null && taxaJogoHT != null) {
      const media = (taxaEstHT + (taxaJogoHT/100)) / 2;
      linhas.push(`🎯 Odd justa combinada (${labelHT}): ${(1/media).toFixed(2)}`);
    }
  }

  const taxaEstFT = stratKey ? taxaEstrategia(stratKey, contexto, mercadoFT) : null;
  const taxaJogoFT = overs ? overs[mercadoFT] : null;

  if (taxaEstFT != null) {
    linhas.push(`📈 Odd justa estratégia (${labelFT} Limite, pré-live): ${(1/taxaEstFT).toFixed(2)}`);
  }
  if (taxaJogoFT != null) {
    const oddJogoFT = pctParaOdd(taxaJogoFT);
    if (oddJogoFT != null) {
      linhas.push(`📊 Odd justa do jogo (pré-live, ${labelFT} Limite): ${oddJogoFT.toFixed(2)} (${taxaJogoFT.toFixed(0)}%)`);
    }
  }
  if (taxaEstFT != null && taxaJogoFT != null) {
    const media = (taxaEstFT + (taxaJogoFT/100)) / 2;
    linhas.push(`🎯 Odd justa combinada (${labelFT} Limite): ${(1/media).toFixed(2)}`);
  }

  return linhas;
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

const REGRAS_ENTRADA = {
  favorito_ht_gonza: {
    corte2T: 65,
    oddJustaOverLimite1T: 1.06,
    oddJustaLay1Zebra2T: 1.17,
  },
  over05: {
    oddJustaCombinado: 1.05,
    oddJustaOverHT: 1.06,
    oddJustaOverLimiteIsolado: 1.05,
  },
  gol_no_final: {
    limiteMinuto: 65,
    oddJusta: 1.36,
  },
};

const GOLS_STRATS_SO_2T = [];

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

      garantirConfiabilidade(jogoId, estado, jogo).catch((e) =>
        console.error(`[confiabilidade] Erro inesperado em ${jogoId}:`, e.message)
      );

      for (const m of (jogo.momentum || [])) {
        const idxMom = estado.momentum.findIndex(x => x.minuto === m.minuto);
        if (idxMom === -1) estado.momentum.push(m);
        else estado.momentum[idxMom] = m;
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
        await confirmarValidacaoNoHT(jogo, estado).catch(() => {});
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
        await confirmarValidacaoNoHT(jogo, estado).catch(() => {});
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
      await processarTrocacaoTempestade(jogo, estado, jogoId, hoje).catch((e) =>
        console.error(`[trocacao/tempestade] Erro em ${jogoId}:`, e.message)
      );
    }

    arquivarJogosEncerrados();
    salvarArquivo(ESTADO_FILE, estadoLive);
  } catch(e) {
    console.error('[LIVE] Erro:', e.message);
  }
}

function arquivarJogosEncerrados() {
  const agora = Date.now();
  let arquivados = 0;
  for (const [jogoId, estado] of Object.entries(estadoLive)) {
    if (!estado.encerrado) continue;
    const encerradoEm = estado.encerradoEm || estado.ultimaVez || 0;
    if ((agora - encerradoEm) < ARQUIVAR_APOS_MS) continue;

    momentumHistorico[jogoId] = momentumHistorico[jogoId] || [];
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

function placarValidoParaGols(stratKey, golsCasa, golsFora) {
  const total = golsCasa + golsFora;
  switch (stratKey) {
    case 'over15_ia':
    case 'felipe_over15':
      return total <= 1;
    case 'ambas_marcam':
    case 'ambas_marcam_xg':
    case 'am_xg':
      return !(golsCasa > 0 && golsFora > 0);
    case 'over05':
      return total <= 3;
    default:
      return true;
  }
}

function montarCorpoAlerta(info, estado, placarAtual, tempoDisplay, stratKey, jogo) {
  const partes = [...montarLinhasIndicadores(info)];
  if (info.avisoSaida) partes.push(info.avisoSaida);

  const golsCasa = parseInt(jogo.gols_casa) || 0;
  const golsFora = parseInt(jogo.gols_fora) || 0;
  const is1T = !estado.passouHT;
  let htTotal = null;
  if (!is1T && estado.htPlacar) {
    const [hc, hf] = estado.htPlacar.split('x').map(Number);
    if (!isNaN(hc) && !isNaN(hf)) htTotal = hc + hf;
  }
  const linhasOdds = montarLinhasOdds(stratKey, is1T, golsCasa, golsFora, htTotal, estado.overs);
  partes.push(...linhasOdds);

  partes.push(`📊 Placar atual: ${placarAtual} · ${tempoDisplay}'`);
  if (estado.confiabilidadeBloco) partes.push(estado.confiabilidadeBloco);
  return partes.join('\n');
}

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

const LADO_MESMA_REGRA_FAVORITO = ['lay_away_manu', 'lay_manu4', 'back_gonza_xg', 'lay_gol_mand', 'lay_gol_visit'];

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

  if (temOver && estrategias.length > 1) {
    return { tipo: 'over_limite', texto: 'Over Limite', placarBase, oddJusta: REGRAS_ENTRADA.over05.oddJustaCombinado };
  }

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

  if (temOver) {
    if (!is1T) return { tipo: 'over_limite', texto: 'Over Limite', placarBase, oddJusta: REGRAS_ENTRADA.over05.oddJustaOverLimiteIsolado };
    return determinarEntradaOver05Isolado(jogo, placarBase, tempoNum);
  }

  return null;
}

function checarGreenConsolidado(jogo, estado, entradaSugerida) {
  if (!entradaSugerida) return { green: false };
  const golsCasa = parseInt(jogo.gols_casa) || 0;
  const golsFora = parseInt(jogo.gols_fora) || 0;
  const gols = golsDoEstado(estado);
  const [baseCasa, baseFora] = (entradaSugerida.placarBase || '0x0').split('x').map(Number);

  if (['over_limite', 'duas_opcoes_1T', 'over_ht_recuperacao'].includes(entradaSugerida.tipo)) {
    const totalBase = baseCasa + baseFora;
    if ((golsCasa + golsFora) > totalBase) {
      const golQueDecide = gols[totalBase];
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
      const golQueDecide = golsDesseLado[alvoDesseLado];
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

  if (msgCons.estrategias.length) {
    const golsCasa = parseInt(jogo.gols_casa) || 0;
    const golsFora = parseInt(jogo.gols_fora) || 0;
    const is1T = !estado.passouHT;
    let htTotal = null;
    if (!is1T && estado.htPlacar) {
      const [hc, hf] = estado.htPlacar.split('x').map(Number);
      if (!isNaN(hc) && !isNaN(hf)) htTotal = hc + hf;
    }
    const stratRef = msgCons.estrategias[0].stratKey;
    partes.push(...montarLinhasOdds(stratRef, is1T, golsCasa, golsFora, htTotal, estado.overs));
  }

  partes.push(`📊 Placar atual: ${placarAtual} · ${tempoDisplay}'`);
  if (estado.confiabilidadeBloco) partes.push(estado.confiabilidadeBloco);

  const links = linksExchanges(jogo.urls_exchanges || {});
  return fixo + sep + '\n' + partes.join('\n') + links;
}

async function dispararOuAtualizarConsolidado(jogo, estado, stratKey, tempoNum, placarAlerta, opcoes = {}) {
  estado.msgConsolidada = estado.msgConsolidada || null;
  const cons = estado.msgConsolidada;

  if (cons && cons.travado) return false;

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

async function rerenderizarConsolidado(jogo, estado) {
  const msgCons = estado.msgConsolidada;
  if (!msgCons || !msgCons.ids) return;
  if (msgCons.travado) return;

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

  let corpo = montarCorpoAlerta(infoTemp, estado, placar, tempoDisplay, stratKey, jogo);
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

async function rerenderizarAlerta(jogo, estado, stratKey, info) {
  const tempoNum = parseInt(jogo.tempo) || estado.ultimoMinuto || 0;
  const tempoDisplay = jogo.tempo === 'Intervalo' ? 'HT' : tempoNum;
  const golsCasa = parseInt(jogo.gols_casa) || 0, golsFora = parseInt(jogo.gols_fora) || 0;
  const placarAtual = `${golsCasa}x${golsFora}`;
  const links = linksExchanges(jogo.urls_exchanges || {});
  const display = STRAT_DISPLAY[stratKey] || stratKey;

  const corpo = montarCorpoAlerta(info, estado, placarAtual, tempoDisplay, stratKey, jogo);
  const texto = montarMsgAlerta(display, jogo, info.tempoAlerta, info.placarAlerta, `${placarAtual} · ${tempoDisplay}'`, links, corpo);
  await editTelegram(info.ids, texto);
}

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
  if (GOLS_STRATS_SO_2T.includes(stratKey)) return false;
  return true;
}

async function processarGolsMin45(jogo, estado, pendJogo, tempoNum, golsCasa, golsFora) {
  estado.padraoGols2T = estado.padraoGols2T || {};
  estado.min45Avaliado = estado.min45Avaliado || {};
  const favorito = getFavorito(jogo);

  for (const stratKey of GOLS_STRATS_SO_2T) {
    if (!pendJogo.some(p => p.strat === stratKey)) continue;
    if (estado.min45Avaliado[stratKey]) continue;

    if (!estado.padraoGols2T[stratKey] && tempoNum < 45) {
      const pgFav = checaPressaoGonza(jogo, estado, favorito, tempoNum);
      const ja = checaJogoAberto(jogo, tempoNum);
      let tipoIndicador = null, valor = null;
      if (pgFav && pgFav.tipo === 'completo') { tipoIndicador = 'gonza'; valor = pgFav.minutoChute; }
      else if (pgFav && pgFav.tipo === 'gonza2') { tipoIndicador = 'gonza2'; valor = pgFav.minutoChute; }
      else if (ja) { tipoIndicador = 'aberto'; valor = `${ja.minCasa}-${ja.minFora}`; }
      if (tipoIndicador) estado.padraoGols2T[stratKey] = { tipoIndicador, valor };
    }

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

  estado.stratsDisparadas = estado.stratsDisparadas || {};

  for (const stratKey of LADO_STRATS_PROPRIOS) {
    if (!pendJogo.some(p => p.strat === stratKey)) continue;
    const ladoAlvo = getLadoAlvoEstrategia(stratKey, jogo, hoje, pendJogo);
    if (!ladoAlvo) continue;

    const limitadaMin20 = LADO_STRATS_LIMITE_MIN20.includes(stratKey);
    const jaDisparou = estado.stratsDisparadas[stratKey];

    if (!jaDisparou) {
      if (limitadaMin20 && tempoNum > 20) continue;

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
          await dispararAlertaIndicador(jogo, estado, stratKey, tipoIndicador, periodoAtual, valor, { ladoAlvo, entradaReal });
        }
      }
    } else if (estado.msgIds[stratKey]) {
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

async function processarEstadoGrupo1(jogo, estado, jogoId, hoje) {
  const golsCasa = parseInt(jogo.gols_casa) || 0;
  const golsFora = parseInt(jogo.gols_fora) || 0;
  const tempo     = jogo.tempo === 'Intervalo' ? (estado.ultimoMinuto || 45) : (parseInt(jogo.tempo) || 0);
  const isHT      = jogo.tempo === 'Intervalo';
  const links     = linksExchanges(jogo.urls_exchanges || {});

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
    return null;
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

  await confirmarValidacaoNoFim(estado, golsCasa, golsFora, placarFT).catch(() => {});

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

    const partes = [...montarLinhasIndicadores(info)];
    if (info.avisoSaida) partes.push(info.avisoSaida);
    if (estado.confiabilidadeBloco) partes.push(estado.confiabilidadeBloco);
    const htTexto = estado.htPlacar || '-';
    partes.push(`${emoji} · HT: ${htTexto} · FT: ${placarFT}`);
    const corpo = partes.join('\n');

    const textoFinal = `${display}\n⚽ <b>${jogo.mandante} x ${jogo.visitante}</b>\n⏱ ${info.tempoAlerta}' · 📊 ${info.placarAlerta}\n─────────────────\n${corpo}${links}`;
    await editTelegram(info.ids, textoFinal);
  }

  if (estado.msgConsolidada?.ids?.length) {
    const msgCons = estado.msgConsolidada;

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

    if (!msgCons.travado) {
      const gr = checarGreenConsolidado(jogo, estado, msgCons.entradaSugerida);
      msgCons.entradaGreen = gr.green || (msgCons.entradaSugerida ? true : false);
      msgCons.entradaMinutoGreen = gr.minutoGreen;
      if (!gr.green && msgCons.entradaSugerida) {
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

function checaRaioGol5min(jogo, minIni, minFim) {
  const eventos = jogo.eventos || [];
  const gols = eventos.filter(e => e.tipo_evento === 'gol');
  const raios = eventos.filter(e => e.tipo_evento === 'raio');
  if (!raios.length) return null;
  for (const g of gols) {
    if (g.minuto < minIni || g.minuto > minFim) continue;
    for (const r of raios) {
      if (Math.abs(r.minuto - g.minuto) <= 5) return g.minuto;
    }
  }
  return null;
}

function checaChuvaDeCantos(jogo, minIni, minFim) {
  const eventos = jogo.eventos || [];
  const porMin = { casa: {}, fora: {} };
  for (const e of eventos) {
    if (e.tipo_evento !== 'escanteio') continue;
    if (e.minuto < minIni || e.minuto > minFim) continue;
    porMin[e.lado][e.minuto] = (porMin[e.lado][e.minuto] || 0) + 1;
  }
  let melhor = null;
  for (const lado of ['casa', 'fora']) {
    for (let fim = minIni; fim <= minFim; fim++) {
      let cnt = 0;
      for (let mi = Math.max(minIni, fim - 9); mi <= fim; mi++) cnt += porMin[lado][mi] || 0;
      if (cnt >= 3) { if (melhor == null || fim < melhor) melhor = fim; break; }
    }
  }
  return melhor;
}

function checaTaRelampegando(jogo, minIni, minFim) {
  const eventos = jogo.eventos || [];
  const raios = eventos.filter(e => e.tipo_evento === 'raio' && e.minuto >= minIni && e.minuto <= minFim);
  if (!raios.length) return null;
  const chutes = eventos.filter(e => e.tipo_evento === 'chute_no_gol' && e.minuto >= minIni - 3 && e.minuto <= minFim + 3);
  let melhor = null;
  for (const r of raios) {
    const bate = chutes.some(c => c.lado === r.lado && Math.abs(c.minuto - r.minuto) <= 3);
    if (bate && (melhor == null || r.minuto < melhor)) melhor = r.minuto;
  }
  return melhor;
}

function checaRelampagoTriangular(jogo, minIni, minFim) {
  const eventos = jogo.eventos || [];
  const raios = eventos.filter(e => e.tipo_evento === 'raio' && e.minuto >= minIni && e.minuto <= minFim);
  if (!raios.length) return null;
  const escanteios = eventos.filter(e => e.tipo_evento === 'escanteio' && e.minuto >= minIni - 3 && e.minuto <= minFim + 3);
  let melhor = null;
  for (const r of raios) {
    const bate = escanteios.some(c => c.lado === r.lado && Math.abs(c.minuto - r.minuto) <= 3);
    if (bate && (melhor == null || r.minuto < melhor)) melhor = r.minuto;
  }
  return melhor;
}

function checaJanela6min180(jogo, ateMin) {
  const momentum = jogo.momentum || [];
  const mByMin = {};
  for (const m of momentum) mByMin[m.minuto] = m;
  for (const [lado, campo] of [['casa', 'valor_casa'], ['fora', 'valor_fora']]) {
    for (let fim = 6; fim <= ateMin; fim++) {
      const vals = [];
      for (let mi = fim - 5; mi <= fim; mi++) {
        if (mByMin[mi] == null) { vals.length = 0; break; }
        vals.push(Math.abs(mByMin[mi][campo] || 0));
      }
      if (vals.length < 6) continue;
      const media = vals.reduce((a, b) => a + b, 0) / 6;
      if (media >= 180) return fim;
    }
  }
  return null;
}

function checaJanela6min180_2T(jogo, ateMin) {
  const momentum = jogo.momentum || [];
  const mByMin = {};
  for (const m of momentum) mByMin[m.minuto] = m;
  for (const [lado, campo] of [['casa', 'valor_casa'], ['fora', 'valor_fora']]) {
    for (let fim = 46; fim <= ateMin; fim++) {
      const vals = [];
      for (let mi = fim - 5; mi <= fim; mi++) {
        if (mByMin[mi] == null) { vals.length = 0; break; }
        vals.push(Math.abs(mByMin[mi][campo] || 0));
      }
      if (vals.length < 6) continue;
      const media = vals.reduce((a, b) => a + b, 0) / 6;
      if (media >= 180) return fim;
    }
  }
  return null;
}

const ODDS_REFERENCIA_OBSERVADOR = {
  pressao_gonza:      { htAte20: 1.20, limite: 1.11 },
  trocacao_gonza:      { ht: 1.41, limite: 1.11 },
  tempestade_gonza:    { ht: 1.41, limite: 1.11 },
  raio_gol_5min:       { htAte20: 1.59, limiteJanela4660: 1.28 },
  janela6min180:        { limite1T: 1.11 },
  chuva_de_cantos:     { htAte20: 1.55, limite: 1.05 },
  ta_relampegando:     { htAte15: 1.40, limite: 1.07 },
  relampago_triangular:{ htAte15: 1.41, limite: 1.11 },
};

// ════════════════════════════════════════════════════════════════
// ── 23/09 — TABELA "MANDANTE FAVORITO ≤1,7" (feature 2, indicação ──
// ── de valor). Odds justas por indicador, cortes min10/min20, JÁ  ──
// ── cruzadas com estratégia/Seleção IA (estudo do dia 23/09, base ──
// ── de 29.522 jogos). Over 3,5 ainda não temos pra esse recorte   ──
// ── especifico — fica de fora por enquanto, sem inventar número.  ──
// ════════════════════════════════════════════════════════════════
const ODDS_FAVORITO_CASA_17 = {
  trocacao_gonza:       { min10:{ n:88,  overHT:1.31, over05:1.02, over15:1.28, over25:1.66 }, min20:{ n:168, overHT:1.40, over05:1.04, over15:1.31, over25:1.79 } },
  tempestade_gonza:     { min10:{ n:324, overHT:1.36, over05:1.05, over15:1.22, over25:1.60 }, min20:{ n:617, overHT:1.48, over05:1.07, over15:1.29, over25:1.73 } },
  pressao_gonza:        { min10:{ n:606, overHT:1.40, over05:1.05, over15:1.26, over25:1.65 }, min20:{ n:1221,overHT:1.50, over05:1.07, over15:1.32, over25:1.81 } },
  janela6min180:        { min10:{ n:95,  overHT:1.32, over05:1.01, over15:1.25, over25:1.56 }, min20:{ n:305, overHT:1.45, over05:1.04, over15:1.31, over25:1.69 } },
  chuva_de_cantos:      { min10:{ n:189, overHT:1.47, over05:1.04, over15:1.26, over25:1.59 }, min20:{ n:464, overHT:1.54, over05:1.05, over15:1.30, over25:1.73 } },
  ta_relampegando:      { min10:{ n:457, overHT:1.38, over05:1.06, over15:1.26, over25:1.67 }, min20:{ n:881, overHT:1.50, over05:1.07, over15:1.33, over25:1.84 } },
  relampago_triangular: { min10:{ n:687, overHT:1.42, over05:1.06, over15:1.27, over25:1.70 }, min20:{ n:1242,overHT:1.49, over05:1.07, over15:1.31, over25:1.83 } },
};
const LABEL_INDICADOR_VALOR = {
  trocacao_gonza: '🥊 Trocação Gonza', tempestade_gonza: '⛈️ Tempestade Cruzada',
  pressao_gonza: '🟣 Pressão Gonza', janela6min180: '📊 Janela 6min/180',
  chuva_de_cantos: '🌧️🚩 Chuva de Cantos', ta_relampegando: '⚡⚡⚡ Tá Relampegando',
  relampago_triangular: '⚡🔺 Relâmpago Triangular',
};

// Devolve o bloco HTML de "indicação de valor" pra um indicador que bateu
// num jogo com mandante favorito<=1,7 e placar ainda 0x0 no momento do
// disparo — compara a odd justa do ESTUDO (base historica, com estrategia)
// contra a odd do jogo especifico (calculadora, estado.overs). Só mostra
// quando as duas existem; "valor" = odd do indicador <= odd da calculadora
// (ou seja, o indicador aponta uma taxa igual/melhor que a calculadora já
// dava sem saber que o indicador ia bater).
function indicacaoDeValorHTML(indicadorKey, minutoTrigger, jogo, estado) {
  const tabela = ODDS_FAVORITO_CASA_17[indicadorKey];
  if (!tabela) return '';
  const oc = parseFloat(jogo.odd_inicial_casa || jogo.odd_casa);
  const of_ = parseFloat(jogo.odd_inicial_fora || jogo.odd_fora);
  if (!isFinite(oc) || !isFinite(of_) || oc > of_ || oc > 1.7) return '';
  const golsCasa = parseInt(jogo.gols_casa) || 0;
  const golsFora = parseInt(jogo.gols_fora) || 0;
  if (golsCasa !== 0 || golsFora !== 0) return ''; // só faz sentido com 0x0 no momento do disparo
  if (!estado.overs) return '';

  let bucket;
  if (minutoTrigger <= 10) bucket = tabela.min10;
  else if (minutoTrigger <= 20) bucket = tabela.min20;
  else return '';
  if (!bucket) return '';

  const linhas = [];
  const pares = [
    ['Over 1,5', bucket.over15, estado.overs.over15],
    ['Over 2,5', bucket.over25, estado.overs.over25],
  ];
  for (const [label, oddIndicador, pctCalculadora] of pares) {
    if (oddIndicador == null || pctCalculadora == null) continue;
    const oddCalculadora = pctParaOdd(pctCalculadora);
    if (oddCalculadora == null) continue;
    const temValor = oddIndicador <= oddCalculadora + 0.001;
    const corVal = temValor ? '#3fb950' : '#8b949e';
    const marca = temValor ? '✓ valor' : '—';
    linhas.push(`<tr><td style="padding:3px 8px;">${label}</td><td style="padding:3px 8px;">${oddCalculadora.toFixed(2)}</td><td style="padding:3px 8px;">${oddIndicador.toFixed(2)}</td><td style="padding:3px 8px;color:${corVal};font-weight:600;">${marca}</td></tr>`);
  }
  if (!linhas.length) return '';
  return `<table style="width:100%;font-size:11px;border-collapse:collapse;margin-top:4px;color:#c9d1d9;">
    <tr style="color:#8b949e;text-align:left;"><th style="padding:3px 8px;">Mercado</th><th style="padding:3px 8px;">Calculadora</th><th style="padding:3px 8px;">Indicador</th><th style="padding:3px 8px;">Valor?</th></tr>
    ${linhas.join('')}
  </table>`;
}

function registrarObservacao(jogoId, jogo, indicadorKey, minuto, mercado, oddRef, estado) {
  estado.observadorRegistrado = estado.observadorRegistrado || {};
  const chave = `${indicadorKey}_${minuto}_${mercado}`;
  if (estado.observadorRegistrado[chave]) return;
  estado.observadorRegistrado[chave] = true;

  observadorLog.push({
    jogoId,
    jogo: `${jogo.mandante} x ${jogo.visitante}`,
    data: dataHoje(),
    hora: horaBRT(),
    indicador: indicadorKey,
    minuto,
    mercado,
    oddRef,
    placarNoMomento: `${parseInt(jogo.gols_casa)||0}x${parseInt(jogo.gols_fora)||0}`,
  });
  salvarArquivo(OBSERVADOR_FILE, observadorLog);
}

// ════════════════════════════════════════════════════════════════
// ── 23/09 — FEATURE 3: combos estrategia×indicador fortes pra     ──
// ── Over 2,5 (estudo do dia 18/09, matriz completa, filtrado a    ──
// ── odd<=1,60 e n>=25 — exclui Padrao Gonza HT, que nao temos     ──
// ── checagem live implementada). Quando a estrategia do jogo E o  ──
// ── indicador que bateu formam um par dessa lista, mostra a odd   ──
// ── justa de Over 2,5 como sugestao extra no observador.          ──
// ════════════════════════════════════════════════════════════════
const OVER25_COMBOS_FORTES = [
  { strat:'over05_ht', ind:'janela6min180', odd:1.17 },
  { strat:'lay_0x1_ia', ind:'chuva_de_cantos', odd:1.29 },
  { strat:'lay_0x1_ia', ind:'janela6min180', odd:1.30 },
  { strat:'over05_ht', ind:'chuva_de_cantos', odd:1.35 },
  { strat:'over05_ht', ind:'pressao_gonza', odd:1.36 },
  { strat:'lay_0x1_ia', ind:'tempestade_gonza', odd:1.39 },
  { strat:'favorito_ht_gonza', ind:'janela6min180', odd:1.42 },
  { strat:'lay_manu4', ind:'tempestade_gonza', odd:1.43 },
  { strat:'back_gonza_xg', ind:'janela6min180', odd:1.46 },
  { strat:'over15_ia', ind:'tempestade_gonza', odd:1.46 },
  { strat:'lay_0x1_ia', ind:'pressao_gonza', odd:1.46 },
  { strat:'ambas_marcam', ind:'tempestade_gonza', odd:1.47 },
  { strat:'ambas_marcam', ind:'pressao_gonza', odd:1.51 },
  { strat:'back_gonza_xg', ind:'chuva_de_cantos', odd:1.52 },
  { strat:'over05_ht', ind:'tempestade_gonza', odd:1.54 },
  { strat:'ambas_marcam', ind:'ta_relampegando', odd:1.54 },
  { strat:'over15_ia', ind:'pressao_gonza', odd:1.54 },
  { strat:'favorito_ht_gonza', ind:'trocacao_gonza', odd:1.55 },
  { strat:'lay_0x1_ia', ind:'trocacao_gonza', odd:1.55 },
  { strat:'back_gonza_xg', ind:'pressao_gonza', odd:1.55 },
  { strat:'over15_ia', ind:'chuva_de_cantos', odd:1.56 },
  { strat:'lay_0x1_ia', ind:'ta_relampegando', odd:1.56 },
  { strat:'over05_ht', ind:'ta_relampegando', odd:1.57 },
  { strat:'over15_ia', ind:'ta_relampegando', odd:1.58 },
  { strat:'over05_ht', ind:'relampago_triangular', odd:1.58 },
  { strat:'favorito_ht_gonza', ind:'pressao_gonza', odd:1.59 },
];
function buscaOver25ComboForte(stratKeys, indicadorKey) {
  for (const combo of OVER25_COMBOS_FORTES) {
    if (combo.ind === indicadorKey && stratKeys.includes(combo.strat)) return combo;
  }
  return null;
}

function calculadoraCompleta(estado) {
  if (!estado.overs) return null;
  const o = estado.overs;
  const item = (label, pct) => {
    if (pct == null) return null;
    const odd = pctParaOdd(pct);
    return odd != null ? `${label} <b>${odd.toFixed(2)}</b>` : null;
  };
  const partes = [
    item('Over HT', o.overHT),
    item('Over 1,5 HT', o.over15HT),
    item('Over 0,5', o.over05),
    item('Over 1,5', o.over15),
    item('Over 2,5', o.over25),
    item('Over 3,5', o.over35),
  ].filter(Boolean);
  return partes.length ? `🧮 ${partes.join(' &middot; ')}` : null;
}

function mediaProximoGolHTML(jogo, estado) {
  if (!estado.overs) return null;
  const golsCasa = parseInt(jogo.gols_casa) || 0;
  const golsFora = parseInt(jogo.gols_fora) || 0;
  const bucket = getBucketDinamico(golsCasa, golsFora);
  const label = { '05': 'Over 0,5', '15': 'Over 1,5', '25': 'Over 2,5', '35': 'Over 3,5' }[bucket];
  const taxa = estado.overs[`over${bucket}`];
  if (taxa == null) return null;
  const odd = pctParaOdd(taxa);
  return odd != null ? `🧮 Média próximo gol: <b>${odd.toFixed(2)}</b> (${label})` : null;
}

function nomesComOdd(jogo) {
  const oc  = parseFloat(jogo.odd_inicial_casa || jogo.odd_casa);
  const of_ = parseFloat(jogo.odd_inicial_fora || jogo.odd_fora);
  const ocTxt = isFinite(oc) ? ` (${oc.toFixed(2)})` : '';
  const ofTxt = isFinite(of_) ? ` (${of_.toFixed(2)})` : '';
  return `${jogo.mandante}${ocTxt} x ${jogo.visitante}${ofTxt}`;
}

function obsBlocoIndicadores(jogo, estado, hoje) {
  const tempoNum = parseInt(jogo.tempo) || 0;
  const passouHT = !!estado.passouHT;
  const jogoId = `${jogo.mandante}_${jogo.visitante}`;
  const golsCasaAgora = parseInt(jogo.gols_casa) || 0;
  const golsForaAgora = parseInt(jogo.gols_fora) || 0;
  const stratKeysJogo = getEstrategiasKeys(jogo, hoje);

  function linhaOddJogo(tempoRef) {
    const bucket = getBucketDinamico(golsCasaAgora, golsForaAgora);
    const labelFT = { '05':'Over 0,5', '15':'Over 1,5', '25':'Over 2,5', '35':'Over 3,5' }[bucket];
    const mercadoFT = `over${bucket}`;
    const taxaFT = estado.overs ? estado.overs[mercadoFT] : null;
    const partes = [];

    if (tempoRef <= 20) {
      const mercadoHT = bucket === '05' ? 'over05HT' : 'over15HT';
      const labelHT = bucket === '05' ? 'Over 0,5 HT' : 'Over 1,5 HT';
      const taxaHT = estado.overs ? estado.overs[mercadoHT] : null;
      if (taxaHT != null) {
        const oddHT = pctParaOdd(taxaHT);
        if (oddHT != null) partes.push(`${labelHT} ${oddHT.toFixed(2)} (${taxaHT.toFixed(0)}%)`);
      }
    }
    if (taxaFT != null) {
      const oddFT = pctParaOdd(taxaFT);
      if (oddFT != null) partes.push(`${labelFT} Limite ${oddFT.toFixed(2)} (${taxaFT.toFixed(0)}%)`);
    }
    return partes.length ? ` · 🧮 odd do jogo: ${partes.join(' / ')}` : '';
  }

  estado.observadorEventos = estado.observadorEventos || [];
  estado.observadorRegistrado = estado.observadorRegistrado || {};

  function addEvento(chave, minuto, texto, indicadorKey, mercado, oddRef, extraHTML) {
    if (estado.observadorRegistrado[chave]) return;
    estado.observadorRegistrado[chave] = true;
    estado.observadorEventos.push({ minuto, texto: texto + (extraHTML || '') });
    registrarObservacao(jogoId, jogo, indicadorKey, minuto, mercado, oddRef, estado);
  }

  // 23/09 — monta o extra (indicação de valor + sugestão Over 2,5 combo)
  // pra um indicador que acabou de bater — reaproveitado nos vários
  // indicadores do 1T abaixo.
  function extrasIndicador(indicadorKey, minutoTrigger) {
    let html = '';
    const valorHTML = indicacaoDeValorHTML(indicadorKey, minutoTrigger, jogo, estado);
    if (valorHTML) html += `<div style="margin-top:4px;">${valorHTML}</div>`;
    const combo = buscaOver25ComboForte(stratKeysJogo, indicadorKey);
    if (combo) {
      html += `<div style="font-size:11px;color:#d4a017;margin-top:4px;">⭐ Combo forte pra Over 2,5 (${STRAT_DISPLAY[combo.strat]||combo.strat} + este indicador) — odd justa <b>${combo.odd.toFixed(2)}</b></div>`;
    }
    return html;
  }

  for (const ev of (jogo.eventos || [])) {
    if (ev.tipo_evento !== 'gol') continue;
    const chave = `gol_${ev.minuto}_${ev.lado}`;
    if (estado.observadorRegistrado[chave]) continue;
    const golsCasaAteAqui = (jogo.eventos || []).filter(e => e.tipo_evento === 'gol' && e.lado === 'casa' && e.minuto <= ev.minuto).length;
    const golsForaAteAqui = (jogo.eventos || []).filter(e => e.tipo_evento === 'gol' && e.lado === 'fora' && e.minuto <= ev.minuto).length;
    const ladoTxt = ev.lado === 'casa' ? jogo.mandante : jogo.visitante;
    addEvento(chave, ev.minuto, `⚽ Gol aos ${ev.minuto}' — ${ladoTxt} (${golsCasaAteAqui}x${golsForaAteAqui})`, 'gol', '-', null);
  }

  if (!passouHT && tempoNum > 0) {
    const pg = checaPressaoGonza(jogo, estado, 'casa', tempoNum) || checaPressaoGonza(jogo, estado, 'fora', tempoNum);
    if (pg) {
      const minuto = pg.minutoChute || tempoNum;
      const janelaTxt = `${Math.max(1, tempoNum - 4)}-${tempoNum}'`;
      const emoji = pg.tipo === 'gonza2' ? '🔵 Gonza 2' : '🟣 Pressão Gonza';
      addEvento(`pressao_gonza_${minuto}_HT/Limite`, minuto,
        `${emoji} — bateu (janela ${janelaTxt})${linhaOddJogo(tempoNum)}`,
        'pressao_gonza', 'HT/Limite', ODDS_REFERENCIA_OBSERVADOR.pressao_gonza.htAte20,
        extrasIndicador('pressao_gonza', minuto));
    }

    const cc = checaChuvaDeCantos(jogo, 1, tempoNum);
    if (cc != null) {
      addEvento(`chuva_de_cantos_${cc}_HT/Limite`, cc,
        `🌧️🚩 Chuva de Cantos — bateu ${cc}'${linhaOddJogo(cc)}`,
        'chuva_de_cantos', 'HT/Limite', ODDS_REFERENCIA_OBSERVADOR.chuva_de_cantos.htAte20,
        extrasIndicador('chuva_de_cantos', cc));
    }

    const trel = checaTaRelampegando(jogo, 1, tempoNum);
    if (trel != null) {
      addEvento(`ta_relampegando_${trel}_HT/Limite`, trel,
        `⚡⚡⚡ Tá Relampegando — bateu ${trel}'${linhaOddJogo(trel)}`,
        'ta_relampegando', 'HT/Limite', ODDS_REFERENCIA_OBSERVADOR.ta_relampegando.htAte15,
        extrasIndicador('ta_relampegando', trel));
    }

    const rtri = checaRelampagoTriangular(jogo, 1, tempoNum);
    if (rtri != null) {
      addEvento(`relampago_triangular_${rtri}_HT/Limite`, rtri,
        `⚡🔺 Relâmpago Triangular — bateu ${rtri}'${linhaOddJogo(rtri)}`,
        'relampago_triangular', 'HT/Limite', ODDS_REFERENCIA_OBSERVADOR.relampago_triangular.htAte15,
        extrasIndicador('relampago_triangular', rtri));
    }

    const tr = checaTrocacaoGonza(jogo, tempoNum);
    if (tr != null) {
      addEvento(`trocacao_gonza_${tr}_HT/Limite`, tr,
        `🥊 Trocação Gonza — bateu no min ${tr}${linhaOddJogo(tr)}`,
        'trocacao_gonza', 'HT/Limite', ODDS_REFERENCIA_OBSERVADOR.trocacao_gonza.ht,
        extrasIndicador('trocacao_gonza', tr));
    }

    const te = checaTempestadeCruzadaGonza(jogo, tempoNum);
    if (te != null) {
      addEvento(`tempestade_gonza_${te}_HT/Limite`, te,
        `⛈️ Tempestade Cruzada Gonza — bateu no min ${te}${linhaOddJogo(te)}`,
        'tempestade_gonza', 'HT/Limite', ODDS_REFERENCIA_OBSERVADOR.tempestade_gonza.ht,
        extrasIndicador('tempestade_gonza', te));
    }

    const rg = checaRaioGol5min(jogo, 0, Math.min(tempoNum, 25));
    if (rg != null) {
      addEvento(`raio_gol_5min_${rg}_HT`, rg,
        `⚡ Raio+Gol (5min) — gol no min ${rg} com raio próximo${linhaOddJogo(rg)}`,
        'raio_gol_5min', 'HT', ODDS_REFERENCIA_OBSERVADOR.raio_gol_5min.htAte20);
    }

    const j6 = checaJanela6min180(jogo, Math.min(tempoNum, 45));
    if (j6 != null) {
      addEvento(`janela6min180_${j6}_Limite`, j6,
        `📊 Janela 6min média≥180 — bateu no min ${j6}${linhaOddJogo(j6)}`,
        'janela6min180', 'Limite', ODDS_REFERENCIA_OBSERVADOR.janela6min180.limite1T,
        extrasIndicador('janela6min180', j6));
    }
  }

  if (passouHT && tempoNum >= 46 && tempoNum <= 70) {
    const pg2 = checaPressaoGonza(jogo, estado, 'casa', tempoNum) || checaPressaoGonza(jogo, estado, 'fora', tempoNum);
    if (pg2) {
      const minuto2 = pg2.minutoChute || tempoNum;
      const janelaTxt2 = `${Math.max(46, tempoNum - 4)}-${tempoNum}'`;
      const emoji2 = pg2.tipo === 'gonza2' ? '🔵 Gonza 2, 2T' : '🟣 Pressão Gonza, 2T';
      addEvento(`pressao_gonza_2t_${minuto2}_HT/Limite`, minuto2,
        `${emoji2} — bateu (janela ${janelaTxt2})${linhaOddJogo(999)}`,
        'pressao_gonza_2t', 'Limite', ODDS_REFERENCIA_OBSERVADOR.pressao_gonza.limite);
    }

    const cc2 = checaChuvaDeCantos(jogo, 46, Math.min(tempoNum, 70));
    if (cc2 != null) {
      addEvento(`chuva_de_cantos_2t_${cc2}_Limite`, cc2,
        `🌧️🚩 Chuva de Cantos, 2T — bateu ${cc2}'${linhaOddJogo(999)}`,
        'chuva_de_cantos_2t', 'Limite', ODDS_REFERENCIA_OBSERVADOR.chuva_de_cantos.limite);
    }

    const trel2 = checaTaRelampegando(jogo, 46, Math.min(tempoNum, 70));
    if (trel2 != null) {
      addEvento(`ta_relampegando_2t_${trel2}_Limite`, trel2,
        `⚡⚡⚡ Tá Relampegando, 2T — bateu ${trel2}'${linhaOddJogo(999)}`,
        'ta_relampegando_2t', 'Limite', ODDS_REFERENCIA_OBSERVADOR.ta_relampegando.limite);
    }

    const rtri2 = checaRelampagoTriangular(jogo, 46, Math.min(tempoNum, 70));
    if (rtri2 != null) {
      addEvento(`relampago_triangular_2t_${rtri2}_Limite`, rtri2,
        `⚡🔺 Relâmpago Triangular, 2T — bateu ${rtri2}'${linhaOddJogo(999)}`,
        'relampago_triangular_2t', 'Limite', ODDS_REFERENCIA_OBSERVADOR.relampago_triangular.limite);
    }

    const tr2 = checaTrocacaoGonza2T(jogo, Math.min(tempoNum, 70));
    if (tr2 != null) {
      addEvento(`trocacao_gonza_2t_${tr2}_Limite`, tr2,
        `🥊 Trocação Gonza, 2T — bateu no min ${tr2}${linhaOddJogo(999)}`,
        'trocacao_gonza_2t', 'Limite', ODDS_REFERENCIA_OBSERVADOR.trocacao_gonza.limite);
    }

    const te2 = checaTempestadeCruzadaGonza2T(jogo, Math.min(tempoNum, 70));
    if (te2 != null) {
      addEvento(`tempestade_gonza_2t_${te2}_Limite`, te2,
        `⛈️ Tempestade Cruzada Gonza, 2T — bateu no min ${te2}${linhaOddJogo(999)}`,
        'tempestade_gonza_2t', 'Limite', ODDS_REFERENCIA_OBSERVADOR.tempestade_gonza.limite);
    }

    const rg2 = checaRaioGol5min(jogo, 46, Math.min(tempoNum, 60));
    if (rg2 != null) {
      addEvento(`raio_gol_5min_2t_${rg2}_Limite`, rg2,
        `⚡ Raio+Gol (5min), 2T — gol no min ${rg2} com raio próximo${linhaOddJogo(999)}`,
        'raio_gol_5min_2t', 'Limite', ODDS_REFERENCIA_OBSERVADOR.raio_gol_5min.limiteJanela4660);
    }

    const j6_2t = checaJanela6min180_2T(jogo, Math.min(tempoNum, 70));
    if (j6_2t != null) {
      addEvento(`janela6min180_2t_${j6_2t}_Limite`, j6_2t,
        `📊 Janela 6min média≥180, 2T — bateu no min ${j6_2t}${linhaOddJogo(999)}`,
        'janela6min180_2t', 'Limite', ODDS_REFERENCIA_OBSERVADOR.janela6min180.limite1T);
    }
  }

  if (!estado.observadorEventos.length) return '<p class="ms-muted ms-small">Nenhum indicador bateu ainda nesse jogo.</p>';
  const ordenados = [...estado.observadorEventos].sort((a, b) => a.minuto - b.minuto);
  return ordenados.map(e => `<p class="obs-linha">${e.texto}</p>`).join('');
}

function getEstrategiasKeys(jogo, hoje) {
  const pendJogo = pendentes.filter(p =>
    p.data === hoje && p.tipo === 'pre' &&
    (p.home === jogo.mandante || p.jogo === `${jogo.mandante} x ${jogo.visitante}`)
  );
  return [...new Set(pendJogo.map(p => p.strat))];
}

function getEstrategiasBadgeHTML(strats) {
  if (!strats.length) return '';
  const nomes = strats.map(k => STRAT_DISPLAY[k] || k).join(' · ');
  return `<p class="obs-linha" style="opacity:0.85;font-size:12px;">${nomes}</p>`;
}

app.get('/observador', (req, res) => {
  const jogosAtivos = Object.entries(estadoLive).filter(([, e]) => !e.encerrado && e.jogo);
  if (!jogosAtivos.length) {
    return res.send(msPaginaHTML('<p class="ms-empty">Nenhum jogo ao vivo no momento.</p>'));
  }

  const hoje = dataHoje();

  function montaCard(jogo, estado, comEstrategia, eventosHTML) {
    const tempoTxt = jogo.tempo === 'Intervalo' ? 'Intervalo' : jogo.tempo === 'Encerrado' ? 'Encerrado' : `${jogo.tempo}'`;
    const ni = estado.novoIndicador;

    let estiloExtra = comEstrategia ? 'border:1px solid #2c2c30;' : 'border:1px solid #202023;opacity:0.9;';
    let tagHTML = '';
    if (ni?.comboTag) {
      estiloExtra = 'border:1.5px solid #f0b429;';
      tagHTML = `<p style="font-size:11px;font-weight:700;color:#f0b429;margin:0 0 8px;background:#f0b42920;display:inline-block;padding:3px 8px;border-radius:6px;">${ni.comboTag}</p>`;
    } else if (ni?.semDestaqueHoraCheia) {
      estiloExtra = 'opacity:0.6;';
    }

    const strats = getEstrategiasKeys(jogo, hoje);
    const badgeEstrategias = getEstrategiasBadgeHTML(strats);
    const calcHTML = comEstrategia
      ? calculadoraCompleta(estado)
      : mediaProximoGolHTML(jogo, estado);
    const calcBloco = calcHTML
      ? `<p class="obs-linha" style="margin-top:8px;background:#101012;border-radius:8px;padding:6px 10px;font-size:12px;color:#9a9a96;">${calcHTML}</p>`
      : '';

    return `<div class="ms-jogo" style="${estiloExtra}">
      <div class="ms-jogo-header">
        <p class="ms-jogo-nome">${nomesComOdd(jogo)}</p>
        <p class="ms-muted ms-small">${tempoTxt} &middot; placar ${jogo.gols_casa}x${jogo.gols_fora}</p>
      </div>
      ${tagHTML}
      ${badgeEstrategias}
      ${eventosHTML}
      ${calcBloco}
    </div>`;
  }

  const comEstrategia = [];
  const semEstrategia = [];

  for (const [jogoId, estado] of jogosAtivos) {
    const jogo = estado.jogo;
    const eventosHTML = obsBlocoIndicadores(jogo, estado, hoje);
    const strats = getEstrategiasKeys(jogo, hoje);
    const temEstrategia = strats.length > 0;

    if (temEstrategia) {
      comEstrategia.push({ jogo, estado, eventosHTML, comboForte: !!estado.novoIndicador?.comboTag });
    } else {
      const temIndicador = !eventosHTML.includes('Nenhum indicador bateu ainda');
      if (temIndicador) semEstrategia.push({ jogo, estado, eventosHTML });
    }
  }

  comEstrategia.sort((a, b) => (b.comboForte ? 1 : 0) - (a.comboForte ? 1 : 0));

  const blocoComEstrategia = comEstrategia
    .map(x => montaCard(x.jogo, x.estado, true, x.eventosHTML)).join('');
  const blocoSemEstrategia = semEstrategia
    .map(x => montaCard(x.jogo, x.estado, false, x.eventosHTML)).join('');

  const tituloComEstrategia = `<p class="ms-periodo" style="margin-top:0;">Com estratégia / Seleção IA &mdash; ${comEstrategia.length} jogo(s)</p>`;
  const tituloSemEstrategia = `<p class="ms-periodo">Sem estratégia &mdash; só aparecem quando algum indicador bate &mdash; ${semEstrategia.length} jogo(s)</p>`;

  const corpo =
    (comEstrategia.length ? tituloComEstrategia + blocoComEstrategia : '<p class="ms-muted ms-small">Nenhum jogo com estratégia/Seleção IA ao vivo agora.</p>') +
    (semEstrategia.length ? tituloSemEstrategia + blocoSemEstrategia : '');

  res.send(msPaginaHTML(`<p class="ms-muted" style="margin-bottom:12px;">🔍 Observador — ${jogosAtivos.length} jogo(s) ao vivo · não manda nada, só pra acompanhar</p><p style="margin-bottom:16px;"><a href="/observador/historico" style="color:#4fd1c5;">📜 Ver histórico de hoje</a> &middot; <a href="/combo-possiveis" style="color:#4fd1c5;">⭐ Combos possíveis do dia</a></p>${corpo}`));
});

// ════════════════════════════════════════════════════════════════
// ── 23/09 — FEATURE 1: "Combos possíveis do dia" — mostra, ANTES  ──
// ── de qualquer indicador disparar, quais jogos de hoje já têm    ──
// ── uma das estratégias do Combo HT e/ou Combo Gol batida pré-live.──
// ── Pura leitura de `pendentes`, nao depende de jogo estar ao vivo.──
// ════════════════════════════════════════════════════════════════
app.get('/combo-possiveis', (req, res) => {
  const hoje = dataHoje();
  const pendHoje = pendentes.filter(p => p.data === hoje && p.tipo === 'pre');

  const porJogo = {};
  for (const p of pendHoje) {
    const k = p.hora + '|' + p.jogo;
    if (!porJogo[k]) porJogo[k] = { hora: p.hora, jogo: p.jogo, strats: new Set() };
    porJogo[k].strats.add(p.strat);
  }

  const candidatos = [];
  for (const info of Object.values(porJogo)) {
    const stratsArr = [...info.strats];
    const combosHT = stratsArr.filter(s => ESTRATEGIAS_COMBO_HT.includes(s));
    const combosGol = stratsArr.filter(s => ESTRATEGIAS_COMBO_GOL.includes(s));
    if (!combosHT.length && !combosGol.length) continue;
    candidatos.push({ ...info, combosHT, combosGol });
  }
  candidatos.sort((a, b) => a.hora.localeCompare(b.hora));

  if (!candidatos.length) {
    return res.send(msPaginaHTML('<p><a href="/observador" style="color:#4fd1c5;">← Voltar pro observador</a></p><p class="ms-empty">Nenhum jogo de hoje com estratégia do Combo HT/Gol batida pré-live ainda.</p>'));
  }

  const corpo = candidatos.map(c => {
    const badges = [];
    if (c.combosHT.length) badges.push(`<span style="background:#f0b42920;color:#f0b429;font-size:11px;padding:3px 8px;border-radius:6px;margin-right:6px;">Combo HT: ${c.combosHT.map(s => STRAT_DISPLAY[s]||s).join(' · ')}</span>`);
    if (c.combosGol.length) badges.push(`<span style="background:#4fd1c520;color:#4fd1c5;font-size:11px;padding:3px 8px;border-radius:6px;">Combo Gol: ${c.combosGol.map(s => STRAT_DISPLAY[s]||s).join(' · ')}</span>`);
    return `<div class="ms-jogo">
      <div class="ms-jogo-header">
        <p class="ms-jogo-nome">${c.jogo}</p>
        <p class="ms-muted ms-small">${c.hora}</p>
      </div>
      <div>${badges.join(' ')}</div>
    </div>`;
  }).join('');

  res.send(msPaginaHTML(`<p><a href="/observador" style="color:#4fd1c5;">← Voltar pro observador</a></p><p class="ms-muted" style="margin:12px 0;">⭐ Combos possíveis hoje — jogos que já têm estratégia do Combo HT/Gol batida pré-live, mesmo antes de qualquer indicador ao vivo confirmar (${candidatos.length} jogo(s))</p>${corpo}`));
});

app.get('/observador/historico', (req, res) => {
  const dataFiltro = (req.query.data || dataHoje()).trim();
  const registros = observadorLog
    .filter(r => r.data === dataFiltro)
    .sort((a, b) => (b.data + b.hora).localeCompare(a.data + a.hora));

  if (!registros.length) {
    return res.send(msPaginaHTML(`<p><a href="/observador">← Voltar pro observador</a></p><p class="ms-empty">Nenhuma observação registrada em ${dataFiltro} ainda.</p>`));
  }

  const LABEL_INDICADOR = {
    pressao_gonza: '🟣 Pressão Gonza',
    trocacao_gonza: '🥊 Trocação Gonza',
    tempestade_gonza: '⛈️ Tempestade Cruzada Gonza',
    raio_gol_5min: '⚡ Raio+Gol (5min)',
    raio_gol_5min_2t: '⚡ Raio+Gol (5min), 2T',
    janela6min180: '📊 Janela 6min média≥180',
    chuva_de_cantos: '🌧️🚩 Chuva de Cantos',
    chuva_de_cantos_2t: '🌧️🚩 Chuva de Cantos, 2T',
    ta_relampegando: '⚡⚡⚡ Tá Relampegando',
    ta_relampegando_2t: '⚡⚡⚡ Tá Relampegando, 2T',
    relampago_triangular: '⚡🔺 Relâmpago Triangular',
    relampago_triangular_2t: '⚡🔺 Relâmpago Triangular, 2T',
  };

  const corpo = registros.map(r => `
    <div class="ms-jogo">
      <div class="ms-jogo-header">
        <p class="ms-jogo-nome">${r.jogo}</p>
        <p class="ms-muted ms-small">${r.hora} &middot; min ${r.minuto} &middot; placar ${r.placarNoMomento}</p>
      </div>
      <p class="obs-linha">${LABEL_INDICADOR[r.indicador] || r.indicador} · mercado ${r.mercado} · odd ref. ${r.oddRef}</p>
    </div>`).join('');

  res.send(msPaginaHTML(`<p><a href="/observador">← Voltar pro observador</a></p><p class="ms-muted" style="margin:12px 0;">📜 Histórico — ${dataFiltro} (${registros.length} observação(ões))</p>${corpo}`));
});

app.get('/', (req, res) => res.json({
  status: 'ok', version: 'server_75',
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

app.get('/validacao-novos-indicadores', (req, res) => {
  const greens = validacaoNovosIndicadores.filter(v => v.status === 'green').length;
  const reds = validacaoNovosIndicadores.filter(v => v.status === 'red').length;
  const pendentesV = validacaoNovosIndicadores.filter(v => v.status === 'pendente').length;
  res.json({
    total: validacaoNovosIndicadores.length,
    greens, reds, pendentes: pendentesV,
    taxa: (greens + reds) > 0 ? (greens / (greens + reds)) : null,
    registros: validacaoNovosIndicadores,
  });
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

app.get('/interno/exportar-momentum', (req, res) => {
  if (!INTERNAL_TOKEN || req.query.token !== INTERNAL_TOKEN) {
    return res.status(403).send('Token inválido.');
  }
  if (!fs.existsSync(MOMENTUM_HISTORICO_FILE)) {
    return res.status(404).send('Arquivo momentum_historico.json não encontrado.');
  }

  const desde = (req.query.desde || '').trim();
  if (!desde) {
    return res.download(MOMENTUM_HISTORICO_FILE, 'momentum_historico.json');
  }

  const filtrado = {};
  for (const [confronto, lista] of Object.entries(momentumHistorico)) {
    const mantidos = lista.filter(reg => {
      const dataJogo = (reg.jogo?.data || '').slice(0, 10);
      return dataJogo >= desde;
    });
    if (mantidos.length) filtrado[confronto] = mantidos;
  }

  res.setHeader('Content-Disposition', `attachment; filename="momentum_desde_${desde}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(filtrado));
});

app.get('/interno/exportar-historico-futats', (req, res) => {
  if (!INTERNAL_TOKEN || req.query.token !== INTERNAL_TOKEN) {
    return res.status(403).send('Token inválido.');
  }

  const pastaHistorico = process.env.FUTATS_HIST_DIR || '/app/data/futats-historico';
  if (!fs.existsSync(pastaHistorico)) {
    return res.status(404).send('Pasta de histórico não encontrada — o download ainda não rodou.');
  }

  const desde = (req.query.desde || '').trim();
  const ate = (req.query.ate || '').trim();

  const arquivos = fs.readdirSync(pastaHistorico)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .filter(f => {
      const dataStr = f.replace('.json', '');
      if (desde && dataStr < desde) return false;
      if (ate && dataStr > ate) return false;
      return true;
    })
    .sort();

  if (arquivos.length === 0) {
    return res.status(404).send('Nenhum arquivo encontrado nesse intervalo.');
  }

  const todosOsJogos = [];
  for (const nomeArquivo of arquivos) {
    try {
      const conteudo = JSON.parse(fs.readFileSync(path.join(pastaHistorico, nomeArquivo), 'utf8'));
      const jogosDoDia = conteudo?.[0]?.eventos || conteudo;
      if (Array.isArray(jogosDoDia)) {
        todosOsJogos.push(...jogosDoDia);
      }
    } catch (err) {
      console.error(`Erro lendo ${nomeArquivo}: ${err.message}`);
    }
  }

  const nomeDownload = desde || ate
    ? `historico_futats_${desde || 'inicio'}_a_${ate || 'fim'}.json`
    : 'historico_futats_completo.json';

  res.setHeader('Content-Disposition', `attachment; filename="${nomeDownload}"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(todosOsJogos));
});

app.get('/interno/status-historico-futats', (req, res) => {
  if (!INTERNAL_TOKEN || req.query.token !== INTERNAL_TOKEN) {
    return res.status(403).send('Token inválido.');
  }

  const pastaHistorico = process.env.FUTATS_HIST_DIR || '/app/data/futats-historico';
  if (!fs.existsSync(pastaHistorico)) {
    return res.status(404).json({ erro: 'Pasta de histórico não encontrada.' });
  }

  const arquivos = fs.readdirSync(pastaHistorico)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();

  let totalJogos = 0;
  for (const nomeArquivo of arquivos) {
    try {
      const conteudo = JSON.parse(fs.readFileSync(path.join(pastaHistorico, nomeArquivo), 'utf8'));
      const jogosDoDia = conteudo?.[0]?.eventos || conteudo;
      if (Array.isArray(jogosDoDia)) totalJogos += jogosDoDia.length;
    } catch (err) {}
  }

  res.json({
    total_dias: arquivos.length,
    total_jogos: totalJogos,
    primeiro_dia: arquivos[0]?.replace('.json',''),
    ultimo_dia: arquivos[arquivos.length-1]?.replace('.json',''),
  });
});

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
  await sendTelegram('✅ FUTATS Server v45c funcionando! 🎯');
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
  console.log(`FUTATS Server v75 na porta ${PORT}`);

  await buscarPreJogo();

  agendarHoraBRT(8,  0, buscarPreJogo);
  agendarHoraBRT(12, 30, buscarPreJogo);
  agendarHoraBRT(19, 0, buscarPreJogo);

  setInterval(monitorarLive, 60 * 1000);

  agendarHoraBRT(8,  0, enviarCardMatinal);
  agendarHoraBRT(18, 0, enviarResumoDia);
  agendarHoraBRT(0,  0, enviarResumoECard);

  await sendTelegram(
    '🚀 <b>FUTATS Server v75 iniciado!</b>\n' +
    '🆕 Combos possíveis do dia — nova página /combo-possiveis, mostra ANTES do jogo começar quais já têm estratégia do Combo HT/Gol batida pré-live\n' +
    '🆕 Indicação de valor — pra jogos com mandante favorito ≤1,7 e 0x0, compara a odd justa do indicador com a odd da calculadora do jogo (Over 1,5/2,5), mostrando "✓ valor" quando o indicador bate ou supera\n' +
    '🆕 Sugestão de Over 2,5 — quando bate uma das combinações fortes estratégia×indicador (odd≤1,60 validada), mostra a odd justa de Over 2,5 direto no observador\n' +
    '(demais mudanças mantidas do server_70)'
  );

  await enviarCardMatinal();
});

const { main: baixarHistoricoFutats } = require('./baixar_historico.js');

setInterval(() => {
  baixarHistoricoFutats().catch(err => {
    console.error('[baixar_historico] erro:', err.message);
  });
}, 15 * 60 * 1000);

console.log('[baixar_historico] agendador ativo — roda automaticamente entre 01h-04h BRT');
