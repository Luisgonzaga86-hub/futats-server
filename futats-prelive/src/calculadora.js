// calculadora.js
// Motor de cálculo LOCAL do Manual V7 — roda 100% em JavaScript, sem chamar
// a API da Anthropic. Reproduz as partes determinísticas do manual (sistema
// de pontos, cruzamento de xG, cortes de overs, checagem de zebra) pra gerar
// os 3 baldes de confiança (Favorito/Gols/Placar) de graça, pra todo jogo.
//
// O que NÃO dá pra fazer aqui (fica pra análise completa via API):
// - Notícia/desfalque e H2H dos últimos 5 confrontos diretos (exige busca web)
// - Os passos 1-2 do Lay Improvável (definir conclusão geral + ranking de
//   contrariedade) — exige leitura qualitativa do conjunto
// - Por isso, o balde de Favorito aqui NUNCA fecha 🟢 Alta sozinho (falta o
//   4º critério, a notícia) — o teto local é 🟡 Média. Só a análise completa
//   (via API, com busca web) pode confirmar 🟢 Alta de verdade.

// Expected Gol: 0–0.50=EG0 · 0.51–1.50=EG1 · 1.51–2.50=EG2 · 2.51–3.50=EG3 ...
function bandaEG(valor) {
  if (valor == null) return null;
  if (valor <= 0.5) return 0;
  return Math.ceil(valor - 0.5);
}

// ── 1. Sistema de pontos (§2.1) ──────────────────────────────────
// Mandante: 1pt por vitória própria (últimos 5 em casa) + 1pt por derrota
// do visitante (últimos 5 fora dele). Visitante: espelhado. Empate não pontua.
function calcularPontos(home, away) {
  const homeLast5 = (home.previousGames || []).slice(0, 5);
  const awayLast5 = (away.previousGames || []).slice(0, 5);

  const pontosMandante =
    homeLast5.filter((g) => g.resultado === 'W').length +
    awayLast5.filter((g) => g.resultado === 'L').length;

  const pontosVisitante =
    awayLast5.filter((g) => g.resultado === 'W').length +
    homeLast5.filter((g) => g.resultado === 'L').length;

  return { pontosMandante, pontosVisitante };
}

// ── 2. % excelentes (§2.2) ────────────────────────────────────────
function calcularPercentuais(stats) {
  const p = stats.partidas || 0;
  if (!p) return { pctVitorias: 0, pctDerrotas: 0, pctMarcouPrimeiro: 0, excelente: false };
  const pctVitorias = (stats.vitorias / p) * 100;
  const pctDerrotas = (stats.derrotas / p) * 100;
  const pctMarcouPrimeiro = stats.marcou_primeiro != null ? (stats.marcou_primeiro / p) * 100 : null;
  const excelente = pctVitorias >= 75 || pctDerrotas <= 25;
  return { pctVitorias, pctDerrotas, pctMarcouPrimeiro, excelente };
}

// ── 3. Cruzamento de xG (§3.3, regra corrigida 30/06) ────────────
// Sempre lido pela faixa (EG) da DEFESA: se EG_defesa < EG_ataque, a defesa
// PREVALECE e suprime o ataque (não é alerta). Só quando EG_defesa >= EG_ataque
// é que o ataque mantém liberdade de crescer — aí sim é alerta real.
function cruzarXG(xgAtaque, xgaDefesa) {
  const egAtaque = bandaEG(xgAtaque);
  const egDefesa = bandaEG(xgaDefesa);
  if (egAtaque == null || egDefesa == null) return { egAtaque, egDefesa, defesaPrevalece: null };
  return { egAtaque, egDefesa, defesaPrevalece: egDefesa < egAtaque };
}

// ── 4. Overs / BTTS (§4) — cortes fixos ──────────────────────────
// 25/08: adicionado over05 (FT) e over15HT — antes só existiam over15/25/35
// FT e over05HT. Necessários pro comparativo de odds justas nos alertas
// (mercado dinâmico "Over total_atual+0,5", tanto FT quanto HT).
const CORTES = { over05: 90, over15: 75, over25: 55, over35: 43, overHT: 75, over15HT: 40, btts: 60 };

function calcularOvers(overs, home, away) {
  const ph = home.partidas || 0;
  const pa = away.partidas || 0;
  const pct = (o, key, p) => (p ? (o[key] || 0) / p * 100 : 0);

  const over05 = (pct(overs.home, 'over05', ph) + pct(overs.away, 'over05', pa)) / 2;
  const over15 = (pct(overs.home, 'over15', ph) + pct(overs.away, 'over15', pa)) / 2;
  const over25 = (pct(overs.home, 'over25', ph) + pct(overs.away, 'over25', pa)) / 2;
  const over35 = (pct(overs.home, 'over35', ph) + pct(overs.away, 'over35', pa)) / 2;
  const overHT = (pct(overs.home, 'over05HT', ph) + pct(overs.away, 'over05HT', pa)) / 2;
  const over15HT = (pct(overs.home, 'over15HT', ph) + pct(overs.away, 'over15HT', pa)) / 2;
  const btts = ((home.ambas_marcam || 0) / (ph || 1) * 100 + (away.ambas_marcam || 0) / (pa || 1) * 100) / 2;

  const cortesBatidos = [over15 >= CORTES.over15, over25 >= CORTES.over25, over35 >= CORTES.over35, overHT >= CORTES.overHT, btts >= CORTES.btts];
  return { over05, over15, over25, over35, overHT, over15HT, btts, cortesBatidos: cortesBatidos.filter(Boolean).length };
}

// ── 5. Zebra no Top 5 (§5, obrigatório) ──────────────────────────
function checarZebraTop5(projecoes) {
  const top5 = (projecoes || []).slice(0, 5);
  const unders = top5.filter((p) => {
    const [a, b] = (p.placar || '').split('-').map((n) => parseInt(n.trim(), 10));
    return !isNaN(a) && !isNaN(b) && a + b <= 1;
  });
  return { top5, unders, alertaZebra: unders.length >= 2 };
}

// ── 6. Lay Improvável — só os passos mecânicos (3-7), sem H2H ───
// Localmente só dá pra checar "já ocorreu no histórico geral" (própria
// amostra do time) — sem H2H (precisa de busca web), então o teto aqui é
// 🟡 Média mesmo quando "nunca ocorreu" (falta confirmar que H2H não invalida).
function avaliarPlacarLay(home, away, unders) {
  if (unders.length >= 2) return { nivel: 'Baixa', motivo: 'zebra no Top 5 (2+ placares "under")' };

  // Checa se algum placar de baixo total de gols (0x0/1x0/0x1) já ocorreu
  // nos últimos 5 jogos de qualquer um dos dois lados
  const jaOcorreu = (jogos) =>
    (jogos || []).slice(0, 5).some((g) => {
      const total = (g.golsMandante ?? 0) + (g.golsVisitante ?? 0);
      return total <= 1;
    });

  if (jaOcorreu(home.previousGames) || jaOcorreu(away.previousGames)) {
    return { nivel: 'Baixa', motivo: 'placar baixo já ocorreu recente em algum dos lados' };
  }
  return { nivel: 'Média', motivo: 'nunca ocorreu na amostra recente — falta confirmar H2H (só na análise completa)' };
}

// ── 7. Veredito final — os 3 baldes (§11) ────────────────────────
function calcularBaldes(jogoRaw) {
  const sp = (jogoRaw.stats_pre || [])[0];
  if (!sp) return null;

  const home = sp.jogo_inteiro?.home || {};
  const away = sp.jogo_inteiro?.away || {};
  const cg = sp.custo_gol || {};
  const homeCg = cg.home || {};
  const awayCg = cg.away || {};
  const overs = sp.overs || {};
  const projecoes = sp.projecoes?.projecoes || [];

  const oddCasa = parseFloat(jogoRaw.odd_casa);
  const oddFora = parseFloat(jogoRaw.odd_fora);
  const favorito = oddCasa <= oddFora ? 'casa' : 'fora';

  // -- FAVORITO --
  const { pontosMandante, pontosVisitante } = calcularPontos(home, away);
  const pontosFavorito = favorito === 'casa' ? pontosMandante : pontosVisitante;

  const statsFavorito = favorito === 'casa' ? home : away;
  const { pctVitorias, pctDerrotas, excelente: pctExcelente } = calcularPercentuais(statsFavorito);

  const xgFavorito = favorito === 'casa' ? homeCg.xG : awayCg.xG;
  const xgaZebra = favorito === 'casa' ? awayCg.xGA : homeCg.xGA;
  const diffXG = xgFavorito != null && xgaZebra != null ? xgFavorito - xgaZebra : null;
  const cruzamento = cruzarXG(xgFavorito, xgaZebra);

  let favoritoNivel, favoritoMotivo;
  if (diffXG != null && diffXG < 0) {
    favoritoNivel = 'Baixa';
    favoritoMotivo = `conflito direto — diff de xG negativo pro favorito (${diffXG.toFixed(2)})`;
  } else if (pontosFavorito < 5) {
    favoritoNivel = 'Média';
    favoritoMotivo = `pontos abaixo do mínimo (${pontosFavorito}/5), sem conflito direto`;
  } else if (!(diffXG != null && diffXG >= 1.0) || !pctExcelente) {
    favoritoNivel = 'Média';
    favoritoMotivo = 'pontos batem, mas xG ou %\'s não fecham o corte de Alta';
  } else {
    // pontos>=5, diffXG>=1.0, %'s excelentes — só falta o 4º critério (notícia),
    // que exige busca web. Teto local fica em Média com motivo "candidato a Alta".
    favoritoNivel = 'Média';
    favoritoMotivo = 'candidato a 🟢 Alta — pontos, xG e %\'s batem os 3 critérios locais; falta só notícia/H2H (análise completa confirma)';
  }

  // -- GOLS --
  const { cortesBatidos, ...overNums } = calcularOvers(overs, home, away);
  const xgTotal = cg.xgTotal;
  let golsNivel;
  if (cortesBatidos >= 4 && xgTotal != null && xgTotal >= 2.5) golsNivel = 'Alta';
  else if (cortesBatidos <= 1) golsNivel = 'Baixa';
  else golsNivel = 'Média';

  // -- PLACAR/LAY --
  const { unders, alertaZebra } = checarZebraTop5(projecoes);
  const placar = avaliarPlacarLay(home, away, unders);

  return {
    favorito: { nivel: favoritoNivel, motivo: favoritoMotivo, pontos: pontosFavorito, diffXG, pctVitorias, pctDerrotas },
    gols: { nivel: golsNivel, ...overNums, cortesBatidos, xgTotal },
    placar: { nivel: placar.nivel, motivo: placar.motivo, unders: unders.map((u) => u.placar) },
    // true só quando os 3 baldes batem pelo menos Média — critério pra
    // disparar a análise completa (paga) automaticamente
    valeAPena: favoritoNivel !== 'Baixa' && golsNivel !== 'Baixa' && placar.nivel !== 'Baixa',
  };
}

module.exports = { calcularBaldes, bandaEG, cruzarXG, calcularPontos, calcularOvers, checarZebraTop5 };
