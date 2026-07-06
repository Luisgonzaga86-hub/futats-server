// futatsClient.js
// Busca a lista de jogos do dia na API pre-stats da Futats.
// Timeout de 300s conforme recomendação do manual da API (processamento pesado).

const fetch = require('node-fetch');
const store = require('./store');

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

    console.log(`[futatsClient] ${eventos.length} jogos recebidos.`);

    // Salva/atualiza cada jogo no armazenamento (upsert = nunca duplica)
    for (const jogo of eventos) {
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
        stats_pre_raw: jogo, // guarda o jogo inteiro pra usar na análise depois
      });
    }

    return eventos.length;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { buscarJogosDoDia };
