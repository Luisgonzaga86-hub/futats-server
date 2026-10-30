// calculadora.js
// Motor de cálculo LOCAL do Manual V7 — roda 100% em JavaScript, sem chamar
// a API da Anthropic. Reproduz as partes determinísticas do manual (sistema
// de pontos, cruzamento de xG, cortes de overs, checagem de zebra) pra gerar
// os 3 baldes de confiança (Favorito/Gols/Placar) de graça, pra todo jogo.
//
// 29/10 — H2H agora vem pronto na API (confronto_direto.previousGames) e entra
// nos 3 baldes: Favorito pode fechar 🟢 Alta localmente (4º critério = H2H não
// contradiz), Gols cai pra Baixa se o H2H mostra padrão de under, Placar vira
// Baixa se o H2H teve placar baixo. Notícia/desfalque continua fora (só aviso).
//
// O que NÃO dá pra fazer aqui (fica pra análise completa via API):
// - Notícia/desfalque (exige busca web)
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


// ── 0. H2H (29/10) ────────────────────────────────────────────────
// confronto_direto.previousGames[]: data dd/mm/yyyy, mandante/visitante do jogo
// passado, golsMandante/golsVisitante (+HT), mandante_em_casa = se o mandante
// de HOJE era o mandante naquele jogo. Tudo é lido pela ótica do mandante atual.
const VERSAO_CALCULO = 2;
const H2H_MAX = 5;           // últimos confrontos considerados
const H2H_MIN = 3;           // abaixo disso o H2H não conta nem a favor nem contra
const H2H_UNDER_MEDIA = 2.0; // média de gols <= isso = padrão de under

function parseDataBR(s) {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || '');
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : 0;
}

function pegarConfrontoDireto(sp, jogoRaw) {
  const cd = (sp && sp.confronto_direto) || (jogoRaw && jogoRaw.confronto_direto);
  return cd && Array.isArray(cd.previousGames) ? cd : null;
}

function resumirH2H(sp, jogoRaw, favorito) {
  const cd = pegarConfrontoDireto(sp, jogoRaw);
  if (!cd) return { disponivel: false, n: 0 };

  const jogos = cd.previousGames
    .filter((g) => g && g.golsMandante != null && g.golsVisitante != null)
    .sort((a, b) => parseDataBR(b.data) - parseDataBR(a.data))
    .slice(0, H2H_MAX);

  let v = 0, e = 0, d = 0, soma = 0, orientados = 0, placarBaixo = false;
  const lista = [];
  for (const g of jogos) {
    const total = g.golsMandante + g.golsVisitante;
    soma += total;
    if (total <= 1) placarBaixo = true;
    // gols do mandante ATUAL naquele jogo (null se o campo não vier)
    let pro = null, contra = null;
    if (g.mandante_em_casa === true) { pro = g.golsMandante; contra = g.golsVisitante; }
    else if (g.mandante_em_casa === false) { pro = g.golsVisitante; contra = g.golsMandante; }
    if (pro != null) {
      orientados++;
      if (pro > contra) v++; else if (pro < contra) d++; else e++;
    }
    lista.push({ data: g.data, placar: pro != null ? `${pro}-${contra}` : `${g.golsMandante}-${g.golsVisitante}`, total });
  }
  const n = jogos.length;
  const favV = favorito === 'casa' ? v : d;
  const favD = favorito === 'casa' ? d : v;
  const mediaGols = n ? soma / n : null;
  return {
    disponivel: true, n, mandanteV: v, empates: e, mandanteD: d, favV, favD, mediaGols, placarBaixo,
    contradizFavorito: n >= H2H_MIN && orientados >= H2H_MIN && favD > favV,
    padraoUnder: n >= H2H_MIN && mediaGols != null && mediaGols <= H2H_UNDER_MEDIA,
    jogos: lista,
  };
}

// Jogo já calculado na versão antiga que agora tem H2H disponível e ainda não
// foi disputado — recalcula uma vez. Jogos antigos/encerrados ficam como estão
// (não reescreve o histórico de confiabilidade).
function precisaRecalcular(g) {
  if (!g || !g.calculado || g.resultado_final) return false;
  if (((g.calculo && g.calculo.versao) || 1) >= VERSAO_CALCULO) return false;
  const raw = g.stats_pre_raw || {};
  const sp = (raw.stats_pre || [])[0];
  if (!pegarConfrontoDireto(sp, raw)) return false;
  const ontem = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  return !!g.data && g.data.slice(0, 10) >= ontem;
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
function avaliarPlacarLay(home, away, unders, h2h) {
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
  if (h2h && h2h.disponivel && h2h.placarBaixo) {
    return { nivel: 'Baixa', motivo: 'H2H teve placar baixo (1 gol ou menos no total)' };
  }
  return {
    nivel: 'Média',
    motivo: h2h && h2h.n >= H2H_MIN
      ? 'nunca ocorreu na amostra recente e o H2H não invalida (teto local = Média)'
      : 'nunca ocorreu na amostra recente — H2H insuficiente pra confirmar',
  };
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

  // -- H2H (visto pela ótica do favorito) --
  const h2h = resumirH2H(sp, jogoRaw, favorito);

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
    // pontos>=5, diffXG>=1.0, %'s excelentes — 4º critério agora é o H2H
    // (notícia/desfalque fica como aviso manual, não muda o nível).
    if (!h2h.disponivel) {
      favoritoNivel = 'Média';
      favoritoMotivo = 'candidato a 🟢 Alta — critérios locais batem, mas sem H2H nos dados';
    } else if (h2h.contradizFavorito) {
      favoritoNivel = 'Média';
      favoritoMotivo = `candidato a 🟢 Alta, mas H2H contradiz (favorito ${h2h.favV}V-${h2h.n - h2h.favV - h2h.favD}E-${h2h.favD}D nos últimos ${h2h.n})`;
    } else {
      favoritoNivel = 'Alta';
      favoritoMotivo = `4 critérios batem (pontos, xG, %'s, H2H não contradiz${h2h.n >= H2H_MIN ? `: ${h2h.favV}V-${h2h.n - h2h.favV - h2h.favD}E-${h2h.favD}D` : `: só ${h2h.n} confronto(s)`}) — conferir notícia/desfalque`;
    }
  }

  // -- GOLS --
  const { cortesBatidos, ...overNums } = calcularOvers(overs, home, away);
  const xgTotal = cg.xgTotal;
  let golsNivel;
  if (cortesBatidos >= 4 && xgTotal != null && xgTotal >= 2.5) golsNivel = 'Alta';
  else if (cortesBatidos <= 1) golsNivel = 'Baixa';
  else golsNivel = 'Média';
  let golsMotivo = null;
  if (golsNivel !== 'Baixa' && h2h.padraoUnder) {
    golsNivel = 'Baixa';
    golsMotivo = `H2H com padrão de under (média ${h2h.mediaGols.toFixed(1)} gols nos últimos ${h2h.n})`;
  }

  // -- PLACAR/LAY --
  const { unders, alertaZebra } = checarZebraTop5(projecoes);
  const placar = avaliarPlacarLay(home, away, unders, h2h);

  return {
    favorito: { nivel: favoritoNivel, motivo: favoritoMotivo, pontos: pontosFavorito, diffXG, pctVitorias, pctDerrotas },
    gols: { nivel: golsNivel, ...overNums, cortesBatidos, xgTotal, motivo: golsMotivo },
    placar: { nivel: placar.nivel, motivo: placar.motivo, unders: unders.map((u) => u.placar) },
    // true só quando os 3 baldes batem pelo menos Média — critério pra
    // disparar a análise completa (paga) automaticamente
    versao: VERSAO_CALCULO,
    h2h: { disponivel: h2h.disponivel, n: h2h.n, mandanteV: h2h.mandanteV, empates: h2h.empates, mandanteD: h2h.mandanteD, favV: h2h.favV, favD: h2h.favD, mediaGols: h2h.mediaGols, jogos: h2h.jogos },
    valeAPena: favoritoNivel !== 'Baixa' && golsNivel !== 'Baixa' && placar.nivel !== 'Baixa',
  };
}

module.exports = { calcularBaldes, precisaRecalcular, resumirH2H, VERSAO_CALCULO, bandaEG, cruzarXG, calcularPontos, calcularOvers, checarZebraTop5 };
