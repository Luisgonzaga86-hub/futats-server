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

// Data de hoje em horário de Brasília (UTC-3), no formato YYYY-MM-DD
function hojeBrasilia() {
  const agora = new Date();
  const brasilia = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  return brasilia.toISOString().slice(0, 10);
}

// Mapeia o nível calculado (Alta/Média/Baixa) pro emoji correspondente
function emojiNivel(nivel) {
  if (nivel === 'Alta') return '🟢';
  if (nivel === 'Baixa') return '🔴';
  return '🟡';
}

// Página principal: lista só os jogos de HOJE
app.get('/', checarSenha, (req, res) => {
  const hoje = hojeBrasilia();
  const jogos = store
    .getAllGames()
    .filter((j) => j.data && j.data.slice(0, 10) === hoje)
    .sort((a, b) => a.hora.localeCompare(b.hora));

  const linhas = jogos
    .map((j) => {
      let status;
      if (j.analisado) status = '✅ analisado';
      else if (j.processando) status = '⏳ processando...';
      else if (j.calculado) status = '🧮 calculado';
      else status = '⏳ pendente';

      const conf = j.analise_estruturada;
      const confianca = j.analisado && conf
        ? `<br><small>🎯 ${conf.favorito} · ⚽ ${conf.gols} · 🔒 ${conf.lay}</small>`
        : (j.calculado && j.calculo
            ? `<br><small style="color:#999;">🎯 ${emojiNivel(j.calculo.favorito.nivel)} ${j.calculo.favorito.nivel} · ⚽ ${emojiNivel(j.calculo.gols.nivel)} ${j.calculo.gols.nivel} · 🔒 ${emojiNivel(j.calculo.placar.nivel)} ${j.calculo.placar.nivel} (cálculo local)</small>`
            : '');

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
          <td>${status}${confianca}</td>
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
      <p><a class="atualizar" href="/historico?senha=${req.query.senha}">📜 Ver histórico de análises</a></p>
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

// ── ROTA INTERNA — consumida pelo server live (server_45.js) via rede
// privada do Railway, pra anexar a confiabilidade pré-live nos alertas.
// Protegida por INTERNAL_TOKEN (variável de ambiente, igual nos dois
// serviços) em vez de senha de usuário — não é pra ser acessada de fora.
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;

function checarTokenInterno(req, res, next) {
  if (!INTERNAL_TOKEN || req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
    return res.status(401).json({ error: 'Token interno inválido ou ausente' });
  }
  next();
}

// Extrai o texto de uma seção da análise (entre um título e o próximo título
// que aparecer primeiro dentre os informados). Texto vem sem formatação
// especial, então isso é uma busca simples por substring.
function extrairSecao(texto, tituloInicio, titulosFim) {
  const idxInicio = texto.indexOf(tituloInicio);
  if (idxInicio === -1) return '';
  let idxFim = texto.length;
  for (const t of titulosFim) {
    const i = texto.indexOf(t, idxInicio + tituloInicio.length);
    if (i !== -1 && i < idxFim) idxFim = i;
  }
  return texto.slice(idxInicio + tituloInicio.length, idxFim).trim();
}

// Pega só as linhas de bullet ("- ...") de uma seção
function extrairBullets(secaoTexto) {
  return secaoTexto
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'))
    .map((l) => l.replace(/^-\s*/, ''));
}

// Corta uma linha de bullet no primeiro travessão/hífen ou parêntese,
// pra pegar só o "rótulo" (ex: "G.Mandante", "1x0") sem a explicação depois
function primeiraParte(linha) {
  const match = linha.match(/^(.*?)(\s*:\s*|\s+[—–-]\s+|\s*\()/);
  return (match ? match[1] : linha).trim();
}

function extrairLayImprovavelMantidos(analiseTexto) {
  const secao = extrairSecao(analiseTexto, '🎯 Lay Improvável', [
    '⚠️ Onde perdemos', '🦓 Zebra geral', '📰 Notícia', 'Bloco final',
  ]);
  return extrairBullets(secao)
    .filter((l) => /mantid/i.test(l))
    .map(primeiraParte);
}

function extrairTop3Placares(analiseTexto) {
  const secao = extrairSecao(analiseTexto, '🎯 Top 3 placares', [
    '🤝 H2H', '🎯 Lay Improvável', '⚠️ Onde perdemos',
  ]);
  return extrairBullets(secao).slice(0, 3).map(primeiraParte);
}

// GET /interno/confiabilidade?mandante=X&visitante=Y
// Normaliza nome de time antes de comparar — evita falso negativo quando um
// endpoint da Futats usa apóstrofo reto (') e outro usa tipográfico (' ou ‘),
// ou quando sobra espaço duplo/nas pontas. Achado em 24/07 (St. Patrick's Ath
// batendo visualmente igual mas não casando na comparação exata).
function normalizarNomeTime(nome) {
  return (nome || '')
    .replace(/[\u2018\u2019\u02BC`]/g, "'") // aspas tipográficas → apóstrofo reto
    .replace(/\s+/g, ' ')
    .trim();
}

// 25/08 — endpoint atualizado:
// 1) Agora aceita jogos que só têm o cálculo LOCAL (j.calculado), não só
//    os que já passaram pela análise paga (j.analisado). Antes, um jogo
//    sem análise completa nunca aparecia aqui, mesmo tendo os números
//    locais prontos — isso deixava de fora a maioria dos jogos do dia,
//    já que a análise paga só roda pros jogos com estratégia batida.
// 2) Devolve também os percentuais de Over (over05/15/25/35/overHT/
//    over15HT), vindos de j.calculo.gols (calculadora.js) — usado pelo
//    server_45.js pra montar a "odd justa do jogo" nos alertas, inclusive
//    nos jogos que não têm nenhuma das nossas estratégias batendo.
app.get('/interno/confiabilidade', checarTokenInterno, (req, res) => {
  const mandante = normalizarNomeTime(req.query.mandante);
  const visitante = normalizarNomeTime(req.query.visitante);
  if (!mandante || !visitante) {
    return res.status(400).json({ error: 'mandante e visitante são obrigatórios' });
  }

  const jogo = store
    .getAllGames()
    .find((j) =>
      normalizarNomeTime(j.mandante) === mandante &&
      normalizarNomeTime(j.visitante) === visitante &&
      (j.analisado || j.calculado)
    );

  if (!jogo) {
    return res.json({ encontrado: false });
  }

  // Fonte dos 3 baldes: prioriza a análise paga (mais completa); cai pro
  // cálculo local se a paga ainda não rodou nesse jogo.
  const confPaga = jogo.analisado ? jogo.analise_estruturada || {} : null;
  const confLocal = jogo.calculado ? jogo.calculo || {} : null;

  const favorito = confPaga?.favorito || confLocal?.favorito?.nivel || '-';
  const gols     = confPaga?.gols     || confLocal?.gols?.nivel     || '-';
  const lay      = confPaga?.lay      || confLocal?.placar?.nivel  || '-';

  // Os percentuais de Over só existem no cálculo local (calculadora.js) —
  // a análise paga não devolve esses números brutos, só o balde final.
  // Por isso sempre pega do confLocal quando existir, independente de
  // qual fonte decidiu o nível Alta/Média/Baixa acima.
  const overs = confLocal?.gols
    ? {
        over05: confLocal.gols.over05,
        over15: confLocal.gols.over15,
        over25: confLocal.gols.over25,
        over35: confLocal.gols.over35,
        overHT: confLocal.gols.overHT,     // = Over 0,5 HT combinado
        over15HT: confLocal.gols.over15HT, // = Over 1,5 HT combinado
      }
    : null;

  res.json({
    encontrado: true,
    favorito,
    gols,
    lay,
    overs, // { over05, over15, over25, over35, overHT, over15HT } em % (0-100), ou null
    layImprovavelMantidos: jogo.analisado ? extrairLayImprovavelMantidos(jogo.analise || '') : [],
    top3Placares: jogo.analisado ? extrairTop3Placares(jogo.analise || '') : [],
  });
});

// Histórico de análises — todos os jogos já analisados (qualquer data), com
// filtro opcional por data (?data=YYYY-MM-DD) e/ou nome de time (?time=nome).
// Sem filtro nenhum, mostra tudo que já foi analisado, mais recente primeiro.
app.get('/historico', checarSenha, (req, res) => {
  const filtroData = (req.query.data || '').trim();
  const filtroTime = (req.query.time || '').trim().toLowerCase();

  let jogos = store.getAllGames().filter((j) => j.analisado);

  if (filtroData) {
    jogos = jogos.filter((j) => j.data && j.data.slice(0, 10) === filtroData);
  }
  if (filtroTime) {
    jogos = jogos.filter(
      (j) =>
        (j.mandante || '').toLowerCase().includes(filtroTime) ||
        (j.visitante || '').toLowerCase().includes(filtroTime)
    );
  }

  // Mais recente primeiro
  jogos.sort((a, b) => (b.analisado_em || '').localeCompare(a.analisado_em || ''));

  const linhas = jogos
    .map((j) => {
      const conf = j.analise_estruturada;
      const confianca = conf
        ? `<br><small>🎯 ${conf.favorito} · ⚽ ${conf.gols} · 🔒 ${conf.lay}</small>`
        : '';
      const dataJogo = j.data ? j.data.slice(0, 10) : '-';

      return `
        <tr>
          <td>${dataJogo} ${j.hora || ''}</td>
          <td>${j.pais || ''} — ${j.campeonato || ''}</td>
          <td>${j.mandante} x ${j.visitante}</td>
          <td>${j.selecao_ia || '-'}${confianca}</td>
          <td><a href="/analise/${j.id}?senha=${req.query.senha}" style="color:#4fd1c5;">Ver análise</a></td>
        </tr>`;
    })
    .join('');

  res.send(`
    <html>
    <head>
      <meta charset="utf-8" />
      <title>FUTATS — Histórico</title>
      <style>
        body { font-family: sans-serif; background: #111; color: #eee; padding: 20px; }
        table { width: 100%; border-collapse: collapse; }
        td, th { padding: 8px; border-bottom: 1px solid #333; text-align: left; font-size: 14px; }
        a { color: #4fd1c5; }
        form.filtros { margin-bottom: 16px; }
        input { background: #222; border: 1px solid #444; color: #eee; padding: 6px 8px; border-radius: 4px; margin-right: 8px; }
        button { background: #2b6cb0; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
      </style>
    </head>
    <body>
      <p><a href="/?senha=${req.query.senha}">← Voltar pra hoje</a></p>
      <h2>📜 FUTATS — Histórico de análises (${jogos.length})</h2>
      <form class="filtros" method="GET" action="/historico">
        <input type="hidden" name="senha" value="${req.query.senha}" />
        <input type="date" name="data" value="${escapeHtml(filtroData)}" />
        <input type="text" name="time" placeholder="nome do time" value="${escapeHtml(req.query.time || '')}" />
        <button type="submit">Filtrar</button>
        ${filtroData || filtroTime ? `<a href="/historico?senha=${req.query.senha}" style="margin-left:8px;">Limpar filtro</a>` : ''}
      </form>
      <table>
        <tr><th>Data / Hora</th><th>Liga</th><th>Jogo</th><th>Seleção IA</th><th></th></tr>
        ${linhas}
      </table>
    </body>
    </html>
  `);
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
