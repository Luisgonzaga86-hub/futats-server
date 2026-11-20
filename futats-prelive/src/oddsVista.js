// oddsVista.js
// 19/11 — Registro das odds do Over 0,5 HT que o Luis VÊ ao vivo no momento do
// alerta (favorito até 1,60), pra comparar com a odd pré-jogo e medir quanto a
// odd sobe por minuto. Só acrescenta linhas (JSONL) em data/odds_vista.jsonl
// (volume persistente do Railway). O minuto/estratégia do alerta NÃO é
// gravado aqui: vem do histórico do Telegram; aqui ficam o jogo, a odd e a hora
// exata do clique em Salvar (pra estimar o atraso do alerta).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ARQUIVO = path.join(DATA_DIR, 'odds_vista.jsonl');

function garantirPasta() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function parseOdd(v) {
  const n = parseFloat(String(v == null ? '' : v).trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 1.01 && n <= 50 ? n : null;
}

// Data e hora de Brasília (UTC-3) a partir de um instante
function brt(d) {
  const b = new Date(d.getTime() - 3 * 3600 * 1000).toISOString();
  return { data: b.slice(0, 10), hora: b.slice(11, 19) };
}

// registro = { id, data, hora, mandante, visitante, campeonato, odd_fav, over05ht_pre, odd_vista }
function salvar(registro) {
  garantirPasta();
  const agora = new Date();
  const b = brt(agora);
  const linha = {
    salvo_em: agora.toISOString(),
    salvo_data_brt: b.data,
    salvo_hora_brt: b.hora,
    ...registro,
  };
  fs.appendFileSync(ARQUIVO, JSON.stringify(linha) + '\n');
  return linha;
}

function listar() {
  garantirPasta();
  if (!fs.existsSync(ARQUIVO)) return [];
  const out = [];
  for (const l of fs.readFileSync(ARQUIVO, 'utf-8').split('\n')) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch (_) {}
  }
  return out;
}

// Registros de um jogo (por id), em ordem de gravação
function doJogo(id) {
  return listar().filter((r) => String(r.id) === String(id));
}

const COLUNAS = [
  'salvo_data_brt', 'salvo_hora_brt', 'data', 'hora', 'mandante', 'visitante', 'campeonato',
  'odd_fav', 'over05ht_pre', 'odd_vista', 'id',
];

function csv(registros) {
  const esc = (v) => String(v == null ? '' : v).replace(/;/g, ',').replace(/\r?\n/g, ' ');
  return [COLUNAS.join(';')]
    .concat(registros.map((r) => COLUNAS.map((c) => esc(r[c])).join(';')))
    .join('\n');
}

module.exports = { salvar, listar, doJogo, parseOdd, csv, brt };
