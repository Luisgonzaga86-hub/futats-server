// claudeAnalyzer.js
// Chama a API da Anthropic (Claude) com o Guia FUTATS como instrução do sistema,
// os dados do jogo, e a ferramenta de busca na web habilitada.
// Retorna o texto completo da análise, formatado pro Telegram.

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const GUIA = fs.readFileSync(path.join(__dirname, 'guia.md'), 'utf-8');

// Formata o resultado da calculadora.js (cálculo local, grátis) num bloco de
// texto pra colar no prompt — assim o modelo NÃO precisa "pensar" de novo o
// sistema de pontos, xG, overs e zebra (que já são só matemática). Ele só
// confere rapidamente, escreve a prosa, e resolve o que a calculadora não
// consegue sozinha (notícia, H2H, os passos 1-2 do Lay Improvável).
function formatarCalculoLocal(calculo) {
  if (!calculo) return '';
  const f = calculo.favorito;
  const g = calculo.gols;
  const p = calculo.placar;
  return `
⭐ CÁLCULO LOCAL JÁ PRONTO (feito por script, não precisa refazer as contas):
Use estes números diretamente — NÃO gaste tempo recalculando sistema de pontos, xG, overs ou zebra do zero, eles já vieram calculados corretamente. Seu trabalho aqui é: (1) conferir rapidamente se os números fazem sentido com o resto do JSON, (2) buscar notícia/desfalque e H2H via web search (isso SIM precisa de você), (3) escrever a análise completa no formato de sempre, (4) fechar o veredito final dos 3 baldes — o balde de Favorito abaixo está travado em 🟡 Média porque falta o 4º critério (notícia/H2H); se a notícia/H2H não contradisser o favoritismo, SOBE pra 🟢 Alta (os outros 3 critérios já bateram); se contradisser, vira 🔴 Baixa.

- Favorito: ${f.nivel} — pontos=${f.pontos}, diff xG=${f.diffXG != null ? f.diffXG.toFixed(2) : 'n/d'}, %vitórias=${f.pctVitorias.toFixed(1)}%, %derrotas=${f.pctDerrotas.toFixed(1)}% (${f.motivo})
- Gols: ${g.nivel} — Over1.5=${g.over15.toFixed(1)}%, Over2.5=${g.over25.toFixed(1)}%, Over3.5=${g.over35.toFixed(1)}%, OverHT=${g.overHT.toFixed(1)}%, BTTS=${g.btts.toFixed(1)}%, cortes batidos=${g.cortesBatidos}/5, xG total=${g.xgTotal != null ? g.xgTotal.toFixed(2) : 'n/d'}
- Placar/Lay: ${p.nivel} — ${p.motivo}${p.unders.length ? `, unders no Top5: ${p.unders.join(', ')}` : ''}
`;
}

// Poda o JSON antes de mandar pra API — mantém só os últimos 6 jogos anteriores
// de cada lado (a régua só usa "últimos 5" mesmo), cortando tokens de entrada à toa.
function podarJogo(jogoRaw) {
  try {
    const clone = JSON.parse(JSON.stringify(jogoRaw));
    const statsPre = clone.stats_pre;
    if (Array.isArray(statsPre)) {
      for (const bloco of statsPre) {
        const jogoInteiro = bloco?.jogo_inteiro;
        if (jogoInteiro?.home?.previousGames) {
          jogoInteiro.home.previousGames = jogoInteiro.home.previousGames.slice(0, 6);
        }
        if (jogoInteiro?.away?.previousGames) {
          jogoInteiro.away.previousGames = jogoInteiro.away.previousGames.slice(0, 6);
        }
      }
    }
    return clone;
  } catch (err) {
    console.error('[claudeAnalyzer] Falha ao podar JSON, usando original:', err.message);
    return jogoRaw;
  }
}

const SYSTEM_PROMPT = `Você é o motor de análise pré-live do sistema FUTATS. Siga TODAS as regras do guia abaixo à risca, sem exceção. Gere a análise completa do jogo com as MESMAS SEÇÕES usadas no chat original (✅ A Favor, 🟡 Duvidoso/Ressalvas, 🎯 Faixas de gols com cruzamento xG x xGA, 🤝 H2H, 🎯 Top 3 placares, 🎯 Lay Improvável, ⚠️ Onde perdemos, 🦓 Zebra geral, 📰 Notícia, e o bloco final de confiança).

⭐ ECONOMIA DE TOKENS (regra de custo, fixada 07/07, reforçada 04/08): o processo de raciocínio (pontos, xG, checagem de zebra, os 6 passos do Lay Improvável) continua OBRIGATÓRIO internamente — a régua tem que ser seguida à risca. Mas no texto final que você escreve, a seção 🎯 Lay Improvável deve mostrar só a CONCLUSÃO: os placares finais escolhidos + 1 linha curta explicando por que cada um foi descartado/mantido (ex: "0x1 descartado — já ocorreu em 21/05" / "Mantendo: G.Visitante · 3x0"). NÃO narre os 6 passos numerados no texto final. As outras seções (A Favor, Ressalvas, Faixas de gols, H2H, Onde perdemos, Zebra, Notícia) seguem completas como sempre, sem cortar conteúdo — só sejam objetivas, sem redundância ou floreio desnecessário.

⭐ NOVO (04/08): quando a mensagem do usuário incluir um bloco "CÁLCULO LOCAL JÁ PRONTO", os números de pontos/xG/overs/zebra JÁ VIERAM CALCULADOS por script — use-os diretamente, sem gastar tokens de raciocínio refazendo essas contas do zero. Seu trabalho nesse caso é: conferir rapidamente, buscar notícia/H2H (isso continua exigindo web search), escrever a prosa, e fechar o veredito final dos baldes considerando a notícia. Isso é o que mais economiza — não recalcule o que já veio pronto.

⚠️ IMPORTANTE — formato é para o TELEGRAM, não para chat markdown: NÃO use "#", "##", "###", linhas "---", nem tabelas com "|". Escreva em texto corrido, com emojis como marcadores de seção (ex: "✅ A Favor", "🎯 Top 3 placares:"), parágrafos e listas com "-". Qualquer dado tabular (faixas de gols, cortes de overs) deve virar texto corrido ou lista simples.

Escreva em português do Brasil. ⭐ REGRA MÁXIMA: zero frases em inglês no texto final — isso já causou um erro real em produção (uma frase de busca em inglês foi colada sem traduzir). Se qualquer informação vier em inglês de uma busca, traduza e reescreva com suas próprias palavras — nunca deixe frase ou trecho em inglês no texto final, e nunca copie mais de 15 palavras seguidas de uma fonte. Antes de finalizar, revise cada frase e confirme que está 100% em português. O Favorito SEMPRE leva o motivo entre parênteses. Não corte nenhuma seção — o pedido é por uma análise COMPLETA (menos a narração passo-a-passo do Lay), nunca resumida no conteúdo.

${GUIA}`;

async function analisarJogo(jogoRawOriginal, calculoLocal) {
  const jogoRaw = podarJogo(jogoRawOriginal);
  const blocoCalculo = formatarCalculoLocal(calculoLocal);
  const userMessage = `Analise este jogo de futebol seguindo o guia acima.${blocoCalculo}\n\nDados do jogo (JSON):\n\n${JSON.stringify(jogoRaw, null, 2)}`;

  const body = {
    model: 'claude-sonnet-5',
    max_tokens: 16000, // aumentado de novo — 8192 ainda cortava no meio (thinking + buscas consomem bastante)
    // TESTE (20/07): effort medium em vez do padrão (high/implícito) — reduz
    // tokens de thinking (a maior fatia do custo, ~58%). Se a qualidade não
    // ficar boa, é só remover essa linha e redeployar pra voltar ao padrão.
    output_config: { effort: 'medium' },
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        // TTL de 1h em vez do padrão de 5min — como os jogos são analisados
        // um a um ao longo do dia (cada um ~50min antes do próprio kickoff),
        // o cache de 5min quase sempre expirava antes do próximo jogo chegar,
        // fazendo pagar o write premium (25%) toda vez sem nunca colher o
        // desconto do read (90%). Com 1h, jogos com kickoffs próximos no
        // mesmo dia reaproveitam o cache do guia (que é sempre idêntico).
        // Write de 1h custa 2x (vs 1.25x do 5min), mas como o 5min quase
        // nunca sobrevivia mesmo, isso tende a reduzir o custo líquido.
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 2, // no máximo 2 buscas por jogo, conforme combinado
      },
    ],
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Erro na API Claude (${resp.status}): ${errText}`);
  }

  const data = await resp.json();

  // Log de diagnóstico — ajuda a entender por que a resposta veio vazia, se acontecer de novo
  console.log('[claudeAnalyzer] stop_reason:', data.stop_reason);
  console.log('[claudeAnalyzer] tipos de bloco recebidos:', data.content.map((b) => b.type).join(', '));

  // A resposta pode ter vários blocos (texto + buscas resolvidas). Junta só o texto final.
  const textoFinal = data.content
    .filter((bloco) => bloco.type === 'text')
    .map((bloco) => bloco.text)
    .join('\n\n');

  if (!textoFinal || textoFinal.trim().length === 0) {
    throw new Error(
      `A IA não retornou texto final (stop_reason: ${data.stop_reason}). Blocos recebidos: ${data.content.map((b) => b.type).join(', ')}`
    );
  }

  return textoFinal;
}

module.exports = { analisarJogo };
