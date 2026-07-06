// claudeAnalyzer.js
// Chama a API da Anthropic (Claude) com o Guia FUTATS como instrução do sistema,
// os dados do jogo, e a ferramenta de busca na web habilitada.
// Retorna o texto completo da análise, formatado pro Telegram.

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const GUIA = fs.readFileSync(path.join(__dirname, 'guia.md'), 'utf-8');

const SYSTEM_PROMPT = `Você é o motor de análise pré-live do sistema FUTATS. Siga TODAS as regras do guia abaixo à risca, sem exceção. Gere a análise completa do jogo no MESMO formato detalhado usado no chat original (com ✅ A Favor, 🟡 Duvidoso/Ressalvas, 🎯 Faixas de gols com cruzamento xG x xGA, 🤝 H2H, 🎯 Top 3 placares, 🎯 Lay Improvável com o processo de 6 passos explicado, ⚠️ Onde perdemos, 🦓 Zebra geral, 📰 Notícia, e o bloco final de confiança). Escreva em português do Brasil. Use emojis exatamente como no guia. O Favorito SEMPRE leva o motivo entre parênteses. Não corte nenhuma seção — o pedido é por uma análise COMPLETA, nunca resumida.

${GUIA}`;

async function analisarJogo(jogoRaw) {
  const userMessage = `Analise este jogo de futebol seguindo o guia acima. Dados do jogo (JSON):\n\n${JSON.stringify(jogoRaw, null, 2)}`;

  const body = {
    model: 'claude-sonnet-5',
    max_tokens: 16000, // aumentado — 8192 ainda cortava no meio (thinking + buscas consomem bastante)
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }, // cache do prompt do sistema, reduz custo em chamadas repetidas
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
