// index.js
// Servidor principal: sobe a página web onde você vê os jogos do dia e pede
// a análise de qualquer um manualmente. Também liga o agendador automático.

require('dotenv').config();
const express = require('express');
const store = require('./store');
const scheduler = require('./scheduler');
const futatsClient = require('./futatsClient');

const app = express();
const PORT = process.env.PORT || 3000;

// Proteção simples por senha (via ?senha=xxx na URL)
function checarSenha(req, res, next) {
  if (req.query.senha !== process.env.WEB_PASSWORD) {
    return res.status(401).send('Senha incorreta. Acesse com ?senha=SUASENHA na URL.');
  }
  next();
}

// Evita que o texto da análise quebre o HTML da página (escapa < > & etc.)
function escapeHtml(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Página principal: lista os jogos de hoje
app.get('/', checarSenha, (req, res) => {
  const jogos = store.getAllGames().sort((a, b) => a.hora.localeCompare(b.hora));

  const linhas = jogos
    .map((j) => {
      let status;
      if (j.analisado) status = '✅ analisado';
      else if (j.processando) status = '⏳ processando...';
      else status = '⏳ pendente';

      const acao = j.analisado
        ? `<a href="/analise/${j.id}?senha=${req.query.senha}" style="color:#4fd1c5;">Ver análise</a>`
        : `<form method="POST" action="/analisar/${j.id}?senha=${req.query.senha}">
             <button type="submit" ${j.processando ? 'disabled' : ''}>Analisar e mandar pro Telegram</button>
           </form>`;

      return `
        <tr>
          <td>${j.hora}</td>
          <td>${j.pais} — ${j.campeonato}</td>
          <td>${j.mandante} x ${j.visitante}</td>
          <td>${j.odd_casa} / ${j.odd_empate} / ${j.odd_fora}</td>
          <td>${j.selecao_ia || '-'}</td>
          <td>${status}</td>
          <td>${acao}</td>
        </tr>`;
    })
    .join('');

  res.send(`
    <html>
    <head>
      <meta charset="utf-8" />
      <title>FUTATS Pré-Live</title>
      <style>
        body { font-family: sans-serif; background: #111; color: #eee; padding: 20px; }
        table { width: 100%; border-collapse: collapse; }
        td, th { padding: 8px; border-bottom: 1px solid #333; text-align: left; font-size: 14px; }
        button { background: #2b6cb0; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
        button:disabled { background: #444; cursor: not-allowed; }
        a.atualizar { color: #4fd1c5; }
      </style>
    </head>
    <body>
      <h2>⚽ FUTATS — Jogos de hoje</h2>
      <p><a class="atualizar" href="/atualizar?senha=${req.query.senha}">🔄 Puxar jogos novos agora</a></p>
      <table>
        <tr><th>Hora</th><th>Liga</th><th>Jogo</th><th>Odds</th><th>Seleção IA</th><th>Status</th><th></th></tr>
        ${linhas}
      </table>
    </body>
    </html>
  `);
});

// Botão de "puxar jogos novos agora" (pull manual, fora dos 4 horários automáticos)
app.get('/atualizar', checarSenha, async (req, res) => {
  await futatsClient.buscarJogosDoDia();
  res.redirect(`/?senha=${req.query.senha}`);
});

// Mostra o texto completo de uma análise já feita
app.get('/analise/:id', checarSenha, (req, res) => {
  const jogo = store.getGame(req.params.id);
  if (!jogo) return res.status(404).send('Jogo não encontrado.');
  if (!jogo.analise) return res.status(404).send('Esse jogo ainda não tem análise salva.');

  res.send(`
    <html>
    <head>
      <meta charset="utf-8" />
      <title>${escapeHtml(jogo.mandante)} x ${escapeHtml(jogo.visitante)}</title>
      <style>
        body { font-family: sans-serif; background: #111; color: #eee; padding: 20px; max-width: 700px; margin: 0 auto; }
        pre { white-space: pre-wrap; word-wrap: break-word; font-family: sans-serif; font-size: 15px; line-height: 1.5; }
        a { color: #4fd1c5; }
      </style>
    </head>
    <body>
      <p><a href="/?senha=${req.query.senha}">← Voltar pra lista</a></p>
      <h3>${escapeHtml(jogo.mandante)} x ${escapeHtml(jogo.visitante)}</h3>
      <p style="color:#888;">Analisado em: ${jogo.analisado_em || '-'}</p>
      <pre>${escapeHtml(jogo.analise)}</pre>
    </body>
    </html>
  `);
});

// Dispara a análise de um jogo específico (manual) e manda pro Telegram
app.post('/analisar/:id', checarSenha, async (req, res) => {
  const jogo = store.getGame(req.params.id);
  if (!jogo) return res.status(404).send('Jogo não encontrado.');
  if (jogo.analisado) return res.redirect(`/?senha=${req.query.senha}`);

  // dispara em segundo plano (não trava a página esperando a análise terminar)
  scheduler.processarAnaliseDoJogo(jogo, 'manual via web').catch(console.error);

  res.send(`
    <html><body style="font-family:sans-serif;background:#111;color:#eee;padding:20px;">
      <p>✅ Análise de <b>${jogo.mandante} x ${jogo.visitante}</b> disparada!</p>
      <p>Vai chegar no Telegram em alguns minutos.</p>
      <a href="/?senha=${req.query.senha}" style="color:#4fd1c5;">Voltar</a>
    </body></html>
  `);
});

app.listen(PORT, () => {
  console.log(`[server] Rodando na porta ${PORT}`);
  scheduler.iniciar();
});
