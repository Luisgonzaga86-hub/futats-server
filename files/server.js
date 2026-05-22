const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');

const app  = express();
app.use(cors());
app.use(express.json());

// ── CONFIG ────────────────────────────────────────────────
const API_KEY    = process.env.API_FOOTBALL_KEY || '3b12a6e36710448864d5c63322ec29a4';
const TG_TOKEN   = process.env.TG_TOKEN         || '8826929533:AAH5CdY8yBf9p-2CM-JDYLz_ppu7bkxN5wQ';
const TG_CHAT_ID = process.env.TG_CHAT_ID       || '7324646421';
const PORT       = process.env.PORT             || 3000;

// ── ESTADO ────────────────────────────────────────────────
let pendentes   = [];   // jogos monitorados
let notificados = {};   // controle de alertas já enviados

// ── ESTRATÉGIAS ───────────────────────────────────────────
const STRAT_NAMES = {
  lay_azul:'Lay Azul', lay_xg:'Lay xG',
  over05:'Over 0.5', over15:'Over 1.5', over15l:'O1.5 LIMITE',
  am:'AM', am_xg:'AM xG',
  under35:'Under 3.5', lay_zebra:'Lay ao CS',
  xgp_casa:'XG Casa', xgp_visit:'XG Visitante', xgp_lay:'XG Lay',
  xgp_ambas:'XG Ambas', xgp_u35:'XG U3.5',
  xgp_o15:'XG O1.5', xgp_o25:'XG O2.5', xgp_o35:'XG O3.5', xgp_05ht:'XG 0.5HT'
};

const EMOJIS = {
  lay_azul:'🔵', lay_xg:'🟣', over05:'🟢', over15:'🟠', over15l:'🟠',
  am:'🔴', am_xg:'🟤', under35:'🟡', lay_zebra:'⚪',
  xgp_casa:'🟣', xgp_visit:'🟣', xgp_lay:'🟣', xgp_ambas:'🟣',
  xgp_u35:'🟣', xgp_o15:'🟣', xgp_o25:'🟣', xgp_o35:'🟣', xgp_05ht:'🟣'
};

// ── API FOOTBALL ──────────────────────────────────────────
async function apiFetch(endpoint) {
  const r = await fetch(`https://v3.football.api-sports.io/${endpoint}`, {
    headers: { 'x-apisports-key': API_KEY }
  });
  return r.json();
}

// ── TELEGRAM ──────────────────────────────────────────────
async function sendTelegram(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: 'HTML' })
    });
    console.log('Telegram sent:', msg.slice(0, 60));
  } catch(e) {
    console.error('Telegram error:', e.message);
  }
}

// ── MONITOR ───────────────────────────────────────────────
async function monitorar() {
  const agora = new Date();
  const pendAtivos = pendentes.filter(p => p.result === 'pendente');
  if (!pendAtivos.length) return;

  // Jogos únicos
  const ids = [...new Set(pendAtivos.map(p => p.fixture_id).filter(Boolean))];

  for (const fid of ids) {
    try {
      const pendFid = pendAtivos.filter(p => p.fixture_id === fid);
      const p0 = pendFid[0];

      // Verificar se já deve ter começado
      const [hh, mm] = (p0.hora || '00:00').split(':').map(Number);
      const inicio = new Date(agora);
      inicio.setHours(hh, mm, 0, 0);
      const minDesdeInicio = (agora - inicio) / 60000;
      if (minDesdeInicio < -2) continue; // ainda não começou

      const r = await apiFetch(`fixtures?id=${fid}`);
      const f = r?.response?.[0];
      if (!f) continue;

      const status  = f.fixture.status.short;
      const elapsed = f.fixture.status.elapsed || 0;
      const htH     = f.score.halftime.home ?? 0;
      const htA     = f.score.halftime.away ?? 0;
      const ftH     = f.goals.home ?? 0;
      const ftA     = f.goals.away ?? 0;
      const totHT   = htH + htA;
      const htStr   = `${htH}x${htA}`;
      const hora    = agora.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });

      // Jogos encerrados — calcular resultado e remover
      if (['FT','AET','PEN'].includes(status)) {
        for (const p of pendFid) {
          if (p.result !== 'pendente') continue;
          p.result = 'resolvido';
          p.final  = `${ftH}x${ftA}`;
          p.ht     = htStr;
        }
        continue;
      }

      // ── ALERTAS NO HT ──────────────────────────────────
      if (status === 'HT') {
        const alertasJogo = [];

        for (const p of pendFid) {
          const nKey = `${fid}_${p.strat}_ht`;
          if (notificados[nKey]) continue;

          let deveNotificar = false;

          if (p.strat === 'over05' && totHT === 0) deveNotificar = true;
          else if (p.strat === 'over15' && totHT === 0) deveNotificar = true;
          else if (p.strat === 'over15l' && totHT <= 1) deveNotificar = true;
          else if (p.strat === 'am' && totHT <= 1) deveNotificar = true;
          else if (p.strat === 'am_xg' && totHT <= 1) deveNotificar = true;
          else if (['xgp_ambas','xgp_o15','xgp_o25'].includes(p.strat) && totHT <= 1) deveNotificar = true;
          else if (p.strat === 'xgp_u35') deveNotificar = true;

          if (!deveNotificar) continue;
          notificados[nKey] = true;

          const emoji  = EMOJIS[p.strat] || '⚪';
          const nome   = STRAT_NAMES[p.strat] || p.strat;
          const isU35  = p.strat === 'xgp_u35';
          const acao   = isU35 ? 'SAIR SE LUCRO' : 'ENTRAR';
          const oddStr = p.odd ? ` · Odd: ${parseFloat(p.odd).toFixed(2)}` : '';
          alertasJogo.push(`${emoji} <b>${acao} — ${nome}</b>${oddStr}`);
        }

        if (alertasJogo.length > 0) {
          const jogo = pendFid[0].jogo;
          const msg  = `${alertasJogo.join('\n')}\n⚽ ${jogo}\n📊 HT: ${htStr}\n⏰ ${hora}`;
          await sendTelegram(msg);
        }
      }

      // ── ALERTAS AO VIVO ─────────────────────────────────

      // 🔵 Lay Azul — visitante marca no 1T
      for (const p of pendFid.filter(p => p.strat === 'lay_azul' && ['1H','HT'].includes(status))) {
        const goalsAway = f.score?.halftime?.away ?? ftA;
        const nKey = `${fid}_lay_azul_gols_${goalsAway}`;
        if (goalsAway > 0 && !notificados[nKey]) {
          notificados[nKey] = true;
          const minStr = status === 'HT' ? 'HT' : `${elapsed}'`;
          const msg = `🔵 <b>OPORTUNIDADE — Lay Azul</b>\n⚽ ${p.jogo}\n📊 Visitante marcou! ${ftH}×${ftA} · ${minStr}\n⏰ ${hora}`;
          await sendTelegram(msg);
        }
      }

      // 🟣 Lay xG — time de menor xG na frente até 70min
      for (const p of pendFid.filter(p => p.strat === 'lay_xg' && elapsed <= 70 && ['1H','2H'].includes(status))) {
        const layHome  = p.lay_team === 'home';
        const layAway  = p.lay_team === 'away' || (!p.lay_team);
        const naFrente = (layHome && ftH > ftA) || (layAway && ftA > ftH);
        const placar   = `${ftH}x${ftA}`;
        const nKey     = `${fid}_lay_xg_${placar}`;
        if (naFrente && !notificados[nKey]) {
          notificados[nKey] = true;
          const timeNome = layHome ? f.teams.home.name : f.teams.away.name;
          const msg = `🟣 <b>OPORTUNIDADE — Lay xG</b>\n⚽ ${p.jogo}\n📊 ${timeNome} (menor xG) na frente! ${ftH}×${ftA} · ${elapsed}'\n⏰ ${hora}`;
          await sendTelegram(msg);
        }
      }

    } catch(e) {
      console.error(`Erro fixture ${fid}:`, e.message);
    }
  }
}

// ── ROTAS API ─────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    pendentes: pendentes.filter(p=>p.result==='pendente').length,
    uptime: Math.floor(process.uptime()) + 's'
  });
});

// Salvar pendentes do site
app.post('/pendentes', (req, res) => {
  const novos = req.body;
  if (!Array.isArray(novos)) return res.status(400).json({error:'Array esperado'});

  // Merge — atualiza existentes, adiciona novos
  const ids = new Set(pendentes.map(p=>p.id));
  novos.forEach(p => {
    if (ids.has(p.id)) {
      const idx = pendentes.findIndex(x=>x.id===p.id);
      pendentes[idx] = {...pendentes[idx], ...p};
    } else {
      pendentes.push(p);
    }
  });

  console.log(`Pendentes atualizados: ${pendentes.filter(p=>p.result==='pendente').length} ativos`);
  res.json({ ok: true, total: pendentes.length });
});

// Buscar pendentes (para sincronizar devices)
app.get('/pendentes', (req, res) => {
  res.json(pendentes);
});

// Limpar pendentes antigos
app.delete('/pendentes/:id', (req, res) => {
  pendentes = pendentes.filter(p => p.id !== parseInt(req.params.id));
  res.json({ ok: true });
});

// Testar Telegram
app.post('/testar-telegram', async (req, res) => {
  await sendTelegram('✅ FUTATS Server funcionando! Alertas 24h ativos. 🎯');
  res.json({ ok: true });
});

// ── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`FUTATS Server rodando na porta ${PORT}`);
  console.log('Iniciando monitoramento a cada 2 minutos...');

  // Monitorar a cada 2 minutos
  setInterval(monitorar, 2 * 60 * 1000);

  // Enviar mensagem de início
  sendTelegram('🚀 FUTATS Server iniciado! Monitorando jogos 24h.');
});
