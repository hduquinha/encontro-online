# Prompt para IA — Integração do Dashboard com Dados de Presença do Encontro Online

Cole este prompt na IA do projeto do dashboard para ela entender como consumir os dados.

---

## PROMPT (copie abaixo):

```
Preciso integrar dados de presença de um sistema externo chamado "Encontro Online" no meu dashboard.

O sistema do Encontro Online já salva automaticamente no banco de dados PostgreSQL (Aiven) todas as informações de quem assistiu à aula online (tempo assistido, % do vídeo, foco, sessões, etc). Os dados são gravados em tempo real enquanto o aluno assiste.

Os dados ficam no MESMO banco PostgreSQL do Aiven que o dashboard usa:
- DATABASE_URL: (usar a variável de ambiente DATABASE_URL configurada no projeto)

As tabelas criadas pelo Encontro Online são:
- `online_users` — dados dos participantes (id, name, phone, registered_at)
- `online_watch_data` — dados de visualização (user_id, total_watched_seconds, percent_watched, completed, etc.)

O dashboard pode acessar esses dados de DUAS formas:
1. **Via API** (endpoint REST) — recomendado se o Encontro Online estiver em outro servidor
2. **Direto no banco** (SQL) — já que estão no MESMO banco PostgreSQL, o dashboard pode fazer SELECT direto nas tabelas `online_users` e `online_watch_data`

O dashboard do MEU projeto NÃO precisa salvar nada nas tabelas do Encontro Online — ele só LÊ.

### Endpoint:
GET /api/admin/attendance-report
Header: Authorization: Bearer <token_admin>

Para obter o token admin, faça login em:
POST /api/admin/login
Body: { "password": "senha_admin" }
Retorna: { "token": "..." }

### Estrutura da resposta do attendance-report:

O endpoint retorna 4 "tabelas" (arrays) + metadados:

```json
{
  "_meta": {
    "description": "Relatório de presença do Encontro Online",
    "linkField": "phone",    // <-- CAMPO CHAVE para associar com inscritos
    "tables": ["participants", "attendance", "engagement", "summary"]
  },

  "participants": [
    {
      "id": "uuid",
      "name": "Nome Completo",
      "phone": "11999998888",      // <-- CHAVE DE ASSOCIAÇÃO
      "registeredAt": "2026-03-10T20:07:36.285Z"
    }
  ],

  "attendance": [
    {
      "oderId": "uuid",
      "phone": "11999998888",       // <-- CHAVE DE ASSOCIAÇÃO
      "status": "concluido",        // valores: "concluido" | "assistindo" | "iniciou" | "nao_assistiu"
      "percentWatched": 95,         // porcentagem do vídeo assistida (0-100)
      "totalWatchedSeconds": 1140,  // tempo real assistido em segundos
      "completed": true,            // true se assistiu >=90%
      "firstAccessAt": "2026-03-10T20:07:36.285Z",
      "lastAccessAt": "2026-03-10T22:15:00.000Z"
    }
  ],

  "engagement": [
    {
      "oderId": "uuid",
      "phone": "11999998888",      // <-- CHAVE DE ASSOCIAÇÃO
      "sessions": 2,               // número de sessões de visualização
      "farthestPoint": 1050,       // ponto mais distante alcançado no vídeo (segundos)
      "duration": 1200,            // duração total do vídeo (segundos)
      "forwardSkips": 3,           // tentativas de pular pra frente (anti-fraude)
      "rewatchCount": 1,           // vezes que reassistiu
      "playbackSpeed": 1.5,        // velocidade de reprodução usada
      "focusPercent": 92,          // % de tempo com aba focada (detecta se saiu da aba)
      "segmentData": [0,1,2,3,...] // array de 100 segmentos - quantas vezes cada parte foi vista
    }
  ],

  "summary": {
    "totalRegistered": 150,        // total de cadastrados
    "totalWatched": 89,            // total que assistiram (>0 segundos)
    "totalCompleted": 45,          // total que concluíram (>=90%)
    "totalWatching": 30,           // total assistindo (entre 0-90%)
    "totalStarted": 5,             // total que só iniciaram
    "totalNotWatched": 61,         // total que não assistiram
    "avgPercentWatched": 72,       // média de % assistido
    "avgWatchTimeSeconds": 864,    // média de tempo assistido
    "avgFocusPercent": 88,         // média de foco
    "generatedAt": "2026-03-11T..."
  }
}
```

### COMO ASSOCIAR COM INSCRITOS:

O campo `phone` (telefone) é a CHAVE para associar os dados de presença com os inscritos do dashboard.

Para cada inscrito no dashboard que tem telefone, faça o match assim:
1. Limpe o telefone do inscrito (só dígitos, sem formatação)
2. Procure na tabela `attendance` um registro com o mesmo `phone`
3. Se encontrar, esse inscrito tem dados de presença

Exemplo de lógica:
```javascript
// inscritos = dados do seu dashboard
// attendanceReport = resposta do endpoint attendance-report

inscritos.forEach(inscrito => {
  const phoneClean = inscrito.telefone.replace(/\D/g, '');
  
  const presenca = attendanceReport.attendance.find(a => a.phone === phoneClean);
  const engajamento = attendanceReport.engagement.find(e => e.phone === phoneClean);
  const participante = attendanceReport.participants.find(p => p.phone === phoneClean);
  
  if (presenca) {
    inscrito.presencaOnline = {
      status: presenca.status,           // "concluido", "assistindo", "iniciou", "nao_assistiu"
      percentWatched: presenca.percentWatched,
      totalWatchedSeconds: presenca.totalWatchedSeconds,
      completed: presenca.completed,
      lastAccessAt: presenca.lastAccessAt
    };
  } else {
    inscrito.presencaOnline = {
      status: 'nao_cadastrado',  // não se cadastrou no encontro online
      percentWatched: 0,
      totalWatchedSeconds: 0,
      completed: false,
      lastAccessAt: null
    };
  }
  
  if (engajamento) {
    inscrito.engajamentoOnline = {
      sessions: engajamento.sessions,
      focusPercent: engajamento.focusPercent,
      forwardSkips: engajamento.forwardSkips,
      playbackSpeed: engajamento.playbackSpeed
    };
  }
});
```

### O QUE CRIAR NO DASHBOARD:

1. **Nova coluna na tabela de inscritos**: "Presença Online" com status colorido:
   - 🟢 Concluído (>=90%)
   - 🟡 Assistindo (entre 0-90%)
   - 🔵 Iniciou (abriu mas quase não assistiu)
   - 🔴 Não assistiu
   - ⚪ Não cadastrado (não entrou no encontro online)

2. **Card de estatísticas**: mostrar o `summary` (total que assistiram, completaram, etc.)

3. **Filtro**: permitir filtrar inscritos por status de presença online

4. **Coluna de % assistido**: mostrar percentWatched ao lado do status

5. **Coluna de engajamento**: focoPercent e forwardSkips (indica se prestou atenção)

### STATUS POSSÍVEIS:
- `concluido` → Assistiu 90% ou mais do vídeo
- `assistindo` → Assistiu uma parte (>0% e <90%)
- `iniciou` → Teve tempo de visualização mas % = 0 (abriu e fechou)
- `nao_assistiu` → Se cadastrou mas não assistiu nada
- `nao_cadastrado` → Não existe no sistema do encontro online (usar quando o phone do inscrito não bate com nenhum participant)

### URL BASE DO ENCONTRO ONLINE:
Configure a URL base do servidor do Encontro Online no config do dashboard.
Em desenvolvimento local: http://localhost:5175
Em produção: a URL do deploy (ex: https://encontro-online.vercel.app)

### OPÇÃO 2 — ACESSO DIRETO VIA SQL (recomendado, mesmo banco):

Como os dados estão no MESMO banco PostgreSQL do Aiven, o dashboard pode consultar diretamente:

```sql
-- Buscar todos os participantes do encontro online com dados de presença
SELECT 
  u.id,
  u.name,
  u.phone,
  u.registered_at,
  COALESCE(w.total_watched_seconds, 0) as total_watched_seconds,
  COALESCE(w.percent_watched, 0) as percent_watched,
  COALESCE(w.completed, false) as completed,
  w.last_watched_at,
  COALESCE(w.sessions, 0) as sessions,
  COALESCE(w.farthest_point, 0) as farthest_point,
  COALESCE(w.forward_skips, 0) as forward_skips,
  COALESCE(w.rewatch_count, 0) as rewatch_count,
  COALESCE(w.playback_speed, 1) as playback_speed,
  COALESCE(w.focus_percent, 100) as focus_percent,
  CASE
    WHEN w.completed = true OR COALESCE(w.percent_watched, 0) >= 90 THEN 'concluido'
    WHEN COALESCE(w.percent_watched, 0) > 0 THEN 'assistindo'
    WHEN COALESCE(w.total_watched_seconds, 0) > 0 THEN 'iniciou'
    ELSE 'nao_assistiu'
  END as status_presenca
FROM online_users u
LEFT JOIN online_watch_data w ON w.user_id = u.id
ORDER BY u.registered_at DESC;

-- Associar com inscritos do dashboard pelo telefone
SELECT 
  i.*,
  ou.name as nome_encontro,
  COALESCE(ow.percent_watched, 0) as percent_watched,
  COALESCE(ow.completed, false) as completed_encontro,
  COALESCE(ow.total_watched_seconds, 0) as watch_seconds,
  CASE
    WHEN ow.completed = true OR COALESCE(ow.percent_watched, 0) >= 90 THEN 'concluido'
    WHEN COALESCE(ow.percent_watched, 0) > 0 THEN 'assistindo'
    WHEN COALESCE(ow.total_watched_seconds, 0) > 0 THEN 'iniciou'
    WHEN ou.id IS NOT NULL THEN 'nao_assistiu'
    ELSE 'nao_cadastrado'
  END as status_presenca_online
FROM inscritos i
LEFT JOIN online_users ou ON REGEXP_REPLACE(i.telefone, '[^0-9]', '', 'g') = ou.phone
LEFT JOIN online_watch_data ow ON ow.user_id = ou.id;
```

A chave de associação é `phone` (telefone limpo, só dígitos).
Ajuste o nome da tabela `inscritos` e o campo `i.telefone` para os nomes reais da sua tabela de inscritos no dashboard.
```

---

## Resumo técnico

| Tabela PostgreSQL | Descrição | Chave |
|-------------------|-----------|-------|
| `online_users` | Nome, telefone, data de cadastro | `phone` |
| `online_watch_data` | Tempo assistido, %, completou, foco, skips, velocidade, segmentos | `user_id` → `online_users.id` |

| Tabela na API (JSON) | Descrição | Chave |
|----------------------|-----------|-------|
| `participants` | Nome, telefone, data de cadastro | `phone` |
| `attendance` | Status de presença, % assistido, tempo, datas | `phone` |
| `engagement` | Sessões, foco, skips, velocidade, segmentos | `phone` |
| `summary` | Totais e médias gerais | — |

**Banco**: PostgreSQL (Aiven) — `defaultdb`
**Chave de associação entre sistemas**: campo `phone` (telefone limpo, só dígitos)
**Acesso direto**: o dashboard pode fazer JOIN entre suas tabelas e `online_users`/`online_watch_data` pelo telefone
