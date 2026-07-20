// futatsClient.js
// Busca a lista de jogos do dia na API pre-stats da Futats.
// Timeout de 300s conforme recomendação do manual da API (processamento pesado).
const fetch = require('node-fetch');
const store = require('./store');

// ⚠️ 20/07 — Descoberto que FUTATS_PRE_URL (api-games-pre) só traz Seleção IA
// (selecao_ia) + stats_pre. Filtros e Estratégias (bolinhas) nunca vinham
// junto — vêm de 2 endpoints separados, mesmo padrão já usado no server_45.js
// (server de alertas ao vivo). Derivamos a base a partir do FUTATS_PRE_URL
// pra não precisar de 2 variáveis de ambiente novas.
function baseUrlFutats() {
  return (process.env.FUTATS_PRE_URL || '').replace(/\/api-games-pre\/?$/, '');
}

async function futatsGet(endpoint) {
  const url = `${baseUrlFutats()}/${endpoint}`;
  const token = process.env.FUTATS_TOKEN;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);
  try {
    const resp = await fetch(url, { headers: { 'x-token': token }, signal: controller.signal });
    if (!resp.ok) throw new Error(`Futats API (${endpoint}) respondeu ${resp.status}`);
    const data = await resp.json();
    return data[0]?.eventos || [];
  } finally {
    clearTimeout(timeout);
  }
}

// Chave de casamento entre os 3 endpoints — mesmo critério usado no
// server_45.js (mandante+visitante), já validado em produção lá.
function chaveJogo(jogo) {
  return `${jogo.mandante}_${jogo.visitante}`;
}

async function buscarJogosDoDia() {
  const url = process.env.FUTATS_PRE_URL;
  const token = process.env.FUTATS_TOKEN;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000); // 300s = 5 min
  try {
    const resp = await fetch(url, {
      headers: { 'x-token': token },
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`Futats API respondeu ${resp.status}`);
    }
    const data = await resp.json();
    const eventos = data[0]?.eventos || [];
    console.log(`[futatsClient] ${eventos.length} jogos recebidos (api-games-pre).`);

    // Busca filtros e estratégias em paralelo — se algum falhar, segue só
    // com o que já temos (não trava o pull inteiro por causa de 1 endpoint).
    let filtrosEventos = [];
    let estrategiasEventos = [];
    try {
      [filtrosEventos, estrategiasEventos] = await Promise.all([
        futatsGet('api-games-filtros'),
        futatsGet('api-games-estrategias'),
      ]);
      console.log(`[futatsClient] ${filtrosEventos.length} jogos com filtros, ${estrategiasEventos.length} jogos com estratégias.`);
    } catch (err) {
      console.error('[futatsClient] Falha ao buscar filtros/estratégias, seguindo só com Seleção IA:', err.message);
    }

    const mapaFiltros = new Map(filtrosEventos.map((j) => [chaveJogo(j), j.filtros_partida || '']));
    const mapaEstrategias = new Map(estrategiasEventos.map((j) => [chaveJogo(j), j.estrategias_partida || '']));

    // Salva/atualiza cada jogo no armazenamento (upsert = nunca duplica)
    for (const jogo of eventos) {
      const chave = chaveJogo(jogo);
      // Mescla filtros/estratégias direto no objeto bruto também, pra que
      // filters.js (que lê de stats_pre_raw) enxergue os campos certos.
      jogo.filtros_partida = mapaFiltros.get(chave) || '';
      jogo.estrategias_partida = mapaEstrategias.get(chave) || '';

      store.upsertGame({
        id: jogo.id,
        mandante: jogo.mandante,
        visitante: jogo.visitante,
        data: jogo.data,
        hora: jogo.hora,
        pais: jogo.pais,
        campeonato: jogo.campeonato,
        odd_casa: jogo.odd_casa,
        odd_empate: jogo.odd_empate,
        odd_fora: jogo.odd_fora,
        selecao_ia: jogo.selecao_ia || '',
        filtros_partida: jogo.filtros_partida,
        estrategias_partida: jogo.estrategias_partida,
        stats_pre_raw: jogo, // guarda o jogo inteiro (já com filtros/estratégias mesclados)
      });
    }
    return eventos.length;
  } finally {
    clearTimeout(timeout);
  }
}
module.exports = { buscarJogosDoDia };
