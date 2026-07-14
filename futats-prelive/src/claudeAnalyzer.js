// claudeAnalyzer.js
// Chama a API da Anthropic (Claude) com o Guia FUTATS como instrução do sistema,
// os dados do jogo, e a ferramenta de busca na web habilitada.
// Retorna o texto completo da análise, formatado pro Telegram.

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const GUIA = fs.readFileSync(path.join(__dirname, 'guia.md'), 'utf-8');

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

⭐ ECONOMIA DE TOKENS (regra de custo, fixada 07/07): o processo de raciocínio (pontos, xG, checagem de zebra, os 6 passos do Lay Improvável) continua OBRIGATÓRIO internamente — a régua tem que ser seguida à risca. Mas no texto final que você escreve, a seção 🎯 Lay Improvável deve mostrar só a CONCLUSÃO: os placares finais escolhidos + 1 linha curta explicando por que cada um foi descartado/mantido (ex: "0x1 descartado — já ocorreu em 21/05" / "Mantendo: G.Visitante · 3x0"). NÃO narre os 6 passos numerados no texto final. As outras seções (A Favor, Ressalvas, Faixas de gols, H2H, Onde perdemos, Zebra, Notícia) seguem completas como sempre, sem cortar conteúdo — só sejam objetivas, sem redundância ou floreio desnecessário.

⚠️ IMPORTANTE — formato é para o TELEGRAM, não para chat markdown: NÃO use "#", "##", "###", linhas "---", nem tabelas com "|". Escreva em texto corrido, com emojis como marcadores de seção (ex: "✅ A Favor", "🎯 Top 3 placares:"), parágrafos e listas com "-". Qualquer dado tabular (faixas de gols, cortes de overs) deve virar texto corrido ou lista simples.

Escreva em português do Brasil. ⭐ REGRA MÁXIMA: zero frases em inglês no texto final — isso já causou um erro real em produção (uma frase de busca em inglês foi colada sem traduzir). Se qualquer informação vier em inglês de uma busca, traduza e reescreva com suas próprias palavras — nunca deixe frase ou trecho em inglês no texto final, e nunca copie mais de 15 palavras seguidas de uma fonte. Antes de finalizar, revise cada frase e confirme que está 100% em português. O Favorito SEMPRE leva o motivo entre parênteses. Não corte nenhuma seção — o pedido é por uma análise COMPLETA (menos a narração passo-a-passo do Lay), nunca resumida no conteúdo.

${GUIA}`;

async function analisarJogo(jogoRawOriginal) {
  const jogoRaw = podarJogo(jogoRawOriginal);
  const userMessage = `Analise este jogo de futebol seguindo o guia acima. Dados do jogo (JSON):\n\n${JSON.stringify(jogoRaw, null, 2)}`;

  const body = {
    model: 'claude-sonnet-5',
    max_tokens: 16000, // aumentado de novo — 8192 ainda cortava no meio (thinking + buscas consomem bastante)
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
