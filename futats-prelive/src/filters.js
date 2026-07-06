// filters.js
// Decide se um jogo deve entrar na fila de análise automática.
// Regra: qualquer uma das 3 categorias abaixo preenchida já qualifica o jogo.
//
// ⚠️ IMPORTANTE: os nomes exatos dos campos abaixo (selecao_ia, filtros_personalizados,
// estrategias) precisam ser conferidos contra o JSON real que a API da Futats devolve.
// Hoje sabemos que "selecao_ia" existe (string separada por vírgula). Os outros dois
// (Filtros personalizados / Estratégias-bolinhas) podem vir com outro nome de campo —
// ajustar aqui assim que virmos o JSON de um pull automático real.

// Ligas que você quer acompanhar sempre (edite essa lista à vontade).
// Deixe a lista vazia [] para permitir TODAS as ligas.
const LIGAS_PERMITIDAS = [
  // exemplo: 'Norwegian 1st Division', 'Chinese Super League', 'Allsvenskan'
  // vazio = sem restrição de liga, só o filtro de bolinha/seleção decide
];

function ligaPermitida(campeonato) {
  if (LIGAS_PERMITIDAS.length === 0) return true;
  return LIGAS_PERMITIDAS.includes(campeonato);
}

function temSelecaoOuFiltro(jogoRaw) {
  const selecaoIA = (jogoRaw.selecao_ia || '').trim();
  const filtrosPersonalizados = (jogoRaw.filtros_personalizados || '').trim();
  const estrategias = (jogoRaw.estrategias || jogoRaw.bolinhas || '').trim();

  return selecaoIA.length > 0 || filtrosPersonalizados.length > 0 || estrategias.length > 0;
}

// Função principal: recebe o jogo (como salvo no store) e diz se qualifica
function qualificaParaAnalise(jogoSalvo) {
  const raw = jogoSalvo.stats_pre_raw || {};
  if (!ligaPermitida(jogoSalvo.campeonato)) return false;
  return temSelecaoOuFiltro(raw);
}

module.exports = { qualificaParaAnalise, LIGAS_PERMITIDAS };
