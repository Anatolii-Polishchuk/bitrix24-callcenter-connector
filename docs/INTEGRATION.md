# Bitrix24 Integration — System Reference

Единая точка правды по всей интеграции: что развёрнуто, куда подключаться и как
пользоваться. Цель — «бах, подключил и работает». Реальные секреты **НЕ** в этом
файле (репозиторий публичный) — значения ключей/токенов лежат в `.env` на сервере
и в вашем секрет-хранилище; сюда подставлены плейсхолдеры.

---

## 1. Обзор

Один сервер **Hetzner `convo-prod` (78.47.252.169)**, всё в Docker, единый
**Caddy**-ингресс с авто-TLS. Всё обращается к Битрикс24 через **один здоровый
вебхук** `rest/53` (все нужные права), защищённый общим rate-limiter, чтобы
никогда не ловить `OVERLOAD_LIMIT`.

```
                        ┌──────────────────────────────────────────────┐
код-проекты / ETL ─────►│ b24.convoai.com.pl/px/<KEY>/    (REST-прокси)  │
ИИ-агенты ─────────────►│ mcp.convoai.com.pl/sse          (MCP, 12 tools)│──► Bitrix rest/53
события Битрикса ──────►│ b24.convoai.com.pl/webhook      (приёмник)     │    (все права)
control-center (синк) ─►│ (внутренне) http://b24-connector:3000/px/<KEY> │    общий лимит 2/50
                        └──────────────────────────────────────────────┘
                            всё → governed token-bucket (2 req/s, burst 50)
```

**Главное правило:** ничего не ходит в Битрикс мимо прокси. Прямые вызовы = снова
`OVERLOAD` (так были заблокированы старые вебхуки `rest/29`).

---

## 2. Точки подключения

| Что | URL | Auth | Для чего |
|-----|-----|------|----------|
| **REST-прокси** | `https://b24.convoai.com.pl/px/<KEY>/` | ключ в пути | Код тянет данные Битрикса (методы 1-в-1) |
| **REST-прокси (внутр.)** | `http://b24-connector:3000/px/<KEY>/` | ключ в пути | Для сервисов на сети `convo-prod_convo-net` |
| **MCP** | `https://mcp.convoai.com.pl/sse` | `Authorization: Bearer <MCP_TOKEN>` | ИИ-агент (12 инструментов) |
| **Приёмник событий** | `https://b24.convoai.com.pl/webhook` | `application_token` в теле | Исходящие вебхуки Битрикса |

### Ключи (значения — в секрет-хранилище / `.env` на сервере, НЕ в git)

| Ключ | Назначение | Лимит |
|------|-----------|-------|
| `<SYNC_KEY>` (`APP_API_KEY`) | control-center синк | полная доля общего бакета |
| `<ANALYTICS_KEY>` (`PROXY_ANALYTICS_KEY`) | выгрузки / аналитика | под-лимит ≤ 1 req/s |
| `<MCP_TOKEN>` (`MCP_BEARER_TOKEN`) | доступ к MCP | — |
| `<APP_TOKEN>` (`B24_APPLICATION_TOKEN`) | сверка входящих событий | — |

> Для **нового проекта** заведите отдельный ключ (свой rate-bucket + независимый
> отзыв/логи), не переиспользуя sync/analytics.

---

## 3. Использование

### A. REST-прокси (код / ETL) — основной способ выгрузки данных

`POST https://b24.convoai.com.pl/px/<KEY>/<method>.json` с параметрами Битрикса
(form-urlencoded или query). Ответ — **конверт Битрикса один-в-один**:
`{ result, total, next, time }` или `{ error, error_description }`.

```js
const BASE = process.env.BITRIX_BASE // https://b24.convoai.com.pl/px/<KEY>/

async function b24(method, params = {}) {
  const body = new URLSearchParams()
  const add = (k, v) =>
    Array.isArray(v) ? v.forEach((x, i) => add(`${k}[${i}]`, x))
    : v && typeof v === 'object' ? Object.entries(v).forEach(([a, b]) => add(`${k}[${a}]`, b))
    : body.append(k, v)
  for (const [k, v] of Object.entries(params)) add(k, v)
  const r = await fetch(BASE + method + '.json', { method: 'POST', body })
  return r.json()
}

// Выгрузить ВСЁ (huge-data алгоритм start=-1, НЕ start+=50)
async function fetchAll(method, params = {}, select = ['*']) {
  const out = []
  let lastId = 0
  for (;;) {
    const { result } = await b24(method, {
      ...params,
      order: { ID: 'ASC' },
      filter: { ...(params.filter || {}), '>ID': lastId },
      select,
      start: -1,
    })
    if (!result?.length) break
    out.push(...result)
    lastId = result.at(-1).ID
    if (result.length < 50) break
  }
  return out
}
```

**Полезные методы:**

| Данные | Метод | Заметки |
|--------|-------|---------|
| Сделки | `crm.deal.list` | `filter[STAGE_SEMANTIC_ID]` = `S` выиграно / `F` проиграно / `P` в работе |
| Лиды | `crm.lead.list` | |
| Контакты / компании | `crm.contact.list` / `crm.company.list` | |
| Звонки | `crm.activity.list` | `filter[TYPE_ID]=2` — телефонные активности |
| История стадий | `crm.stagehistory.list` | `entityTypeId` |
| Записи разговоров | `voximplant.statistic.get` | поле `CALL_RECORD_URL` |
| Пользователи / отделы | `user.get` / `department.get` | |
| Воронки | `crm.category.list` | `entityTypeId=2` |

Заголовки ответа прокси: `x-b24proxy-key` (лейбл ключа), `x-b24proxy` (`miss`/`cache-hit`/`coalesced`/`write`).

### B. MCP (ИИ-агент)

Транспорт SSE. `mcp.json` (Claude Code/Desktop) или любой MCP-клиент:

```json
{
  "mcpServers": {
    "bitrix": {
      "url": "https://mcp.convoai.com.pl/sse",
      "transport": "sse",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

12 инструментов: `bitrix_whoami`, `bitrix_crm_deal_list/get/add/update`,
`bitrix_crm_contact_list/get`, `bitrix_crm_company_list`, `bitrix_crm_lead_list`,
`bitrix_tasks_list`, `bitrix_call`, `bitrix_methods`.

### C. Приём событий Битрикса

Исходящий вебхук в портале → `POST /webhook` (form-urlencoded). Сервер отвечает
**200 сразу**, затем сверяет `auth.application_token` в constant-time и кладёт в
durable-очередь (WAL — события не теряются). Обработчики — в
[`src/events/handlers.ts`](../src/events/handlers.ts).

---

## 4. Зеркало данных (Postgres control-center)

control-center **зеркалит Битрикс в Postgres** (БД `cc`), синк каждые 5 мин через
прокси. **Для аналитики читайте зеркало, а не Битрикс** — быстро и без нагрузки.

| Таблица | Что |
|---------|-----|
| `BitrixDeal` | сделки (ключевые UF в колонках) |
| `BitrixActivity` | активности; звонки = `typeId='2'`, `responsibleId`, `startTime/endTime`, `completed` |
| `BitrixLead` / `BitrixContact` / `BitrixCompany` | лиды/контакты/компании |
| `BitrixUser` | пользователи (`internalUserId` → внутренний `User`) |
| `BitrixStageHistory` / `BitrixDealStage` | движение по воронкам |
| `BitrixSyncCursor` | свежесть/ошибки синка на сущность |

Записи разговоров (voximplant) в зеркале пока **нет** — только через прокси
(планируется таблица `BitrixCallStat`).

---

## 5. Governance — почему не отваливается

Единый token-bucket = **реальный лимит Битрикса** (2 req/s, burst 50; лимит
per-IP/портал, общий для всех токенов и ключей). Плюс:
- backoff-ретраи на `503 QUERY_LIMIT_EXCEEDED` / `429 OPERATION_TIME_LIMIT` / `OVERLOAD_LIMIT`;
- single-flight дедуп одинаковых одновременных `*.list/*.get`;
- короткий TTL-кэш идемпотентных чтений;
- per-key под-лимиты (аналитика ≤1/s), чтобы тяжёлый full-pull не душил синк.

Независимые «бакеты на ключ» **нельзя** — суммарно превысят лимит портала. Каждому
ключу — под-лимит под общим бакетом.

---

## 6. Что уже развёрнуто

- REST-прокси + приёмник событий: контейнер `b24-connector` (образ из этого репо).
- MCP: контейнер `bitrix-mcp` (отдельный репозиторий).
- control-center синк переведён на прокси; зеркало свежее.
- Дашборд **«Звонки по менеджерам»** — `/admin/sales-analytics` (из зеркала).

**Репозитории:**
- `github.com/Anatolii-Polishchuk/bitrix24-callcenter-connector` — прокси + приёмник событий (этот).
- `github.com/Anatolii-Polishchuk/bitrix-mcp` — MCP-сервер.

---

## 7. Безопасность

- Реальные креды Битрикса живут **только в прокси** (`B24_HOOK` в `.env` на сервере);
  проектам они не нужны — только их API-ключ прокси.
- **Никаких секретов в этом (публичном) репозитории.** Значения ключей — в `.env`
  на сервере и в секрет-хранилище.
- Ротация ключа: сменить значение в `.env` `b24-connector` (или в портале для
  вебхука) и пересобрать/перезапустить контейнер.
