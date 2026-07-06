# FUTATS Pré-Live — Análise Automática

Esse serviço roda separado do seu `server.js` principal (não mexe nele). Ele:

1. Puxa a lista de jogos da Futats 4x por dia (07:30, 12:00, 18:30, 00:00)
2. Filtra automaticamente os jogos com Seleção IA / Filtros personalizados / Estratégias preenchidos
3. 50 minutos antes do kickoff de cada jogo qualificado, gera a análise completa (via API do Claude) e manda pro seu Telegram — pessoal e canal
4. Tem uma página web simples onde você vê TODOS os jogos do dia e pode pedir a análise de qualquer um manualmente, a qualquer hora
5. Nunca repete análise do mesmo jogo

---

## Passo 1 — Instalar (uma vez só, no Railway)

1. Baixe essa pasta inteira (`futats-prelive`)
2. Suba ela como um **novo serviço** dentro do seu projeto Railway (separado do server.js atual), ou como uma pasta nova dentro do mesmo repositório GitHub, num projeto Railway separado apontando pra essa pasta
3. No GitHub: `Add file` → `Upload files` → arraste todos os arquivos mantendo a estrutura de pastas (`src/`, `data/` pode ficar vazia, ela se cria sozinha)

## Passo 2 — Configurar as variáveis no Railway

Vá em **Settings > Variables** do novo serviço e adicione, uma por uma:

| Nome | Valor |
|---|---|
| `ANTHROPIC_API_KEY` | a chave que você gerou no console.anthropic.com |
| `TELEGRAM_BOT_TOKEN` | o token do bot que vocês já usam |
| `TELEGRAM_CHAT_ID_PESSOAL` | seu chat id pessoal (já usado hoje) |
| `TELEGRAM_CHAT_ID_CANAL` | id do canal Gonza bot |
| `FUTATS_PRE_URL` | `https://gz.futats.com/opta/api-games-pre` |
| `FUTATS_TOKEN` | o token x-token que vocês já usam |
| `WEB_PASSWORD` | uma senha à sua escolha, pra proteger a página web |

(veja também o arquivo `.env.example` com todos os nomes certinhos)

## Passo 3 — Rodar

O Railway detecta o `package.json` e roda `npm start` sozinho. Depois de subir, ele te dá uma URL tipo `https://futats-prelive-production.up.railway.app`.

## Passo 4 — Usar a página web

Acesse: `https://SUA-URL-AQUI/?senha=SUASENHA`

Você vai ver a lista de jogos do dia, com hora, liga, odds, e o campo de Seleção IA. Cada linha tem um botão **"Analisar e mandar pro Telegram"** — clique em qualquer jogo, a qualquer hora, e a análise completa chega no seu Telegram em alguns minutos (é o tempo que a IA leva pra buscar notícias e montar a análise).

Tem também um link **"🔄 Puxar jogos novos agora"** no topo, caso você queira forçar uma atualização da lista sem esperar os horários automáticos.

## ⚠️ Pontos de atenção (revisar depois de rodar de verdade)

1. **Fuso horário**: o campo `hora` que vem da Futats — preciso confirmar se já vem no horário de Brasília ou em UTC, pra garantir que o "50 minutos antes" dispara na hora certa. Isso está marcado com um comentário no arquivo `scheduler.js`.
2. **Nome dos campos de filtro**: hoje sei que existe `selecao_ia`. Os campos de "Filtros personalizados" e "Estratégias/bolinhas" podem ter outro nome no JSON — ajustar em `filters.js` assim que vermos um pull real.
3. **Conferência automática de resultado** (pra manter a calibração tipo fizemos manualmente) ainda não está neste pacote — é o próximo passo, depois de validarmos que a análise e o envio estão funcionando direito.

## Testando sem gastar muito

Antes de deixar rodando geral, edite `src/filters.js` e coloque 1-2 ligas na lista `LIGAS_PERMITIDAS`, tipo:
```js
const LIGAS_PERMITIDAS = ['Norwegian 1st Division'];
```
Assim só esses jogos entram na fila automática, e você testa em escala pequena antes de abrir geral.
