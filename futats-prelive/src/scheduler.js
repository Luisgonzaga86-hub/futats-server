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
const TIMEOUT_PROCESSAMENTO_MIN = 10; // se travar processando por mais que isso, libera pra tentar de novo

// Brasília é sempre UTC-3 (sem horário de verão desde 2019). Isso funciona
// independente do fuso horário configurado no servidor (Railway roda em UTC).
function horaBrasiliaAtual() {
  const agora = new Date();
  let h = agora.getUTCHours() + agora.getUTCMinutes() / 60 - 3;
  if (h < 0) h += 24;
  return h;
}

// -------- Parte 1: pulls automáticos nos 4 horários --------

async function checarEExecutarPull(janela, horaInicio, horaFim) {
  const horaAtual = horaBrasiliaAtual();

  if (horaAtual >= horaInicio && horaAtual <= horaFim && !store.jaPuxouHoje(janela)) {
    console.log(`[scheduler] Executando pull da janela ${janela}... (hora Brasília: ${horaAtual.toFixed(2)})`);
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
  const dataJogo = new Date(jogo.data); // vem em formato ISO (ex: 2026-07-05T00:00:00.000Z), meia-noite UTC do dia
  const [h, m] = jogo.hora.split(':').map(Number);

  // A Futats informa "hora" em horário de Brasília (UTC-3). Convertendo pra UTC
  // somando 3h — Date.UTC() normaliza sozinho se passar de 24h (vira o dia seguinte).
  const kickoffUTC = new Date(
    Date.UTC(dataJogo.getUTCFullYear(), dataJogo.getUTCMonth(), dataJogo.getUTCDate(), h + 3, m, 0, 0)
  );

  const agora = new Date();
  return (kickoffUTC - agora) / 60000; // diferença em minutos
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
    store.markProcessingFailed(jogo.id); // libera o jogo pra tentar de novo no próximo ciclo
  }
}

async function checarJogosProntosParaAnalise() {
  const pendentes = store.getPendingGames();

  for (const jogo of pendentes) {
    const faltam = minutosAteKickoff(jogo);

    // já passou muito do jogo — não faz mais sentido analisar
    if (faltam < -10) continue;

    const dentroDaJanela = faltam <= MINUTOS_ANTES + JANELA_TOLERANCIA_MIN && faltam >= MINUTOS_ANTES - JANELA_TOLERANCIA_MIN;

    if (!dentroDaJanela) continue;

    const qualifica = filters.qualificaParaAnalise(jogo);
    console.log(
      `[scheduler] Avaliando ${jogo.mandante} x ${jogo.visitante} | faltam ${faltam.toFixed(1)}min | qualifica: ${qualifica} | selecao_ia: "${jogo.selecao_ia || ''}"`
    );

    if (!qualifica) continue;

    // Trava IMEDIATA antes de qualquer await — impede que o próximo ciclo do
    // cron (5 min depois) pegue o mesmo jogo ainda "pendente" e dispare de novo.
    const travou = store.markProcessing(jogo.id);
    if (!travou) continue; // outro ciclo já pegou esse jogo primeiro

    await processarAnaliseDoJogo(jogo, 'automático, 50min antes');
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
