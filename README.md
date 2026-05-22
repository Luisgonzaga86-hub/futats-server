# FUTATS Server

Monitor 24h de jogos com alertas via Telegram.

## Variáveis de ambiente no Railway:
- `API_FOOTBALL_KEY` — sua key da API-Football
- `TG_TOKEN` — token do bot Telegram
- `TG_CHAT_ID` — seu chat ID do Telegram
- `PORT` — porta (Railway define automaticamente)

## Como funciona:
- A cada 2 minutos verifica os jogos pendentes
- Envia alertas no Telegram quando as condições forem atendidas
- Sincroniza dados entre PC e iPhone via API
