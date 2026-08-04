// store.js
// Guarda tudo em um arquivo JSON simples (data/games.json).
// Não precisa de banco de dados separado — mais fácil de configurar e de olhar por dentro.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'games.json');

// Garante que a pasta/arquivo existem antes de qualquer leitura
function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ jogos: {}, pulls: {} }, null, 2));
}

function readAll() {
  ensureFile();
  return JSON.parse(fs.readFileSync(FILE, 'utf-8'));
}

function writeAll(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

// Salva ou atualiza um jogo (usa o "id" do jogo como chave única pra nunca duplicar)
function upsertGame(game) {
  const data = readAll();
  const existing = data.jogos[game.id];
  data.jogos[game.id] = {
    ...existing,
    ...game,
    // preserva campos de controle se já existirem
    analisado: existing?.analisado ?? false,
    analise: existing?.analise ?? null,
    conferido: existing?.conferido ?? false,
    resultado_real: existing?.resultado_real ?? null,
    // cálculo local (grátis, via calculadora.js) — separado da análise
    // completa (paga, via API). Um jogo pode ter calculado=true e
    // analisado=false por muito tempo, se os baldes não valerem a pena.
    calculado: existing?.calculado ?? false,
    calculo: existing?.calculo ?? null,
  };
  writeAll(data);
}

// Salva o resultado do cálculo local (calculadora.js) — não envolve API,
// só marca os baldes de confiança calculados a partir do stats_pre.
function markCalculado(id, calculoResultado) {
  const data = readAll();
  if (!data.jogos[id]) return;
  data.jogos[id].calculado = true;
  data.jogos[id].calculo = calculoResultado;
  writeAll(data);
}

function getGame(id) {
  const data = readAll();
  return data.jogos[id] || null;
}

function getAllGames() {
  const data = readAll();
  return Object.values(data.jogos);
}

// Jogos de hoje que ainda não foram analisados NEM estão sendo processados agora
// (o "processando" é a trava que impede disparo duplicado — ver markProcessing)
function getPendingGames() {
  return getAllGames().filter((g) => !g.analisado && !g.processando);
}

// Marca o jogo como "em processamento" — trava contra duplicação.
// Retorna true se conseguiu travar (pode seguir), false se outro ciclo já travou primeiro.
function markProcessing(id) {
  const data = readAll();
  const jogo = data.jogos[id];
  if (!jogo) return false;

  // se já está processando há mais que o timeout, considera travado (crash/erro) e libera de novo
  if (jogo.processando) {
    const desde = new Date(jogo.processando_desde || 0);
    const minutosProcessando = (Date.now() - desde.getTime()) / 60000;
    if (minutosProcessando < 10) return false; // ainda dentro do prazo normal, não deixa duplicar
  }

  jogo.processando = true;
  jogo.processando_desde = new Date().toISOString();
  writeAll(data);
  return true;
}

// Libera a trava se a análise falhar no meio do processo (permite tentar de novo depois)
function markProcessingFailed(id) {
  const data = readAll();
  if (!data.jogos[id]) return;
  data.jogos[id].processando = false;
  writeAll(data);
}

// Marca um jogo como analisado e salva o texto da análise
function markAnalyzed(id, analiseTexto, analiseEstruturada) {
  const data = readAll();
  if (!data.jogos[id]) return;
  data.jogos[id].analisado = true;
  data.jogos[id].processando = false;
  data.jogos[id].analise = analiseTexto;
  data.jogos[id].analise_estruturada = analiseEstruturada;
  data.jogos[id].analisado_em = new Date().toISOString();
  writeAll(data);
}

// Marca o resultado real e a conferência de calibração
function markConferido(id, resultado, comparacao) {
  const data = readAll();
  if (!data.jogos[id]) return;
  data.jogos[id].conferido = true;
  data.jogos[id].resultado_real = resultado;
  data.jogos[id].comparacao = comparacao;
  writeAll(data);
}

// Controle de qual "janela de pull" (07:30, 12:00, 18:30, 00:00) já rodou hoje
function jaPuxouHoje(janela) {
  const data = readAll();
  const chave = `${new Date().toISOString().slice(0, 10)}_${janela}`;
  return !!data.pulls[chave];
}

function marcarPullFeito(janela) {
  const data = readAll();
  const chave = `${new Date().toISOString().slice(0, 10)}_${janela}`;
  data.pulls[chave] = new Date().toISOString();
  writeAll(data);
}

// Jogos de hoje que ainda não tiveram o cálculo local rodado (independente
// de já estarem analisados ou não — o cálculo é sempre a base, grátis)
function getPendingCalculo() {
  return getAllGames().filter((g) => !g.calculado);
}

module.exports = {
  upsertGame,
  getGame,
  getAllGames,
  getPendingGames,
  getPendingCalculo,
  markAnalyzed,
  markCalculado,
  markProcessing,
  markProcessingFailed,
  markConferido,
  jaPuxouHoje,
  marcarPullFeito,
};
