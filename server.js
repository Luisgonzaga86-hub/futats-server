const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── CONFIG ────────────────────────────────────────────────
const API_KEY    = process.env.API_FOOTBALL_KEY || '3b12a6e36710448864d5c63322ec29a4';
const TG_TOKEN   = process.env.TG_TOKEN         || '8826929533:AAH5CdY8yBf9p-2CM-JDYLz_ppu7bkxN5wQ';
const TG_CHAT_ID = process.env.TG_CHAT_ID       || '7324646421';
const PORT       = process.env.PORT             || 3000;

// ── PERSISTÊNCIA ──────────────────────────────────────────
const DATA_FILE   = path.join(__dirname, 'dados.json');
const CUSTOM_FILE = path.join(__dirname, 'custom.json');
const PEND_FILE   = path.join(__dirname, 'pendentes.json');

function lerArquivo(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function salvarArquivo(file, data) {
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
}

// ── ESTADO ────────────────────────────────────────────────
let dadosHist    = lerArquivo(DATA_FILE, []);
let customStrats = lerArquivo(CUSTOM_FILE, {});
let pendentes    = lerArquivo(PEND_FILE, []);
let notificados  = {};

// ── ESTRATÉGIAS ───────────────────────────────────────────
const STRAT_NAMES = {
  lay_azul:'Lay Azul', lay_xg:'Lay xG',
  over05:'Over 0.5', over15:'Over 1.5', over15l:'O1.5 LIMITE',
  am:'AM', am_xg:'AM xG',
  under35:'Under 3.5', lay_zebra:'Lay ao CS', am_limite:'AM Limite', gol_final:'Gol no Final',
  xgp_casa:'XG Casa', xgp_visit:'XG Visitante', xgp_lay:'XG Lay',
  xgp_ambas:'XG Ambas', xgp_u35:'XG U3.5',
  xgp_o15:'XG O1.5', xgp_o25:'XG O2.5', xgp_o35:'XG O3.5', xgp_05ht:'XG 0.5HT'
};

const EMOJIS = {
  lay_azul:'🔵', lay_xg:'🟣', over05:'🟢', over15:'🟠', over15l:'🟠',
  am:'🔴', am_xg:'🟤', am_limite:'🔴', gol_final:'🟡', under35:'🟡', lay_zebra:'⚪',
  xgp_casa:'🟣', xgp_visit:'🟣', xgp_lay:'🟣', xgp_ambas:'🟣',
  xgp_u35:'🟣', xgp_o15:'🟣', xgp_o25:'🟣', xgp_o35:'🟣', xgp_05ht:'🟣'
};

// ── HELPERS ───────────────────────────────────────────────
function dataHoje() {
  return new Date().toISOString().split('T')[0];
}

// Verifica se o jogo está em andamento agora (começou há menos de 2h30)
function jogoEmAndamento(horaJogo) {
  const agora = new Date();
  const [hh, mm] = (horaJogo || '00:00').split(':').map(Number);
  const inicio = new Date(agora);
  inicio.setHours(hh, mm, 0, 0);
  const minDesdeInicio = (agora - inicio) / 60000;
  // Só busca se: já começou (≥ -2min de tolerância) e menos de 150min (2h30) desde o início
  return minDesdeInicio >= -2 && minDesdeInicio <= 150;
}

// ── TELEGRAM ──────────────────────────────────────────────
async function sendTelegram(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: 'HTML' })
    });
    console.log('Telegram:', msg.slice(0, 60));
  } catch(e) {
    console.error('Telegram error:', e.message);
  }
}

// ── LIMPAR PENDENTES ANTIGOS ──────────────────────────────
function limparPendentesAntigos() {
  const hoje = dataHoje();
  const antes = pendentes.length;
  pendentes = pendentes.filter(p => !(p.data < hoje && p.result === 'pendente'));
  if (pendentes.length < antes) {
    salvarArquivo(PEND_FILE, pendentes);
  }
}

// ── MONITOR ───────────────────────────────────────────────
async function monitorar() {
  // 1. Limpar pendentes de dias anteriores
  limparPendentesAntigos();

  const hoje = dataHoje();

  // 2. Só pega pendentes de hoje que estão EM ANDAMENTO agora
  const pendAtivos = pendentes.filter(p =>
    p.result === 'pendente' &&
    p.data === hoje &&
    jogoEmAndamento(p.hora)
  );

  if (!pendAtivos.length) {
    console.log('Nenhum jogo em andamento agora.');
    return;
  }

  // 3. Jogos únicos (1 req por fixture, não por estratégia)
  const ids = [...new Set(pendAtivos.map(p => p.fixture_id).filter(Boolean))];
  console.log(`Monitorando ${ids.length} jogo(s) em andamento (${pendAtivos.length} estratégias)...`);

  for (const fid of ids) {
    try {
      const pendFid = pendAtivos.filter(p => p.fixture_id === fid);
      const p0 = pendFid[0];

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
      const agora   = new Date();
      const hora    = agora.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });

      // Jogo encerrado → marcar como resolvido
      if (['FT','AET','PEN'].includes(status)) {
        for (const p of pendFid) {
          if (p.result !== 'pendente') continue;
          p.result = 'resolvido';
          p.final  = `${ftH}x${ftA}`;
          p.ht     = htStr;
        }
        salvarArquivo(PEND_FILE, pendentes);
        continue;
      }

      // ── ALERTAS NO HT ──────────────────────────────────
      // Notifica no HT ou em qualquer momento do 2T (usando placar do HT salvo)
      const emSegundoTempo = ['2H','ET'].includes(status);
      if (status === 'HT' || emSegundoTempo) {
        // Buscar odds ao vivo no HT (1 req extra por jogo com alertas)
        let oddsAoVivo = {};
        try {
          const oddsR = await apiFetch(`odds/live?fixture=${fid}`);
          const bookmaker = oddsR?.response?.[0]?.bookmakers?.[0];
          if (bookmaker) {
            for (const bet of bookmaker.bets || []) {
              // Goals Over/Under
              if (bet.name === 'Goals Over/Under') {
                for (const v of bet.values || []) {
                  if (v.value === 'Over 0.5') oddsAoVivo['over05'] = v.odd;
                  if (v.value === 'Over 1.5') oddsAoVivo['over15'] = v.odd;
                  if (v.value === 'Over 1.5') oddsAoVivo['over15l'] = v.odd;
                  if (v.value === 'Over 2.5') oddsAoVivo['xgp_o25'] = v.odd;
                  if (v.value === 'Over 1.5') oddsAoVivo['xgp_o15'] = v.odd;
                }
              }
              // Both Teams Score
              if (bet.name === 'Both Teams Score') {
                for (const v of bet.values || []) {
                  if (v.value === 'Yes') {
                    oddsAoVivo['am']       = v.odd;
                    oddsAoVivo['am_xg']    = v.odd;
                    oddsAoVivo['xgp_ambas']= v.odd;
                  }
                }
              }
              // Under 3.5
              if (bet.name === 'Goals Over/Under') {
                for (const v of bet.values || []) {
                  if (v.value === 'Under 3.5') oddsAoVivo['xgp_u35'] = v.odd;
                }
              }
            }
          }
        // Log dos mercados disponíveis para debug
        if (bookmaker) {
          const nomes = (bookmaker.bets || []).map(b => b.name);
          console.log(`Odds live fixture ${fid}:`, nomes.join(', '));
        }
        } catch(e) {
          console.log('Odds ao vivo indisponível:', e.message);
        }

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
          else if (p.strat === 'am_limite' && totHT <= 1) deveNotificar = true;
          else if (['xgp_ambas','xgp_o15','xgp_o25'].includes(p.strat) && totHT <= 1) deveNotificar = true;
          else if (p.strat === 'xgp_u35') deveNotificar = true;
          if (!deveNotificar) continue;
          notificados[nKey] = true;
          const emoji  = EMOJIS[p.strat] || '⚪';
          const nome   = STRAT_NAMES[p.strat] || p.strat;
          const isU35  = p.strat === 'xgp_u35';
          const acao   = isU35 ? 'SAIR SE LUCRO' : 'ENTRAR';
          // Usa odd ao vivo se disponível, senão a odd cadastrada
          const oddVal = oddsAoVivo[p.strat] || p.odd;
          const oddStr = oddVal ? ` · Odd: ${parseFloat(oddVal).toFixed(2)}` : '';
          alertasJogo.push(`${emoji} <b>${acao} — ${nome}</b>${oddStr}`);
        }
        if (alertasJogo.length > 0) {
          const msg = `${alertasJogo.join('\n')}\n⚽ ${p0.jogo}\n📊 HT: ${htStr}\n⏰ ${hora}`;
          await sendTelegram(msg);
        }

        // ── ALERTAS ESPECIAIS DE COMBINAÇÃO ──────────────
        const temLayAzul = pendFid.some(p => p.strat === 'lay_azul');
        const temOver05  = pendFid.some(p => p.strat === 'over05');
        const temLayXg   = pendFid.some(p => p.strat === 'lay_xg' || p.strat === 'xgp_lay');

        // Over 0.5 2T — quando Lay Azul + HT ≤ 1 gol
        if (temLayAzul && totHT <= 1) {
          const nKey = `${fid}_over05_2t`;
          if (!notificados[nKey]) {
            notificados[nKey] = true;
            await sendTelegram(`🟢 <b>OVER 0.5 2T — considere entrar!</b>\n⚽ ${p0.jogo}\n📊 HT: ${htStr} · Lay Azul cadastrado\n💡 Odd justa Betfair: abaixo de 1.26\n⏰ ${hora}`);
          }
        }

        // Over 1.5 2T — quando Lay xG + Over 0.5 no mesmo jogo
        if (temLayXg && temOver05) {
          const nKey = `${fid}_over15_2t`;
          if (!notificados[nKey]) {
            notificados[nKey] = true;
            await sendTelegram(`🟠 <b>OVER 1.5 2T — considere entrar!</b>\n⚽ ${p0.jogo}\n📊 HT: ${htStr} · Lay xG + Over 0.5 cadastrados\n💡 Odd justa Betfair: abaixo de 1.87\n⏰ ${hora}`);
          }
        }
      }

      // ── GOL NO FINAL — alerta aos 60 minutos ──────────────
      for (const p of pendFid.filter(p => p.strat === 'under35' && ['1H','2H'].includes(status) && elapsed >= 60)) {
        const nKey = `${fid}_gol_final_60`;
        if (!notificados[nKey]) {
          notificados[nKey] = true;
          await sendTelegram(`🟡 <b>GOL NO FINAL — 60 minutos!</b>\n⚽ ${p.jogo}\n📊 ${ftH}×${ftA} · ${elapsed}'\n⏰ ${hora}\nVerifique ao vivo se entra!`);
        }
      }

      // ── ALERTAS AO VIVO ─────────────────────────────────

      // Buscar odds ao vivo para alertas em campo
      let oddsLive = {};
      try {
        const oddsR = await apiFetch(`odds/live?fixture=${fid}`);
        const bookmaker = oddsR?.response?.[0]?.bookmakers?.[0];
        if (bookmaker) {
          for (const bet of bookmaker.bets || []) {
            if (bet.name === 'Match Winner') {
              for (const v of bet.values || []) {
                if (v.value === 'Home') oddsLive['home'] = v.odd;
                if (v.value === 'Away') oddsLive['away'] = v.odd;
              }
            }
          }
        }
      } catch(e) { console.log('Odds live indisponível'); }

      // 🔵 Lay Azul — visitante na frente no 1T ou início do 2T (até 15min)
      for (const p of pendFid.filter(p => p.strat === 'lay_azul' && (status === '1H' || status === '2H') && ftA > ftH)) {
        const visitanteNaFrente = ftA > ftH;
        const nKey = `${fid}_lay_azul_${ftH}x${ftA}`;
        if (visitanteNaFrente && !notificados[nKey]) {
          notificados[nKey] = true;
          const oddVisit = oddsLive['away'] ? ` · Odd Visitante: ${parseFloat(oddsLive['away']).toFixed(2)}` : '';
          await sendTelegram(`🔵 <b>OPORTUNIDADE — Lay Azul</b>\n⚽ ${p.jogo}\n📊 Visitante na frente! ${ftH}×${ftA} · ${elapsed}'${oddVisit}\n⏰ ${hora}`);
        }
      }

      // 🟣 Lay xG — time menor xG na frente até 70min
      for (const p of pendFid.filter(p => p.strat === 'lay_xg' && elapsed <= 70 && ['1H','2H'].includes(status))) {
        const layHome  = p.lay_team === 'home';
        const naFrente = (layHome && ftH > ftA) || (!layHome && ftA > ftH);
        const nKey     = `${fid}_lay_xg_${ftH}x${ftA}`;
        if (naFrente && !notificados[nKey]) {
          notificados[nKey] = true;
          const timeNome = layHome ? f.teams.home.name : f.teams.away.name;
          const oddKey   = layHome ? 'home' : 'away';
          const oddStr   = oddsLive[oddKey] ? ` · Odd: ${parseFloat(oddsLive[oddKey]).toFixed(2)}` : '';
          await sendTelegram(`🟣 <b>OPORTUNIDADE — Lay xG</b>\n⚽ ${p.jogo}\n📊 ${timeNome} (menor xG) na frente! ${ftH}×${ftA} · ${elapsed}'${oddStr}\n⏰ ${hora}`);
        }
      }

      // 🟣 XG Lay — time menor xG na frente qualquer momento
      for (const p of pendFid.filter(p => p.strat === 'xgp_lay' && ['1H','2H','ET'].includes(status))) {
        const layHome  = p.lay_team === 'home';
        const naFrente = (layHome && ftH > ftA) || (!layHome && ftA > ftH);
        const nKey     = `${fid}_xgp_lay_${ftH}x${ftA}`;
        if (naFrente && !notificados[nKey]) {
          notificados[nKey] = true;
          const timeNome = layHome ? f.teams.home.name : f.teams.away.name;
          const oddKey   = layHome ? 'home' : 'away';
          const oddStr   = oddsLive[oddKey] ? ` · Odd: ${parseFloat(oddsLive[oddKey]).toFixed(2)}` : '';
          await sendTelegram(`🟣 <b>OPORTUNIDADE — XG Lay</b>\n⚽ ${p.jogo}\n📊 ${timeNome} (menor xG) na frente! ${ftH}×${ftA} · ${elapsed}'${oddStr}\n⏰ ${hora}`);
        }
      }

    } catch(e) {
      console.error(`Erro fixture ${fid}:`, e.message);
    }
  }
}

// ── ROTAS API ─────────────────────────────────────────────
app.get('/', (req, res) => {
  const hoje = dataHoje();
  res.json({
    status: 'ok',
    registros: dadosHist.length,
    pendentes_hoje: pendentes.filter(p=>p.result==='pendente'&&p.data===hoje).length,
    pendentes_em_andamento: pendentes.filter(p=>p.result==='pendente'&&p.data===hoje&&jogoEmAndamento(p.hora)).length,
    uptime: Math.floor(process.uptime()) + 's'
  });
});

app.get('/dados', (req, res) => { res.json(dadosHist); });
app.post('/dados', (req, res) => {
  const novos = req.body;
  if (!Array.isArray(novos)) return res.status(400).json({error:'Array esperado'});
  dadosHist = novos;
  salvarArquivo(DATA_FILE, dadosHist);
  res.json({ ok: true, total: dadosHist.length });
});

app.get('/custom', (req, res) => { res.json(customStrats); });
app.post('/custom', (req, res) => {
  customStrats = req.body;
  salvarArquivo(CUSTOM_FILE, customStrats);
  res.json({ ok: true });
});

app.get('/pendentes', (req, res) => { res.json(pendentes); });
app.post('/pendentes', (req, res) => {
  const novos = req.body;
  if (!Array.isArray(novos)) return res.status(400).json({error:'Array esperado'});
  pendentes = novos;
  salvarArquivo(PEND_FILE, pendentes);
  res.json({ ok: true, total: pendentes.length });
});

app.delete('/pendentes/:id', (req, res) => {
  pendentes = pendentes.filter(p => p.id !== parseInt(req.params.id));
  salvarArquivo(PEND_FILE, pendentes);
  res.json({ ok: true });
});

app.post('/testar-telegram', async (req, res) => {
  await sendTelegram('✅ FUTATS Server funcionando! Alertas 24h ativos. 🎯');
  res.json({ ok: true });
});

// ── API FOOTBALL ──────────────────────────────────────────
async function apiFetch(endpoint) {
  const r = await fetch(`https://v3.football.api-sports.io/${endpoint}`, {
    headers: { 'x-apisports-key': API_KEY }
  });
  return r.json();
}

// ── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`FUTATS Server v2 rodando na porta ${PORT}`);
  console.log('✅ Só monitora jogos EM ANDAMENTO (começou há menos de 2h30)');
  console.log('✅ Limpa pendentes de dias anteriores automaticamente');
  console.log('✅ Intervalo: 2 minutos');

  limparPendentesAntigos();
  setInterval(monitorar, 2 * 60 * 1000);
  sendTelegram('🚀 FUTATS v2 iniciado!\n✅ Só monitora jogos em andamento\n✅ 2 min entre ciclos\n✅ Limpeza automática de pendentes antigos');
});
