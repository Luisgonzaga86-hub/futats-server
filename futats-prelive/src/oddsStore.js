// oddsStore.js
// Guarda cada leitura da API de odds pré-jogo (api-games-odds) num arquivo
// SEPARADO do games.json, só acrescentando linhas (JSONL). Cada linha = 1 jogo
// em 1 captura, com a hora exata da captura. Assim dá pra saber depois qual
// odd estava disponível em cada horário (a API não traz data de captura).
// Fica em data/ (volume persistente do Railway, /app/data).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ARQUIVO = path.join(DATA_DIR, 'odds_historico.jsonl');
const ESTADO = path.join(DATA_DIR, 'odds_estado.json'); // janelas já coletadas (arquivo pequeno)

function garantirPasta() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Grava uma captura inteira. Retorna quantos jogos foram gravados.
function salvarCaptura(eventos, janela) {
  garantirPasta();
  const capturadoEm = new Date().toISOString();
  const linhas = eventos.map((e) =>
    JSON.stringify({
      capturado_em: capturadoEm,
      janela,
      id: e.id,
      data: e.data,
      hora: e.hora,
      pais: e.pais,
      campeonato: e.campeonato,
      mandante: e.mandante,
      visitante: e.visitante,
      over_15_back: num(e.over_15_back),
      over_25_back: num(e.over_25_back),
      over_35_back: num(e.over_35_back),
      btts_yes_back: num(e.btts_yes_back),
      over_05_ht_back: num(e.over_05_ht_back),
    })
  );
  if (linhas.length) fs.appendFileSync(ARQUIVO, linhas.join('\n') + '\n');
  return linhas.length;
}

// Última odd conhecida de cada jogo (chave mandante_visitante). Lê só o fim do
// arquivo (últimos ~3 MB) pra não pesar. Usado depois pra páginas/múltipla.
function ultimasOddsPorJogo() {
  garantirPasta();
  if (!fs.existsSync(ARQUIVO)) return new Map();
  const { size } = fs.statSync(ARQUIVO);
  const tam = Math.min(size, 3 * 1024 * 1024);
  const fd = fs.openSync(ARQUIVO, 'r');
  const buf = Buffer.alloc(tam);
  fs.readSync(fd, buf, 0, tam, size - tam);
  fs.closeSync(fd);
  const linhas = buf.toString('utf-8').split('\n').filter(Boolean);
  if (size > tam) linhas.shift(); // primeira linha pode estar cortada
  const mapa = new Map();
  for (const l of linhas) {
    try {
      const o = JSON.parse(l);
      mapa.set(`${o.mandante}_${o.visitante}`, o); // linhas mais novas sobrescrevem
      if (o.id) mapa.set(`id:${o.id}`, o); // o id das odds é o mesmo id do pré-jogo (confirmado 30/10)
    } catch (_) {}
  }
  return mapa;
}

function lerEstado() {
  try { return JSON.parse(fs.readFileSync(ESTADO, 'utf-8')); } catch (_) { return {}; }
}

function jaColetouHoje(janela) {
  const chave = `${new Date().toISOString().slice(0, 10)}_${janela}`;
  return !!lerEstado()[chave];
}

// Minutos desde a última coleta bem-sucedida (Infinity se nunca coletou)
function minutosDesdeUltimaColeta() {
  const e = lerEstado();
  return e.ultima ? (Date.now() - new Date(e.ultima).getTime()) / 60000 : Infinity;
}

// Falhou: empurra a próxima tentativa pra daqui a `esperaMin` minutos
// (simula uma coleta feita há (intervaloMin - esperaMin) minutos).
function adiarProximaTentativa(intervaloMin, esperaMin) {
  garantirPasta();
  const estado = lerEstado();
  estado.ultima = new Date(Date.now() - (intervaloMin - esperaMin) * 60000).toISOString();
  fs.writeFileSync(ESTADO, JSON.stringify(estado));
}

function marcarColetado(janela) {
  garantirPasta();
  const estado = lerEstado();
  estado.ultima = new Date().toISOString();
  const hoje = new Date().toISOString().slice(0, 10);
  estado[`${hoje}_${janela}`] = new Date().toISOString();
  // mantém só os últimos 10 dias
  const corte = Date.now() - 10 * 86400000;
  for (const k of Object.keys(estado)) if (new Date(estado[k]).getTime() < corte) delete estado[k];
  fs.writeFileSync(ESTADO, JSON.stringify(estado));
}

module.exports = { salvarCaptura, ultimasOddsPorJogo, jaColetouHoje, marcarColetado, minutosDesdeUltimaColeta, adiarProximaTentativa };
