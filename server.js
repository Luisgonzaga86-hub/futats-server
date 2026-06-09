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
const TG_CHAT_IDS = [TG_CHAT_ID, '-1003914910677'];
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
  over05:'Over 0.5', over15:'Over 1.5',
  am:'AM', am_xg:'AM xG',
  under35:'Gol no Final', lay_zebra:'Lay ao CS', gol_final:'Gol no Final',
  atolada:'Atolada Master',
  lay_gonza:'Lay Visit Gonza', felipe15:'Felipe Over 1.5', gol2t_xga:'Gol 2T XGA',
  lay_0x1_ia:'Lay 0x1 IA'
};

const EMOJIS = {
  lay_azul:'🔵', lay_xg:'🟣', over05:'🟢', over15:'🟠',
  am:'🔴', am_xg:'🟤', gol_final:'🟡', under35:'🟡', lay_zebra:'⚪', atolada:'🟡',
  lay_gonza:'🩵', felipe15:'🩷', gol2t_xga:'🟣',
  lay_0x1_ia:'🤖'
};

function dataHoje() {
  const agora = new Date();
  const brt = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().split('T')[0];
}

// ── CORRIGIDO: usar timestamp BRT puro, sem setUTCHours ──
function jogoEmAndamento(horaJogo, dataJogo) {
  const agora = new Date();
  const agoraBRT = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  const hoje = agoraBRT.toISOString().split('T')[0];
  if (dataJogo && dataJogo !== hoje) return false;
  const [hh, mm] = (horaJogo || '00:00').split(':').map(Number);
  // Montar início do jogo como timestamp BRT:
  // dataHoje em BRT + hh:mm = horário BRT → converter para UTC adicionando 3h
  const inicioBRTms = Date.parse(`${hoje}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00.000Z`) + 3 * 60 * 60 * 1000;
  const minDesdeInicio = (agora.getTime() - inicioBRTms) / 60000;
  return minDesdeInicio >= -2 && minDesdeInicio <= 150;
}

async function sendTelegram(msg) {
  for (const chatId of TG_CHAT_IDS) {
    try {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' })
      });
    } catch(e) { console.error('Telegram error ('+chatId+'):', e.message); }
  }
  console.log('Telegram:', msg.slice(0, 60));
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

      if (['FT','AET','PEN'].includes(status)) {
        for (const p of pendFid) {
          if (p.result !== 'pendente') continue;
          p.final = `${ftH}x${ftA}`;
          p.ht    = htStr;
          if (p.strat === 'under35' || p.strat === 'gol_final') {
            const golsFinais = ftH + ftA;
            const golsNoAlerta = p.gols_no_alerta ?? golsFinais;
            p.result = golsFinais > golsNoAlerta ? 'green' : 'red';
          } else if (p.strat === 'lay_0x1_ia') {
            p.result = (ftH === 0 && ftA === 1) ? 'red' : 'green';
          } else if (p.strat === 'lay_zebra') {
            p.result = (ftH === 0 && ftA === 2) ? 'red' : 'green';
          } else {
            p.result = 'resolvido';
          }
        }
        salvarArquivo(PEND_FILE, pendentes);
        continue;
      }

      const temFelipe = pendFid.some(p => p.strat === 'felipe15');
      const temGonza  = pendFid.some(p => p.strat === 'lay_gonza');
      let statsAoVivo = null;

      if ((temFelipe || temGonza) && ['1H','2H'].includes(status)) {
        try {
          const sR = await apiFetch(`fixtures/statistics?fixture=${fid}`);
          statsAoVivo = sR?.response || [];
        } catch(e) {}
      }

      let chutesGolCasa = 0, chutesGolVisit = 0;
      if (statsAoVivo) {
        for (const ts of statsAoVivo) {
          const isHome = ts.team.id === f.teams.home.id;
          const shots = ts.statistics?.find(s => s.type === 'Shots on Goal');
          if (isHome) chutesGolCasa = parseInt(shots?.value || 0);
          else chutesGolVisit = parseInt(shots?.value || 0);
        }
      }

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
                  if (v.value === 'Over 1.5') { oddsAoVivo['over15'] = v.odd; oddsAoVivo['felipe15'] = v.odd; }
                  if (v.value === 'Over 2.5') oddsAoVivo['over25'] = v.odd;
                }
              }
              if (bet.name === 'Both Teams Score') {
                for (const v of bet.values || []) {
                  if (v.value === 'Yes') { oddsAoVivo['am'] = v.odd; oddsAoVivo['am_xg'] = v.odd; }
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
          else if (p.strat === 'am' && totHT <= 1) deveNotificar = true;
          else if (p.strat === 'am_xg' && totHT <= 1) deveNotificar = true;
          else if (p.strat === 'felipe15' && totHT === 0 && (chutesGolCasa + chutesGolVisit) >= 4) deveNotificar = true;
          else if (p.strat === 'gol2t_xga' && totHT === 0) deveNotificar = true;
          if (!deveNotificar) continue;
          notificados[nKey] = true;
          const emoji  = EMOJIS[p.strat] || '⚪';
          const nome   = STRAT_NAMES[p.strat] || p.strat;
          const oddVal = oddsAoVivo[p.strat] || p.odd;
          const oddStr = oddVal ? ` · Odd: ${parseFloat(oddVal).toFixed(2)}` : '';
          const extraInfo = p.strat === 'felipe15' ? ` · 🎯 Chutes: ${chutesGolCasa}C+${chutesGolVisit}V=${chutesGolCasa+chutesGolVisit}` : '';
          alertasJogo.push(`${emoji} <b>ENTRAR — ${nome}</b>${oddStr}${extraInfo}`);
        }

        // Gol no Final — alerta no HT com odd live do próximo gol
        for (const p of pendFid.filter(p => (p.strat === 'under35' || p.strat === 'gol_final') && status === 'HT')) {
          const nKey = `${fid}_gol_final_ht`;
          if (!notificados[nKey]) {
            notificados[nKey] = true;
            p.gols_no_alerta = htH + htA;
            salvarArquivo(PEND_FILE, pendentes);
            // Determinar mercado baseado no placar HT
            const totalHT = htH + htA;
            let mercadoGF, oddGF;
            if (totalHT === 0) { mercadoGF = 'Over 0.5'; oddGF = oddsAoVivo['over05']; }
            else if (totalHT === 1) { mercadoGF = 'Over 1.5'; oddGF = oddsAoVivo['over15']; }
            else { mercadoGF = 'Over 2.5'; oddGF = oddsAoVivo['over25']; }
            const oddStrGF = oddGF ? ` · Odd ${mercadoGF}: ${parseFloat(oddGF).toFixed(2)}` : ` · Mercado: ${mercadoGF}`;
            await sendTelegram(`🟡 <b>GOL NO FINAL — Intervalo!</b>\n⚽ ${p.jogo}\n📊 HT: ${htStr}${oddStrGF}\n💡 Verifique ao vivo se entra!\n⏰ ${hora}`);
          }
        }
        if (alertasJogo.length > 0) {
          await sendTelegram(`${alertasJogo.join('\n')}\n⚽ ${p0.jogo}\n📊 HT: ${htStr}\n⏰ ${hora}`);
        }

        const temLayAzul = pendFid.some(p => p.strat === 'lay_azul');
        const temOver05  = pendFid.some(p => p.strat === 'over05');
        const temLayXg   = pendFid.some(p => p.strat === 'lay_xg');
        const temAtolada = pendFid.some(p => ['lay_azul','over05','over15','am_xg','lay_xg'].includes(p.strat));

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
            const oddAtolada = oddsAoVivo['over05'];
            const oddStrAtolada = oddAtolada ? ` · Odd Over 0.5: ${parseFloat(oddAtolada).toFixed(2)}` : '';
            await sendTelegram(`🟡 <b>ATOLADA MASTER DO GONZA!</b>\n⚽ ${p0.jogo}\n📊 HT: 0×0${oddStrAtolada}\n💡 Over 0.5 2T — taxa histórica: 84.3%\n⏰ ${hora}`);
          }
        }

        for (const p of pendFid.filter(p => p.strat === 'lay_gonza' && status === 'HT' && ftA > ftH)) {
          const nKey = `${fid}_lay_gonza_ht`;
          if (!notificados[nKey]) {
            notificados[nKey] = true;
            const oddVisit = oddsAoVivo['lay_gonza'] ? ` · Odd Visit: ${parseFloat(oddsAoVivo['lay_gonza']).toFixed(2)}` : '';
            await sendTelegram(`🩵 <b>LAY VISIT GONZA — Considere Gol Limite 2T!</b>\n⚽ ${p.jogo}\n📊 HT: ${htStr} · Visitante na frente${oddVisit}\n⏰ ${hora}`);
          }
        }
      }

      // Gol no Final já é alertado no HT — removido alerta dos 60 min

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

      for (const p of pendFid.filter(p => p.strat === 'lay_azul' && (status === '1H' || status === '2H') && ftA > ftH)) {
        const nKey = `${fid}_lay_azul_${ftH}x${ftA}`;
        if (!notificados[nKey]) {
          notificados[nKey] = true;
          const oddVisit = oddsLive['away'] ? ` · Odd Visitante: ${parseFloat(oddsLive['away']).toFixed(2)}` : '';
          await sendTelegram(`🔵 <b>OPORTUNIDADE — Lay Azul</b>\n⚽ ${p.jogo}\n📊 Visitante na frente! ${ftH}×${ftA} · ${elapsed}'${oddVisit}\n⏰ ${hora}`);
        }
      }

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

      for (const p of pendFid.filter(p => p.strat === 'lay_gonza' && status === '1H' && ftA > ftH)) {
        const nKey = `${fid}_lay_gonza_${ftH}x${ftA}`;
        if (!notificados[nKey]) {
          notificados[nKey] = true;
          const oddVisit = oddsLive['away'] ? ` · Odd Visit: ${parseFloat(oddsLive['away']).toFixed(2)}` : '';
          await sendTelegram(`🩵 <b>LAY VISIT GONZA — Visitante marcou primeiro!</b>\n⚽ ${p.jogo}\n📊 ${ftH}×${ftA} · ${elapsed}'${oddVisit}\n💡 Aguarde HT para Gol Limite 2T\n⏰ ${hora}`);
        }
      }

      for (const p of pendFid.filter(p => p.strat === 'lay_0x1_ia' && ['1H','2H'].includes(status) && ftH === 0 && ftA === 1)) {
        const nKey = `${fid}_lay_0x1_ia_alerta`;
        if (!notificados[nKey]) {
          notificados[nKey] = true;
          const oddVisit = oddsLive['away'] ? ` · Odd Visit: ${parseFloat(oddsLive['away']).toFixed(2)}` : '';
          await sendTelegram(`🤖 <b>OPORTUNIDADE — Lay 0x1 IA</b>\n⚽ ${p.jogo}\n📊 Visitante fez 0×1 · ${elapsed}'${oddVisit}\n💡 Lay no Placar Correto 0x1\n🔴 Red SOMENTE se terminar 0x1\n⏰ ${hora}`);
        }
      }

      for (const p of pendFid.filter(p => p.strat === 'lay_zebra' && ['1H','2H'].includes(status) && ftH === 0 && ftA >= 1)) {
        const nKey = `${fid}_lay_zebra_visit_gol_${ftA}`;
        if (!notificados[nKey]) {
          notificados[nKey] = true;
          const oddVisit = oddsLive['away'] ? ` · Odd Visit: ${parseFloat(oddsLive['away']).toFixed(2)}` : '';
          const msg = ftA === 1
            ? `⚪ <b>LAY AO CS — Visitante fez 0×1!</b>\n⚽ ${p.jogo}\n📊 ${ftH}×${ftA} · ${elapsed}'${oddVisit}\n💡 Atenção: caminho para o 0×2\n🔴 Red SOMENTE se terminar 0×2\n⏰ ${hora}`
            : `⚪ <b>LAY AO CS — Visitante fez ${ftH}×${ftA}!</b>\n⚽ ${p.jogo}\n📊 ${ftH}×${ftA} · ${elapsed}'${oddVisit}\n⚠️ Risco de 0×2 — monitore!\n⏰ ${hora}`;
          await sendTelegram(msg);
        }
      }

      for (const p of pendFid.filter(p => p.strat === 'felipe15' && status === '1H' && elapsed >= 18 && elapsed <= 22 && ftH === 0 && ftA === 0)) {
        const nKey = `${fid}_felipe15_20min`;
        if (!notificados[nKey] && chutesGolCasa >= 1 && chutesGolVisit >= 1) {
          notificados[nKey] = true;
          await sendTelegram(`🩷 <b>FELIPE OVER 1.5 — Condição atingida aos ${elapsed}'!</b>\n⚽ ${p.jogo}\n📊 0×0 · 🎯 Chutes gol: ${chutesGolCasa}C + ${chutesGolVisit}V\n💡 Considere entrar no Over 1.5\n⏰ ${hora}`);
        }
      }

    } catch(e) { console.error(`Erro fixture ${fid}:`, e.message); }
  }
}

const LIGAS_PERMITIDAS = new Set([
  2, 3, 848,
  39, 40, 41, 45, 48,
  140, 141,
  135, 136,
  78, 79,
  61, 62,
  94, 95,
  88, 89,
  144, 203, 179, 113, 103, 119, 244, 106, 235, 197, 210, 283, 207, 218,
  71, 72, 128, 265, 239, 262, 253, 242, 281, 268, 269,
  98, 99, 292, 169, 307, 188,
]);

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
  // Se chegou lista vazia, NÃO sobrescrever — pode ser bug de fuso no cliente
  if (novos.length === 0) return res.json({ ok: true, total: pendentes.length, aviso: 'lista vazia ignorada' });
  // Merge: manter pendentes do servidor que não vieram no payload + substituir os que vieram
  const idsNovos = new Set(novos.map(p => String(p.id)));
  const mantidos = pendentes.filter(p => !idsNovos.has(String(p.id)) && p.result === 'pendente');
  pendentes = [...novos, ...mantidos];
  salvarArquivo(PEND_FILE, pendentes);
  res.json({ ok: true, total: pendentes.length });
});

app.delete('/pendentes/:id', (req, res) => {
  pendentes = pendentes.filter(p => p.id !== parseInt(req.params.id));
  salvarArquivo(PEND_FILE, pendentes);
  res.json({ ok: true });
});

app.get('/sugestoes/lay-visitante', async (req, res) => {
  try { res.json(await buscarJogosLayVisitante(dataHoje())); }
  catch(e) { res.json([]); }
});

app.get('/sugestoes/gol2t-xga', async (req, res) => {
  try { res.json(await buscarJogosGol2tXga(dataHoje())); }
  catch(e) { console.error('Erro gol2t-xga:', e.message); res.json([]); }
});

app.get('/sugestoes/felipe15', async (req, res) => {
  try { res.json(await buscarJogosFelipe15(dataHoje())); }
  catch(e) { res.json([]); }
});

async function buscarJogosLayVisitante(data) {
  const resultado = [];
  const r = await apiFetch(`fixtures?date=${data}&timezone=America/Sao_Paulo`);
  const fixtures = r?.response || [];
  const ligasFiltradas = fixtures.filter(f => LIGAS_PERMITIDAS.has(f.league.id));
  console.log(`Lay Gonza: buscando em ${ligasFiltradas.length} jogos (${fixtures.length} total)...`);
  for (const f of ligasFiltradas) {
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

async function buscarJogosGol2tXga(data) {
  const resultado = [];
  const r = await apiFetch(`fixtures?date=${data}&timezone=America/Sao_Paulo`);
  const fixtures = r?.response || [];
  const ligasFiltradas = fixtures.filter(f => LIGAS_PERMITIDAS.has(f.league.id));
  for (const f of ligasFiltradas) {
    try {
      const fid = f.fixture.id;
      const homeId = f.teams.home.id;
      const awayId = f.teams.away.id;
      const oddsR = await apiFetch(`odds?fixture=${fid}&bookmaker=2`);
      const bets = oddsR?.response?.[0]?.bookmakers?.[0]?.bets || [];
      const h2h = bets.find(b => b.name === 'Match Winner');
      if (!h2h) continue;
      const oddCasa = parseFloat(h2h.values?.find(v=>v.value==='Home')?.odd || 0);
      if (!oddCasa || oddCasa > 1.60) continue;
      const goalsMarket = bets.find(b => b.name === 'Goals Over/Under');
      const oddOver05 = parseFloat(goalsMarket?.values?.find(v=>v.value==='Over 0.5')?.odd || 0);
      const statsAwayR = await apiFetch(`teams/statistics?team=${awayId}&season=2025&league=${f.league.id}`);
      const statsAway = statsAwayR?.response;
      if (!statsAway) continue;
      if (!statsAway.goals?.against?.average?.away) continue;
      const xgaFora = parseFloat(statsAway.goals?.against?.average?.away || 0);
      if (xgaFora < 1.50) continue;
      const statsHomeR = await apiFetch(`teams/statistics?team=${homeId}&season=2025&league=${f.league.id}`);
      const statsHome = statsHomeR?.response;
      const xgCasa = parseFloat(statsHome?.goals?.for?.average?.home || 0);
      const xgaCasa = parseFloat(statsHome?.goals?.against?.average?.home || 0);
      const xgFora = parseFloat(statsAway?.goals?.for?.average?.away || 0);
      resultado.push({
        fixture_id: fid, hora: f.fixture.date?.slice(11,16) || '',
        liga: f.league.name, home: f.teams.home.name, away: f.teams.away.name,
        home_id: homeId, away_id: awayId, league_id: f.league.id,
        odd_casa: oddCasa.toFixed(2), odd_over05: oddOver05 ? oddOver05.toFixed(2) : null,
        xg_casa: xgCasa.toFixed(2), xga_casa: xgaCasa.toFixed(2),
        xg_fora: xgFora.toFixed(2), xga_fora: xgaFora.toFixed(2), strat: 'gol2t_xga'
      });
    } catch(e) { continue; }
  }
  return resultado;
}

async function calcularPctOver(teamId, leagueId, season, local) {
  try {
    const r = await apiFetch(`fixtures?team=${teamId}&season=${season}&league=${leagueId}&last=20`);
    const jogos = r?.response || [];
    const jogosLocal = jogos.filter(f => {
      const isHome = f.teams.home.id === teamId;
      return local === 'home' ? isHome : !isHome;
    });
    if (jogosLocal.length < 3) return null;
    const over15 = jogosLocal.filter(f => (f.goals.home + f.goals.away) > 1).length;
    const over25 = jogosLocal.filter(f => (f.goals.home + f.goals.away) > 2).length;
    return {
      total: jogosLocal.length,
      pct_over15: ((over15 / jogosLocal.length) * 100).toFixed(1),
      pct_over25: ((over25 / jogosLocal.length) * 100).toFixed(1)
    };
  } catch(e) { return null; }
}

async function buscarJogosFelipe15(data) {
  const resultado = [];
  const r = await apiFetch(`fixtures?date=${data}&timezone=America/Sao_Paulo`);
  const fixtures = r?.response || [];
  const ligasFiltradas = fixtures.filter(f => LIGAS_PERMITIDAS.has(f.league.id));
  for (const f of ligasFiltradas) {
    try {
      const fid = f.fixture.id;
      const homeId = f.teams.home.id;
      const awayId = f.teams.away.id;
      const season = 2025;
      const statsR = await apiFetch(`teams/statistics?team=${homeId}&season=${season}&league=${f.league.id}`);
      const stats = statsR?.response;
      if (!stats || !stats.goals?.for?.average?.home) continue;
      const mediaGolsCasa = parseFloat(stats.goals?.for?.average?.home || 0);
      const mediaGolsSofCasa = parseFloat(stats.goals?.against?.average?.home || 0);
      if (mediaGolsCasa < 1.2 || mediaGolsCasa > 6) continue;
      if (mediaGolsSofCasa < 1 || mediaGolsSofCasa > 5) continue;
      const statsAwayR = await apiFetch(`teams/statistics?team=${awayId}&season=${season}&league=${f.league.id}`);
      const statsAway = statsAwayR?.response;
      if (!statsAway) continue;
      const mediaGolsFora = parseFloat(statsAway.goals?.for?.average?.away || 0);
      const mediaGolsSofFora = parseFloat(statsAway.goals?.against?.average?.away || 0);
      if (mediaGolsFora < 1.1 || mediaGolsFora > 5) continue;
      if (mediaGolsSofFora < 1 || mediaGolsSofFora > 6) continue;
      const xgCasa = parseFloat(stats.goals?.for?.average?.home || 0);
      const xgFora = parseFloat(statsAway.goals?.for?.average?.away || 0);
      const xgTotal = xgCasa + xgFora;
      if (xgCasa < 1.2 || xgFora < 1.0 || xgTotal < 2.26) continue;
      const pctCasa = await calcularPctOver(homeId, f.league.id, season, 'home');
      const pctFora = await calcularPctOver(awayId, f.league.id, season, 'away');
      if (pctCasa && (parseFloat(pctCasa.pct_over15) < 70 || parseFloat(pctCasa.pct_over25) < 40)) continue;
      if (pctFora && (parseFloat(pctFora.pct_over15) < 66.67 || parseFloat(pctFora.pct_over25) < 35.71)) continue;
      const oddsRF = await apiFetch(`odds?fixture=${fid}&bookmaker=2`);
      const betsF = oddsRF?.response?.[0]?.bookmakers?.[0]?.bets || [];
      const h2hF = betsF.find(b => b.name === 'Match Winner');
      const oddCasaF = parseFloat(h2hF?.values?.find(v=>v.value==='Home')?.odd || 0);
      const xgaCasa = parseFloat(stats.goals?.against?.average?.home || 0);
      const xgaFora = parseFloat(statsAway.goals?.against?.average?.away || 0);
      resultado.push({
        fixture_id: fid, hora: f.fixture.date?.slice(11,16) || '',
        liga: f.league.name, home: f.teams.home.name, away: f.teams.away.name,
        home_id: homeId, away_id: awayId, league_id: f.league.id,
        odd_casa: oddCasaF ? oddCasaF.toFixed(2) : null,
        xg_casa: xgCasa.toFixed(2), xg_fora: xgFora.toFixed(2), xg_total: xgTotal.toFixed(2),
        xga_casa: xgaCasa.toFixed(2), xga_fora: xgaFora.toFixed(2),
        media_gols_casa: mediaGolsCasa.toFixed(2), media_gols_fora: mediaGolsFora.toFixed(2),
        media_sof_casa: mediaGolsSofCasa.toFixed(2), media_sof_fora: mediaGolsSofFora.toFixed(2),
        pct_over15_casa: pctCasa?.pct_over15 || null, pct_over25_casa: pctCasa?.pct_over25 || null,
        pct_over15_fora: pctFora?.pct_over15 || null, pct_over25_fora: pctFora?.pct_over25 || null,
        partidas_casa: pctCasa?.total || null, partidas_fora: pctFora?.total || null,
        strat: 'felipe15'
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
  console.log('✅ BUG FUSO HORÁRIO CORRIGIDO — jogoEmAndamento usa timestamp puro');
  console.log('✅ Intervalo: 2 minutos');
  limparPendentesAntigos();
  setInterval(monitorar, 2 * 60 * 1000);
  sendTelegram('🚀 FUTATS v2 reiniciado!\n✅ Bug de fuso horário corrigido\n✅ 2 min entre ciclos');
});
