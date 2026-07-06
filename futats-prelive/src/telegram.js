// telegram.js
// Manda a mensagem completa pro Telegram. Se passar do limite de caracteres
// do Telegram (4096), quebra em mais de uma mensagem automaticamente.

const fetch = require('node-fetch');

const LIMITE_TELEGRAM = 4000; // um pouco abaixo do limite real (4096) por segurança

function quebrarMensagem(texto) {
  if (texto.length <= LIMITE_TELEGRAM) return [texto];

  const partes = [];
  let restante = texto;
  while (restante.length > 0) {
    if (restante.length <= LIMITE_TELEGRAM) {
      partes.push(restante);
      break;
    }
    // tenta quebrar num parágrafo (linha em branco) próximo do limite, pra não cortar no meio de uma frase
    let corte = restante.lastIndexOf('\n\n', LIMITE_TELEGRAM);
    if (corte === -1) corte = LIMITE_TELEGRAM;
    partes.push(restante.slice(0, corte));
    restante = restante.slice(corte).trim();
  }
  return partes;
}

async function enviarMensagem(texto, destino) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId =
    destino === 'canal' ? process.env.TELEGRAM_CHAT_ID_CANAL : process.env.TELEGRAM_CHAT_ID_PESSOAL;

  const partes = quebrarMensagem(texto);

  for (const parte of partes) {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: parte,
        parse_mode: 'Markdown',
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[telegram] erro ao enviar:', errText);
    }

    // pequena pausa entre partes pra manter a ordem certinha no Telegram
    await new Promise((r) => setTimeout(r, 500));
  }
}

module.exports = { enviarMensagem };
