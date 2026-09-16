// baixar_historico.js
// Job de download em background da API historica do FUTATS.
// Roda todo dia numa janela de horario de baixo movimento (01h-04h BRT),
// baixando um dia por vez, com 30s de intervalo entre chamadas
// (pedido do dono da API). Para automaticamente ao fim da janela e
// retoma na proxima madrugada de onde parou — nao precisa terminar tudo
// numa noite so, mas com ~257 dias e 30s de delay (~2h09min no total),
// normalmente completa numa unica janela de 3h.
//
// Uso: node baixar_historico.js
// Agendar via cron do Railway para rodar todo dia as 01:00 BRT
// (cron expression, em UTC: '0 4 * * *' já que BRT = UTC-3).

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://gz.futats.com/opta/api-games-live-day';
// Nota: no teste via Insomnia essa rota funcionou sem precisar de token —
// diferente das outras rotas do FUTATS que usam header x-token. Deixando
// como variavel opcional, caso precise no futuro (ex: se o dono adicionar
// autenticacao depois).
const FUTATS_TOKEN = process.env.FUTATS_TOKEN || null;
const DELAY_MS = 30 * 1000; // 30 segundos entre chamadas, conforme pedido
const DATA_INICIO = '2026-01-01';
const PASTA_SAIDA = process.env.FUTATS_HIST_DIR || '/data/futats-historico'; // ajustar pro Volume do Railway
const ARQUIVO_PROGRESSO = path.join(PASTA_SAIDA, '_progresso.json');

// Janela de horario permitido (horario de Brasilia, BRT = UTC-3)
const JANELA_INICIO_HORA_BRT = 1; // 01:00
const JANELA_FIM_HORA_BRT = 4;    // 04:00

function horaAtualBRT() {
  const agoraUTC = new Date();
  const horaBRT = (agoraUTC.getUTCHours() - 3 + 24) % 24;
  return horaBRT;
}

function dentroDaJanela() {
  const h = horaAtualBRT();
  // janela 01h-04h nao cruza meia-noite, entao e simples:
  return h >= JANELA_INICIO_HORA_BRT && h < JANELA_FIM_HORA_BRT;
}

function formatarData(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function carregarProgresso() {
  if (fs.existsSync(ARQUIVO_PROGRESSO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_PROGRESSO, 'utf8'));
  }
  return { ultimaDataBaixada: null, diasComErro: [] };
}

function salvarProgresso(progresso) {
  fs.writeFileSync(ARQUIVO_PROGRESSO, JSON.stringify(progresso, null, 2));
}

async function baixarDia(dataStr) {
  const url = `${API_BASE}?data=${dataStr}`;
  const opcoes = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      ...(FUTATS_TOKEN ? { 'x-token': FUTATS_TOKEN } : {})
    }
  };
  const resp = await fetch(url, opcoes);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} para ${dataStr}`);
  }
  const dados = await resp.json();
  return dados;
}

async function main() {
  if (!fs.existsSync(PASTA_SAIDA)) {
    fs.mkdirSync(PASTA_SAIDA, { recursive: true });
  }

  if (!dentroDaJanela()) {
    console.log(`Fora da janela permitida (01h-04h BRT). Hora atual BRT: ${horaAtualBRT()}h. Encerrando sem baixar nada.`);
    return;
  }

  const progresso = carregarProgresso();
  const hoje = new Date();
  const dataInicioObj = progresso.ultimaDataBaixada
    ? new Date(new Date(progresso.ultimaDataBaixada).getTime() + 86400000) // dia seguinte ao ultimo baixado
    : new Date(DATA_INICIO);

  if (dataInicioObj > hoje) {
    console.log('Ja esta tudo baixado ate hoje. Nada a fazer.');
    return;
  }

  console.log(`Iniciando/retomando download a partir de ${formatarData(dataInicioObj)} ate ${formatarData(hoje)}`);
  console.log(`Delay entre chamadas: ${DELAY_MS/1000}s | Janela permitida: ${JANELA_INICIO_HORA_BRT}h-${JANELA_FIM_HORA_BRT}h BRT`);

  let atual = new Date(dataInicioObj);
  let contador = 0;
  let totalJogos = 0;

  while (atual <= hoje) {
    if (!dentroDaJanela()) {
      console.log(`\nFim da janela (04h BRT atingido). Parando aqui — retoma automaticamente na proxima madrugada a partir de ${formatarData(atual)}.`);
      break;
    }

    const dataStr = formatarData(atual);
    const arquivoDestino = path.join(PASTA_SAIDA, `${dataStr}.json`);

    // pula se ja baixado (permite retomar apos interrupcao)
    if (fs.existsSync(arquivoDestino)) {
      console.log(`[${dataStr}] ja existe, pulando`);
      atual.setDate(atual.getDate() + 1);
      continue;
    }

    try {
      const dados = await baixarDia(dataStr);
      const jogos = dados?.[0]?.eventos || dados; // adapta ao formato observado
      const qtdJogos = Array.isArray(jogos) ? jogos.length : 0;
      fs.writeFileSync(arquivoDestino, JSON.stringify(dados));
      totalJogos += qtdJogos;
      contador++;
      console.log(`[${dataStr}] OK — ${qtdJogos} jogos salvos`);

      progresso.ultimaDataBaixada = dataStr;
      salvarProgresso(progresso);
    } catch (err) {
      console.error(`[${dataStr}] ERRO: ${err.message}`);
      progresso.diasComErro.push(dataStr);
      salvarProgresso(progresso);
    }

    atual.setDate(atual.getDate() + 1);

    if (atual <= hoje && dentroDaJanela()) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`\nConcluido esta execucao. ${contador} dias baixados agora, ${totalJogos} jogos no total.`);
  if (progresso.diasComErro.length) {
    console.log(`Dias com erro (retry na proxima execucao): ${progresso.diasComErro.join(', ')}`);
  }
  if (atual <= hoje) {
    console.log(`Restam dias a baixar a partir de ${formatarData(atual)} — a proxima execucao (madrugada seguinte) continua sozinha.`);
  } else {
    console.log('Download historico completo!');
  }
}

// So executa automaticamente quando rodado direto (node baixar_historico.js).
// Quando importado como modulo (require) por outro arquivo como o server.js,
// nao dispara sozinho — quem importa decide quando chamar main().
if (require.main === module) {
  main().catch(err => {
    console.error('Erro fatal:', err);
    process.exit(1);
  });
}

module.exports = { main, dentroDaJanela, horaAtualBRT };
