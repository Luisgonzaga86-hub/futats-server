// filters.js
// Decide se um jogo deve entrar na fila de análise automática.
// Regra: qualquer uma das 3 categorias abaixo preenchida já qualifica o jogo.
//
// Nomes de campo confirmados em 20/07 contra o JSON real (mesmos usados no
// server_45.js, que já roda em produção com esses nomes há tempo):
// selecao_ia, filtros_partida, estrategias_partida.
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
  const filtrosPersonalizados = (jogoRaw.filtros_partida || '').trim();
  const estrategias = (jogoRaw.estrategias_partida || '').trim();
  return selecaoIA.length > 0 || filtrosPersonalizados.length > 0 || estrategias.length > 0;
}
// Função principal: recebe o jogo (como salvo no store) e diz se qualifica
function qualificaParaAnalise(jogoSalvo) {
  const raw = jogoSalvo.stats_pre_raw || {};
  if (!ligaPermitida(jogoSalvo.campeonato)) return false;
  return temSelecaoOuFiltro(raw);
}
module.exports = { qualificaParaAnalise, LIGAS_PERMITIDAS };
