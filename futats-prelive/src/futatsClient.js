// futatsClient.js
// Busca a lista de jogos do dia na API pre-stats da Futats.
// Timeout de 300s conforme recomendação do manual da API (processamento pesado).
const fetch = require('node-fetch');
const store = require('./store');
const oddsStore = require('./oddsStore');

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

    // Salva/atualiza todos os jogos de uma vez (upsert = nunca duplica)
    const paraSalvar = [];
    for (const jogo of eventos) {
      const chave = chaveJogo(jogo);
      // Mescla filtros/estratégias direto no objeto bruto também, pra que
      // filters.js (que lê de stats_pre_raw) enxergue os campos certos.
      jogo.filtros_partida = mapaFiltros.get(chave) || '';
      jogo.estrategias_partida = mapaEstrategias.get(chave) || '';

      paraSalvar.push({
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
    store.upsertGames(paraSalvar);
    return eventos.length;
  } finally {
    clearTimeout(timeout);
  }
}

// 21/09 — busca jogos ao vivo/encerrados (api-games-live, mesma API usada
// pelo server live) e salva o placar final de quem já tiver os baldes
// calculados localmente e ainda não tem resultado_final salvo. Usado só
// pro histórico de confiabilidade (comparar previsão vs resultado real) —
// não mexe em nada do fluxo de análise paga.
async function buscarResultadosFinais() {
  let eventos;
  try {
    eventos = await futatsGet('api-games-live');
  } catch (err) {
    console.error('[futatsClient] Falha ao buscar api-games-live:', err.message);
    return 0;
  }

  const encerrados = eventos.filter((j) => j.tempo === 'Encerrado');
  if (!encerrados.length) return 0;

  const pendentes = store.getPendingResultadoFinal();
  if (!pendentes.length) return 0;

  let atualizados = 0;
  for (const jogoLive of encerrados) {
    const jogoStore = pendentes.find(
      (g) => g.mandante === jogoLive.mandante && g.visitante === jogoLive.visitante
    );
    if (!jogoStore) continue;

    const golsCasa = parseInt(jogoLive.gols_casa, 10) || 0;
    const golsFora = parseInt(jogoLive.gols_fora, 10) || 0;
    store.markResultadoFinal(jogoStore.id, golsCasa, golsFora);
    atualizados++;
  }

  if (atualizados > 0) console.log(`[futatsClient] ${atualizados} resultado(s) final(is) salvos.`);
  return atualizados;
}

// 28/10 — API de odds pré-jogo (api-games-odds): jogos das próximas 10-12h que
// têm odds. Mesmo host e mesmo x-token das outras. Timeout 60s + 2 retries
// (recomendação do dono da API). Grava cada captura em odds_historico.jsonl
// (fora do games.json) com a hora da captura. Falha aqui nunca derruba nada.
function urlOdds() {
  return process.env.FUTATS_ODDS_URL || `${baseUrlFutats()}/api-games-odds`;
}

async function buscarOdds(janela) {
  const tentativas = 3; // 1 chamada + 2 retries
  let ultimoErro;
  for (let i = 1; i <= tentativas; i++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const resp = await fetch(urlOdds(), {
        headers: { 'x-token': process.env.FUTATS_TOKEN },
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`api-games-odds respondeu ${resp.status}`);
      const data = await resp.json();
      const eventos = data[0]?.eventos || [];
      const n = oddsStore.salvarCaptura(eventos, janela);
      console.log(`[futatsClient] odds (${janela}): ${n} jogos gravados.`);
      return n;
    } catch (err) {
      ultimoErro = err;
      console.error(`[futatsClient] odds tentativa ${i}/${tentativas} falhou: ${err.message}`);
      if (i < tentativas) await new Promise((r) => setTimeout(r, 5000));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw ultimoErro;
}

module.exports = { buscarJogosDoDia, buscarResultadosFinais, buscarOdds };
