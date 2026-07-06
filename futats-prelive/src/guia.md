# FUTATS — GUIA DE ANÁLISE PRÉ-LIVE
*Referência rápida para novo chat — atualizado 01/07/2026*

---

## FAVORITO
Sempre = **menor odd**. Nunca assumir mandante automaticamente.

---

## SISTEMA DE PONTOS
- Mandante: 1pt por vitória própria em casa (últimos 5)
- Visitante: 1pt por vitória própria fora + 1pt por derrota do mandante em casa
- Derrotas do visitante = **derrotas PRÓPRIAS dele nos últimos 5 fora** (não inverter)
- Empate = 0pts
- **Mínimo 5pts** para validar favoritismo
- Jogo neutro (Copa) = usar só como contexto

---

## FAIXAS DE EG
| xG | Faixa |
|---|---|
| 0–0.50 | EG0 |
| 0.51–1.50 | EG1 |
| 1.51–2.50 | EG2 |
| 2.51–3.50 | EG3 |
| 3.51+ | EG4 |

⚠️ **Conferir decimais antes de atribuir** — 1.534 = EG2, não EG1.

---

## CRUZAMENTO DE xG
- EG_defesa **<** EG_ataque → defesa PREVALECE, suprime ataque para a faixa da defesa
- EG_defesa **≥** EG_ataque → não suprime, ataque mantém liberdade mínima na sua faixa
- Cruzar sempre nos **dois sentidos** independentemente

---

## CORTES DOS OVERS
| Linha | Corte |
|---|---|
| Over 0.5 | ≥100% |
| Over 1.5 | ≥75% |
| Over 2.5 | ≥55% |
| Over 3.5 | ≥43% |
| Over 0.5 HT | ≥75% |
| Ambas Marcam | ≥60% |

Combinado = média simples entre mandante e visitante.

---

## OVER 0,5 GONZA 🟢
Dispara quando G.Mandante **ou** G.Visitante está em **1° lugar** com **≥20%**.

---

## CHECAGEM TOP5 — ZEBRA
- Unders = 0x0, 1x0, 0x1
- **2+ unders no top5 = alerta de zebra** ("favorito pode não converter")
- Checar SEMPRE antes de fechar

---

## TOP 3 PLACARES
- Obrigatório em toda análise
- Construído com análise própria (não copiar da API)
- Referência ao vivo
- **Nunca sobrepor com Lay Improvável**

---

## LAY IMPROVÁVEL
1. Definir conclusão geral do jogo
2. Rankear placares pela contrariedade à conclusão
3. Checar histórico mandante casa / visitante fora (não H2H)
4. Descartar placares ocorridos recentemente na amostra
5. Tiebreak = menor probabilidade entre igualmente contrários
6. Não forçar 3 picks se só há 1–2 válidos
7. **G.Visitante = vitória visitante por 4+ gols** (não qualquer vitória)
8. **G.Mandante = vitória mandante por 4+ gols**
9. **Avaliar pelo FT apenas** (não HT)
10. Copa do Mundo = focar em placares favoráveis ao underdog

---

## NOTÍCIA + H2H
- Buscar sempre via web search antes de fechar
- H2H desta temporada tem peso qualitativo forte
- Desfalques = aviso textual (não mudam régua numérica)
- H2H qualitativo forte contradizendo números → reportar e ponderar caso a caso

---

## CONFIANÇA
🎯 Favorito | ⚽ Gols | 🔒 Placar/Lay

🎯 **FAVORITO — régua rígida (fixada 04/07):** os 4 critérios abaixo têm que bater **TODOS SIMULTANEAMENTE** pra fechar 🟢 Alta. Nunca usar xG/Custo Gol/notícia forte pra "salvar" a nota quando um critério não bate.
1. Sistema de pontos bate o mínimo de 5 (lado favorecido)
2. Diferença de xG entre os ataques ≥1.0
3. % (vitórias/derrotas) excelentes (vitórias ≥75% ou derrotas ≤25%) — estrito, não "quase"
4. Notícia/H2H não contradiz o favoritismo

- 🟢 Alta = os 4 batem juntos
- 🟡 Média = 1+ critério não bate, mas SEM discordância direta entre eles (pontos não bate mínimo mas tudo aponta mesma direção; ou pontos empatam; ou H2H diverge parcialmente sem reverter)
- 🔴 Baixa = **conflito direto** entre critérios sobre **quem vence** (pontos apontam um lado e xG aponta outro; tabela/retrospecto real do azarão contradiz a odd; diff de xG é negativa pro favorito nominal). Contexto (tabela geral, H2H, notícia) NUNCA reverte esse veredito pra cima — só serve de nota lateral.
- Calibração validada (63 jogos, 03-04/07): 🟢 Alta ~76%, 🟡 Média ~53%, 🔴 Baixa ~44%

⚽ **Gols:**
- 🟢 Alta = Overs e Ambas Marcam batem os cortes + Over HT confirma + xG total alto
- 🟡 Média = só parte bate, ou Over HT diverge do xG total
- 🔴 Baixa = maioria dos cortes não bate, ou H2H mostra padrão de under, ou zebra alert disparado

🔒 **Placar (Lay):**
- 🟢 Alta = nunca ocorreu no histórico geral E H2H não invalida
- 🟡 Média = nunca ocorreu mas é categoria ampla (goleada) ou amostra pequena
- 🔴 Baixa = já ocorreu recentemente

**Formato de saída obrigatório (Favorito sempre com motivo entre parênteses):**
```
🎯 Confiança no FAVORITO: 🟢 Alta (motivo breve: ex. "pontos batem + diff xG forte + %s excelentes + notícia confirma")
⚽ Confiança em GOLS: 🟡 Média
🔒 Confiança no PLACAR (Lay [placar]): 🟢 Alta
```

---

## ERROS A EVITAR
1. Faixas de EG — conferir decimais (1.534 = EG2)
2. Favorito pela odd, nunca pelo mandante
3. Pontos visitante = derrotas PRÓPRIAS dele fora
4. Top 3 e Lay nunca se sobrepõem
5. Unders no top5 — 1x0, 0x1, 0x0 são todos unders
6. Lay = FT, não HT
7. G.Visitante/G.Mandante = 4+ gols

---

## DATASET
- Jogos fechados: **135+** (72 + 63 nos dias 03-04/07)
- 🔒 Lay Improvável: ~93-96%
- 🎯 Favorito: 🟢 Alta ~76%, 🟡 Média ~53%, 🔴 Baixa ~44%
- Meta 1: 100 jogos ✅ | Meta 2: 200 jogos

---

## BOLINHAS DO CARD
- 🤖 Seleção IA
- ⚪ Lay Away Manu
- 🔵 Favorito HT Gonza
- 🟠 Felipe Over 1.5
- 🟤 Ambas Marcam xG
- 🟢 Over 0,5 Gonza
- 🟣 Lay xg
- 🟡 Gol no Final (puxado da API)
