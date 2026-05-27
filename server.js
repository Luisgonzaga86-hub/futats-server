const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const API_KEY    = process.env.API_FOOTBALL_KEY || '3b12a6e36710448864d5c63322ec29a4';
const TG_TOKEN   = process.env.TG_TOKEN         || '8826929533:AAH5CdY8yBf9p-2CM-JDYLz_ppu7bkxN5wQ';
const TG_CHAT_ID = process.env.TG_CHAT_ID       || '7324646421';
const PORT       = process.env.PORT             || 3000;

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

let dadosHist    = lerArquivo(DATA_FILE, []);
let customStrats = lerArquivo(CUSTOM_FILE, {});
let pendentes    = lerArquivo(PEND_FILE, []);
let notificados  = {};

const STRAT_NAMES = {
  lay_azul:'Lay Azul', lay_xg:'Lay xG',
  over05:'Over 0.5', over15:'Over 1.5', over15l:'O1.5 LIMITE',
  am:'AM', am_xg:'AM xG',
  under35:'Gol no Final', lay_zebra:'Lay ao CS', am_limite:'AM Limite', gol_final:'Gol no Final',
  xgp_casa:'XG Casa', xgp_visit:'XG Visitante', xgp_lay:'XG Lay',
  xgp_ambas:'XG Ambas', xgp_u35:'XG U3.5',
  xgp_o15:'XG O1.5', xgp_o25:'XG O2.5', xgp_o35:'XG O3.5', xgp_05ht:'XG 0.5HT',
  atolada:'Atolada Master',
  lay_gonza:'Lay Visit Gonza', felipe15:'Felipe Over 1.5'
};

const EMOJIS = {
  lay_azul:'🔵', lay_xg:'🟣', over05:'🟢', over15:'🟠', over15l:'🟠',
  am:'🔴', am_xg:'🟤', am_limite:'🔴', gol_final:'🟡', under35:'🟡', lay_zebra:'⚪', atolada:'🟡',
  xgp_casa:'🟣', xgp_visit:'🟣', xgp_lay:'🟣', xgp_ambas:'🟣',
  xgp_u35:'🟣', xgp_o15:'🟣', xgp_o25:'🟣', xgp_o35:'🟣', xgp_05ht:'🟣',
  lay_gonza:'🩵', felipe15:'🩷'
};

function dataHoje() {
  const agora = new Date();
  const brt = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().split('T')[0];
}

function jogoEmAndamento(horaJogo, dataJogo) {
  const agora = new Date();
  const agoraBRT = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  const hoje = agoraBRT.toISOString().split('T')[0];
  if (dataJogo && dataJogo !== hoje) return false;
  const [hh, mm] = (horaJogo || '00:00').split(':').map(Number);
  const inicioBRT = new Date(agoraBRT);
  inicioBRT.setUTCHours(hh, mm, 0, 0);
  const minDesdeInicio = (agoraBRT - inicioBRT) / 60000;
  return minDesdeInicio >= -2 && minDesdeInicio <= 150;
}

async function sendTelegram(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: 'HTML' })
    });
    console.log('Telegram:', msg.slice(0, 60));
  } catch(e) { console.error('Telegram error:', e.message); }
}

function limparPendentesAntigos() {
  const hoje = dataHoje();
  const antes = pendentes.length;
  pendentes = pendentes.filter(p => !(p.data < hoje && p.result === 'pendente'));
  if (pendentes.length < antes) salvarArquivo(PEND_FILE, pendentes);
}

async function apiFetch(endpoint) {
  const r = await fetch(`https://v3.football.api-sports.io/${endpoint}`, {
    headers: { 'x-apisports-key': API_KEY }
  });
  return r.json();
}

async function monitorar() {
  limparPendentesAntigos();
  const hoje = dataHoje();

  const pendAtivos = pendentes.filter(p =>
    p.result === 'pendente' &&
    p.data === hoje &&
    jogoEmAndamento(p.hora, p.data)
  );

  if (!pendAtivos.length) {
    console.log('Nenhum jogo em andamento agora.');
    return;
  }

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
      const agoraBRT = new Date(new Date().getTime() - 3*60*60*1000);
      const hora    = agoraBRT.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });

      // Jogo encerrado
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

      // ── BUSCAR ESTATÍSTICAS AO VIVO (para Felipe Over 1.5 e Lay Gonza) ──────
      const temFelipe = pendFid.some(p => p.strat === 'felipe15');
      const temGonza  = pendFid.some(p => p.strat === 'lay_gonza');
      let statsAoVivo = null;

      if ((temFelipe || temGonza) && ['1H','2H'].includes(status)) {
        try {
          const sR = await apiFetch(`fixtures/statistics?fixture=${fid}`);
          statsAoVivo = sR?.response || [];
        } catch(e) {}
      }

      // Extrair chutes no gol por time
      let chutesGolCasa = 0, chutesGolVisit = 0;
      if (statsAoVivo) {
        for (const ts of statsAoVivo) {
          const isHome = ts.team.id === f.teams.home.id;
          const shots = ts.statistics?.find(s => s.type === 'Shots on Goal');
          if (isHome) chutesGolCasa = parseInt(shots?.value || 0);
          else chutesGolVisit = parseInt(shots?.value || 0);
        }
      }

      // ── ALERTAS NO HT ──────────────────────────────────
      const emSegundoTempo = ['2H','ET'].includes(status);
      if (status === 'HT' || emSegundoTempo) {
        let oddsAoVivo = {};
        try {
          const oddsR = await apiFetch(`odds/live?fixture=${fid}`);
          const bookmaker = oddsR?.response?.[0]?.bookmakers?.[0];
          if (bookmaker) {
            for (const bet of bookmaker.bets || []) {
              if (bet.name === 'Goals Over/Under') {
                for (const v of bet.values || []) {
                  if (v.value === 'Over 0.5') oddsAoVivo['over05'] = v.odd;
                  if (v.value === 'Over 1.5') { oddsAoVivo['over15'] = v.odd; oddsAoVivo['over15l'] = v.odd; oddsAoVivo['xgp_o15'] = v.odd; oddsAoVivo['felipe15'] = v.odd; }
                  if (v.value === 'Over 2.5') oddsAoVivo['xgp_o25'] = v.odd;
                  if (v.value === 'Under 3.5') oddsAoVivo['xgp_u35'] = v.odd;
                }
              }
              if (bet.name === 'Both Teams Score') {
                for (const v of bet.values || []) {
                  if (v.value === 'Yes') { oddsAoVivo['am'] = v.odd; oddsAoVivo['am_xg'] = v.odd; oddsAoVivo['xgp_ambas'] = v.odd; }
                }
              }
              if (bet.name === 'Match Winner') {
                for (const v of bet.values || []) {
                  if (v.value === 'Away') oddsAoVivo['lay_gonza'] = v.odd;
                }
              }
            }
          }
        } catch(e) {}

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
          // Felipe Over 1.5 — HT 0x0 com ≥4 chutes no gol total
          else if (p.strat === 'felipe15' && totHT === 0 && (chutesGolCasa + chutesGolVisit) >= 4) deveNotificar = true;
          if (!deveNotificar) continue;
          notificados[nKey] = true;
          const emoji  = EMOJIS[p.strat] || '⚪';
          const nome   = STRAT_NAMES[p.strat] || p.strat;
          const isU35  = p.strat === 'xgp_u35';
          const acao   = isU35 ? 'SAIR SE LUCRO' : 'ENTRAR';
          const oddVal = oddsAoVivo[p.strat] || p.odd;
          const oddStr = oddVal ? ` · Odd: ${parseFloat(oddVal).toFixed(2)}` : '';
          const extraInfo = p.strat === 'felipe15' ? ` · 🎯 Chutes: ${chutesGolCasa}C+${chutesGolVisit}V=${chutesGolCasa+chutesGolVisit}` : '';
          alertasJogo.push(`${emoji} <b>${acao} — ${nome}</b>${oddStr}${extraInfo}`);
        }
        if (alertasJogo.length > 0) {
          await sendTelegram(`${alertasJogo.join('\n')}\n⚽ ${p0.jogo}\n📊 HT: ${htStr}\n⏰ ${hora}`);
        }

        // ── ALERTAS ESPECIAIS ──────────────────────────────
        const temLayAzul = pendFid.some(p => p.strat === 'lay_azul');
        const temOver05  = pendFid.some(p => p.strat === 'over05');
        const temLayXg   = pendFid.some(p => p.strat === 'lay_xg' || p.strat === 'xgp_lay');
        const temAtolada = pendFid.some(p => ['lay_azul','am','over15','am_xg','lay_xg'].includes(p.strat));

        if (temLayAzul && totHT <= 1) {
          const nKey = `${fid}_over05_2t`;
          if (!notificados[nKey]) {
            notificados[nKey] = true;
            await sendTelegram(`🟢 <b>OVER 0.5 2T — considere entrar!</b>\n⚽ ${p0.jogo}\n📊 HT: ${htStr} · Lay Azul cadastrado\n💡 Odd justa Betfair: abaixo de 1.26\n⏰ ${hora}`);
          }
        }

        if (temLayXg && temOver05 && totHT <= 1) {
          const nKey = `${fid}_over15_2t`;
          if (!notificados[nKey]) {
            notificados[nKey] = true;
            await sendTelegram(`🟠 <b>OVER 1.5 2T — considere entrar!</b>\n⚽ ${p0.jogo}\n📊 HT: ${htStr} · Lay xG + Over 0.5\n💡 Odd justa Betfair: abaixo de 1.87\n⏰ ${hora}`);
          }
        }

        if (temAtolada && totHT === 0) {
          const nKey = `${fid}_atolada_master`;
          if (!notificados[nKey]) {
            notificados[nKey] = true;
            await sendTelegram(`🟡 <b>ATOLADA MASTER DO GONZA!</b>\n⚽ ${p0.jogo}\n📊 HT: 0×0\n💡 Over 0.5 2T — odd mín Betfair: 1.25\n📈 Taxa histórica: 84.3%\n⏰ ${hora}`);
          }
        }

        // ── LAY VISITANTE GONZA — HT: visitante na frente ──
        for (const p of pendFid.filter(p => p.strat === 'lay_gonza' && status === 'HT' && ftA > ftH)) {
          const nKey = `${fid}_lay_gonza_ht`;
          if (!notificados[nKey]) {
            notificados[nKey] = true;
            const oddVisit = oddsAoVivo['lay_gonza'] ? ` · Odd Visit: ${parseFloat(oddsAoVivo['lay_gonza']).toFixed(2)}` : '';
            await sendTelegram(`🩵 <b>LAY VISIT GONZA — Considere Gol Limite 2T!</b>\n⚽ ${p.jogo}\n📊 HT: ${htStr} · Visitante na frente${oddVisit}\n⏰ ${hora}`);
          }
        }
      }

      // ── GOL NO FINAL — alerta aos 60 minutos ──────────────
      for (const p of pendFid.filter(p => (p.strat === 'under35' || p.strat === 'gol_final') && ['1H','2H'].includes(status) && elapsed >= 60)) {
        const nKey = `${fid}_gol_final_60`;
        if (!notificados[nKey]) {
          notificados[nKey] = true;
          await sendTelegram(`🟡 <b>GOL NO FINAL — 60 minutos!</b>\n⚽ ${p.jogo}\n📊 ${ftH}×${ftA} · ${elapsed}'\n⏰ ${hora}\nVerifique ao vivo se entra!`);
        }
      }

      // ── ALERTAS AO VIVO ─────────────────────────────────
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
      } catch(e) {}

      // 🔵 Lay Azul
      for (const p of pendFid.filter(p => p.strat === 'lay_azul' && (status === '1H' || status === '2H') && ftA > ftH)) {
        const nKey = `${fid}_lay_azul_${ftH}x${ftA}`;
        if (!notificados[nKey]) {
          notificados[nKey] = true;
          const oddVisit = oddsLive['away'] ? ` · Odd Visitante: ${parseFloat(oddsLive['away']).toFixed(2)}` : '';
          await sendTelegram(`🔵 <b>OPORTUNIDADE — Lay Azul</b>\n⚽ ${p.jogo}\n📊 Visitante na frente! ${ftH}×${ftA} · ${elapsed}'${oddVisit}\n⏰ ${hora}`);
        }
      }

      // 🟣 Lay xG
      for (const p of pendFid.filter(p => p.strat === 'lay_xg' && elapsed <= 70 && ['1H','2H'].includes(status))) {
        const layHome  = p.lay_team === 'home';
        const naFrente = (layHome && ftH > ftA) || (!layHome && ftA > ftH);
        const nKey     = `${fid}_lay_xg_${ftH}x${ftA}`;
        if (naFrente && !notificados[nKey]) {
          notificados[nKey] = true;
          const timeNome = layHome ? f.teams.home.name : f.teams.away.name;
          const oddKey = layHome ? 'home' : 'away';
          const oddStr = oddsLive[oddKey] ? ` · Odd: ${parseFloat(oddsLive[oddKey]).toFixed(2)}` : '';
          await sendTelegram(`🟣 <b>OPORTUNIDADE — Lay xG</b>\n⚽ ${p.jogo}\n📊 ${timeNome} (menor xG) na frente! ${ftH}×${ftA} · ${elapsed}'${oddStr}\n⏰ ${hora}`);
        }
      }

      // 🟣 XG Lay
      for (const p of pendFid.filter(p => p.strat === 'xgp_lay' && ['1H','2H','ET'].includes(status))) {
        const layHome  = p.lay_team === 'home';
        const naFrente = (layHome && ftH > ftA) || (!layHome && ftA > ftH);
        const nKey     = `${fid}_xgp_lay_${ftH}x${ftA}`;
        if (naFrente && !notificados[nKey]) {
          notificados[nKey] = true;
          const timeNome = layHome ? f.teams.home.name : f.teams.away.name;
          const oddKey = layHome ? 'home' : 'away';
          const oddStr = oddsLive[oddKey] ? ` · Odd: ${parseFloat(oddsLive[oddKey]).toFixed(2)}` : '';
          await sendTelegram(`🟣 <b>OPORTUNIDADE — XG Lay</b>\n⚽ ${p.jogo}\n📊 ${timeNome} (menor xG) na frente! ${ftH}×${ftA} · ${elapsed}'${oddStr}\n⏰ ${hora}`);
        }
      }

      // 🩵 LAY VISITANTE GONZA — visitante marcou primeiro (1T)
      for (const p of pendFid.filter(p => p.strat === 'lay_gonza' && status === '1H' && ftA > ftH)) {
        const nKey = `${fid}_lay_gonza_${ftH}x${ftA}`;
        if (!notificados[nKey]) {
          notificados[nKey] = true;
          const oddVisit = oddsLive['away'] ? ` · Odd Visit: ${parseFloat(oddsLive['away']).toFixed(2)}` : '';
          await sendTelegram(`🩵 <b>LAY VISIT GONZA — Visitante marcou primeiro!</b>\n⚽ ${p.jogo}\n📊 ${ftH}×${ftA} · ${elapsed}'${oddVisit}\n💡 Aguarde HT para Gol Limite 2T\n⏰ ${hora}`);
        }
      }

      // 🩷 FELIPE OVER 1.5 — aos 20 min com 1+ chute no gol de cada time
      for (const p of pendFid.filter(p => p.strat === 'felipe15' && status === '1H' && elapsed >= 18 && elapsed <= 22 && ftH === 0 && ftA === 0)) {
        const nKey = `${fid}_felipe15_20min`;
        if (!notificados[nKey] && chutesGolCasa >= 1 && chutesGolVisit >= 1) {
          notificados[nKey] = true;
          const oddOver = oddsLive['home'] ? ` · Odd Over 1.5: verifique` : '';
          await sendTelegram(`🩷 <b>FELIPE OVER 1.5 — Condição atingida aos ${elapsed}'!</b>\n⚽ ${p.jogo}\n📊 0×0 · 🎯 Chutes gol: ${chutesGolCasa}C + ${chutesGolVisit}V\n💡 Considere entrar no Over 1.5\n⏰ ${hora}`);
        }
      }

    } catch(e) { console.error(`Erro fixture ${fid}:`, e.message); }
  }
}

// ── ROTAS ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  const hoje = dataHoje();
  res.json({
    status: 'ok', registros: dadosHist.length,
    pendentes_hoje: pendentes.filter(p=>p.result==='pendente'&&p.data===hoje).length,
    pendentes_em_andamento: pendentes.filter(p=>p.result==='pendente'&&p.data===hoje&&jogoEmAndamento(p.hora,p.data)).length,
    uptime: Math.floor(process.uptime()) + 's'
  });
});

app.get('/dados', (req, res) => { res.json(dadosHist); });
app.post('/dados', (req, res) => {
  const novos = req.body;
  if (!Array.isArray(novos)) return res.status(400).json({error:'Array esperado'});
  dadosHist = novos; salvarArquivo(DATA_FILE, dadosHist);
  res.json({ ok: true, total: dadosHist.length });
});

app.get('/custom', (req, res) => { res.json(customStrats); });
app.post('/custom', (req, res) => { customStrats = req.body; salvarArquivo(CUSTOM_FILE, customStrats); res.json({ ok: true }); });

app.get('/pendentes', (req, res) => { res.json(pendentes); });
app.post('/pendentes', (req, res) => {
  const novos = req.body;
  if (!Array.isArray(novos)) return res.status(400).json({error:'Array esperado'});
  pendentes = novos; salvarArquivo(PEND_FILE, pendentes);
  res.json({ ok: true, total: pendentes.length });
});

app.delete('/pendentes/:id', (req, res) => {
  pendentes = pendentes.filter(p => p.id !== parseInt(req.params.id));
  salvarArquivo(PEND_FILE, pendentes);
  res.json({ ok: true });
});

// ── SUGESTÕES ─────────────────────────────────────────────
app.get('/sugestoes/lay-visitante', async (req, res) => {
  try { res.json(await buscarJogosLayVisitante(dataHoje())); }
  catch(e) { res.json([]); }
});

app.get('/sugestoes/felipe15', async (req, res) => {
  try { res.json(await buscarJogosFelipe15(dataHoje())); }
  catch(e) { res.json([]); }
});

async function buscarJogosLayVisitante(data) {
  const resultado = [];
  const r = await apiFetch(`fixtures?date=${data}&timezone=America/Sao_Paulo`);
  const fixtures = r?.response || [];
  console.log(`Lay Gonza: buscando em ${fixtures.length} jogos...`);

  for (const f of fixtures) {
    try {
      const fid = f.fixture.id;
      const homeId = f.teams.home.id;
      const awayId = f.teams.away.id;

      const oddsR = await apiFetch(`odds?fixture=${fid}&bookmaker=2`);
      const bets = oddsR?.response?.[0]?.bookmakers?.[0]?.bets || [];
      const h2h = bets.find(b => b.name === 'Match Winner');
      if (!h2h) continue;
      const oddCasa = parseFloat(h2h.values?.find(v=>v.value==='Home')?.odd || 0);
      if (!oddCasa || oddCasa < 1.01 || oddCasa > 1.60) continue;

      const statsR = await apiFetch(`teams/statistics?team=${homeId}&season=2025&league=${f.league.id}`);
      const stats = statsR?.response;
      if (!stats) continue;
      const xgCasa = stats.goals?.for?.average?.home;
      if (!xgCasa) continue;
      const partidasCasa = stats.fixtures?.played?.home || 0;
      if (partidasCasa < 3 || partidasCasa > 38) continue;
      const xgCasaNum = parseFloat(xgCasa);
      if (xgCasaNum < 1.8) continue;
      const xgaCasa = parseFloat(stats.goals?.against?.average?.home || 0);
      if (xgaCasa > 0.90) continue;
      const mediaGolsHT = parseFloat(stats.goals?.for?.average?.home || 0) / 2;
      if (mediaGolsHT > 1.5) continue;
      const pctDerrotaHT = ((stats.fixtures?.loses?.home || 0) / (stats.fixtures?.played?.home || 1)) * 100;
      if (pctDerrotaHT > 42.86) continue;

      const statsAwayR = await apiFetch(`teams/statistics?team=${awayId}&season=2025&league=${f.league.id}`);
      const statsAway = statsAwayR?.response;
      if (!statsAway) continue;
      const partidasFora = statsAway.fixtures?.played?.away || 0;
      if (partidasFora < 3 || partidasFora > 38) continue;
      const xgFora = parseFloat(statsAway.goals?.for?.average?.away || 0);
      if (xgFora < 0.01 || xgFora > 0.80) continue;
      const xgaFora = parseFloat(statsAway.goals?.against?.average?.away || 0);
      if (xgaFora < 1.8) continue;

      resultado.push({
        fixture_id: fid, hora: f.fixture.date?.slice(11,16) || '',
        liga: f.league.name, home: f.teams.home.name, away: f.teams.away.name,
        odd_casa: oddCasa.toFixed(2), xg_casa: xgCasaNum.toFixed(2), xg_fora: xgFora.toFixed(2),
        xga_casa: xgaCasa.toFixed(2), xga_fora: xgaFora.toFixed(2),
        pct_derrota_ht: pctDerrotaHT.toFixed(1), media_gols_ht: mediaGolsHT.toFixed(2),
        partidas_casa: partidasCasa, partidas_fora: partidasFora
      });
    } catch(e) { continue; }
  }
  return resultado;
}

async function buscarJogosFelipe15(data) {
  const resultado = [];
  const r = await apiFetch(`fixtures?date=${data}&timezone=America/Sao_Paulo`);
  const fixtures = r?.response || [];
  console.log(`Felipe15: buscando em ${fixtures.length} jogos...`);

  for (const f of fixtures) {
    try {
      const fid = f.fixture.id;
      const homeId = f.teams.home.id;
      const awayId = f.teams.away.id;

      const statsR = await apiFetch(`teams/statistics?team=${homeId}&season=2025&league=${f.league.id}`);
      const stats = statsR?.response;
      if (!stats) continue;
      // Verificar se tem xG (liga com cobertura)
      if (!stats.goals?.for?.average?.home) continue;

      const mediaGolsCasa = parseFloat(stats.goals?.for?.average?.home || 0);
      const mediaGolsSofCasa = parseFloat(stats.goals?.against?.average?.home || 0);
      if (mediaGolsCasa < 1.2 || mediaGolsCasa > 6) continue;
      if (mediaGolsSofCasa < 1 || mediaGolsSofCasa > 5) continue;

      const statsAwayR = await apiFetch(`teams/statistics?team=${awayId}&season=2025&league=${f.league.id}`);
      const statsAway = statsAwayR?.response;
      if (!statsAway) continue;

      const mediaGolsFora = parseFloat(statsAway.goals?.for?.average?.away || 0);
      const mediaGolsSofFora = parseFloat(statsAway.goals?.against?.average?.away || 0);
      if (mediaGolsFora < 1.1 || mediaGolsFora > 5) continue;
      if (mediaGolsSofFora < 1 || mediaGolsSofFora > 6) continue;

      // xG Casa e xG Fora
      const xgCasa = parseFloat(stats.goals?.for?.average?.home || 0);
      const xgFora = parseFloat(statsAway.goals?.for?.average?.away || 0);
      const xgTotal = xgCasa + xgFora;
      if (xgCasa < 1.2 || xgFora < 1.0) continue;
      if (xgTotal < 2.26) continue;

      resultado.push({
        fixture_id: fid, hora: f.fixture.date?.slice(11,16) || '',
        liga: f.league.name, home: f.teams.home.name, away: f.teams.away.name,
        xg_casa: xgCasa.toFixed(2), xg_fora: xgFora.toFixed(2), xg_total: xgTotal.toFixed(2),
        media_gols_casa: mediaGolsCasa.toFixed(2), media_gols_fora: mediaGolsFora.toFixed(2),
        media_sof_casa: mediaGolsSofCasa.toFixed(2), media_sof_fora: mediaGolsSofFora.toFixed(2)
      });
    } catch(e) { continue; }
  }
  return resultado;
}

app.post('/testar-telegram', async (req, res) => {
  await sendTelegram('✅ FUTATS Server funcionando! 🎯');
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`FUTATS Server v2 rodando na porta ${PORT}`);
  console.log('✅ Lay Visitante Gonza + Felipe Over 1.5 ativos');
  console.log('✅ Intervalo: 2 minutos');
  limparPendentesAntigos();
  setInterval(monitorar, 2 * 60 * 1000);
  sendTelegram('🚀 FUTATS v2 iniciado!\n✅ Lay Gonza + Felipe15 ativos\n✅ 2 min entre ciclos');
});
