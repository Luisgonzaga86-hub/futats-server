// scheduler.js
// Duas responsabilidades:
// 1) Puxar a API da Futats nos 4 horários recomendados pelo manual (uma vez por janela/dia)
// 2) A cada poucos minutos, checar se algum jogo qualificado está a ~50min do kickoff
//    e ainda não foi analisado — se sim, dispara a análise e manda pro Telegram

const cron = require('node-cron');
const store = require('./store');
const filters = require('./filters');
const futatsClient = require('./futatsClient');
const { analisarJogo } = require('./claudeAnalyzer');
const { enviarMensagem } = require('./telegram');

const MINUTOS_ANTES = 50;
const JANELA_TOLERANCIA_MIN = 5; // roda o check a cada 5 min, então aceita uma folga de +-5min

// -------- Parte 1: pulls automáticos nos 4 horários --------

async function checarEExecutarPull(janela, horaInicio, horaFim) {
  const agora = new Date();
  const horaAtual = agora.getHours() + agora.getMinutes() / 60;

  if (horaAtual >= horaInicio && horaAtual <= horaFim && !store.jaPuxouHoje(janela)) {
    console.log(`[scheduler] Executando pull da janela ${janela}...`);
    try {
      await futatsClient.buscarJogosDoDia();
      store.marcarPullFeito(janela);
    } catch (err) {
      console.error(`[scheduler] Falha no pull ${janela}:`, err.message);
    }
  }
}

// -------- Parte 2: disparo de análise 50min antes do kickoff --------

function minutosAteKickoff(jogo) {
  const dataJogo = new Date(jogo.data); // vem em formato ISO (ex: 2026-07-05T00:00:00.000Z)
  const [h, m] = jogo.hora.split(':').map(Number);
  const kickoff = new Date(dataJogo);
  kickoff.setUTCHours(h, m, 0, 0); // ajuste de fuso: confirmar se "hora" já vem em horário local ou UTC

  const agora = new Date();
  return (kickoff - agora) / 60000; // diferença em minutos
}

async function processarAnaliseDoJogo(jogo, motivo) {
  console.log(`[scheduler] Analisando: ${jogo.mandante} x ${jogo.visitante} (${motivo})`);
  try {
    const textoAnalise = await analisarJogo(jogo.stats_pre_raw);
    store.markAnalyzed(jogo.id, textoAnalise, null);

    await enviarMensagem(textoAnalise, 'pessoal');
    await enviarMensagem(textoAnalise, 'canal');

    console.log(`[scheduler] Análise enviada: ${jogo.mandante} x ${jogo.visitante}`);
  } catch (err) {
    console.error(`[scheduler] Erro ao analisar ${jogo.mandante} x ${jogo.visitante}:`, err.message);
  }
}

async function checarJogosProntosParaAnalise() {
  const pendentes = store.getPendingGames();

  for (const jogo of pendentes) {
    const faltam = minutosAteKickoff(jogo);

    // já passou do jogo — não faz mais sentido analisar, marca como "perdido" implicitamente (fica pendente, mas ignorado)
    if (faltam < -10) continue;

    const dentroDaJanela = faltam <= MINUTOS_ANTES + JANELA_TOLERANCIA_MIN && faltam >= MINUTOS_ANTES - JANELA_TOLERANCIA_MIN;

    if (dentroDaJanela && filters.qualificaParaAnalise(jogo)) {
      await processarAnaliseDoJogo(jogo, 'automático, 50min antes');
    }
  }
}

// -------- Inicialização dos crons --------

function iniciar() {
  // Roda a cada 5 minutos: checa pulls e checa jogos prontos pra análise
  cron.schedule('*/5 * * * *', async () => {
    await checarEExecutarPull('manha', 7.5, 8.5);
    await checarEExecutarPull('meio_dia', 12, 13);
    await checarEExecutarPull('noite', 18.5, 19.5);
    await checarEExecutarPull('madrugada', 0, 1);

    await checarJogosProntosParaAnalise();
  });

  console.log('[scheduler] Agendador iniciado — checando a cada 5 minutos.');
}

module.exports = { iniciar, processarAnaliseDoJogo };
