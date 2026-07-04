# bitrix24-callcenter-connector

Устойчивая серверная интеграция колл-центра с **Битрикс24** через входящий
вебхук. Спроектирована так, чтобы **не отваливаться**: держит лимиты REST,
переживает всплески звонков, корректно обрабатывает ошибки и **не теряет
входящие события**.

Построено на официальном SDK [`@bitrix24/b24jssdk`](https://github.com/bitrix24/b24jssdk)
(v2), Node.js 20+/TypeScript, `express`, запуск через `tsx`.

---

## Почему интеграция не отваливается

| Механизм | Где | Что делает |
|----------|-----|------------|
| **RestrictionManager SDK** | [src/b24.ts](src/b24.ts) | Встроенные лимитеры (leaky bucket, operating-time, adaptive delay) держат интенсивность; авто-ретраи `QUERY_LIMIT_EXCEEDED` (503) и `OPERATION_TIME_LIMIT` (429). Настраивается через `setRestrictionManagerParams` + `ParamsFactory`. |
| **Идемпотентные записи** | [src/b24.ts](src/b24.ts), [src/idempotency.ts](src/idempotency.ts) | `*.add`/`register` защищены ключом идемпотентности + reconcile при сетевой неопределённости → **без дублей**. `retryOnNetworkError: false` для записей. |
| **Ретрай чтений** | [src/b24.ts](src/b24.ts) | Сетевые ошибки на идемпотентных чтениях ретраятся с экспоненциальным backoff. |
| **200-first приёмник** | [src/events/server.ts](src/events/server.ts) | На `POST /webhook` отвечаем 200 **до** обработки — Битрикс не делает повторную доставку, а медленный ответ штрафуется паузами. |
| **Durable-очередь (WAL)** | [src/queue.ts](src/queue.ts) | Каждое событие синхронно пишется в `events.wal.jsonl` до ack; воркеры разбирают с ограниченной параллельностью; ретраи с backoff; dead-letter; `recover()` восстанавливает необработанное после перезапуска. |
| **Huge-data пагинация** | [src/b24.ts](src/b24.ts) | `fetchList`/`fetchAll` используют алгоритм `start=-1` (курсор по ID), а не `start+=50`. |

---

## Структура

```
src/
  config.ts        — конфиг из ENV/.env (секрет только здесь)
  logger.ts        — JSON-логгер
  util.ts          — sleep + backoff
  errors.ts        — классификация ошибок (сетевые/auth) поверх SdkError
  idempotency.ts   — устойчивое key→value хранилище (JSONL) против дублей
  b24.ts           — фабрика B24Hook + callRead/callWrite/batch/fetchList
  crm.ts           — лиды/сделки (идемпотентно)
  telephony.ts     — регистрация/финализация внешних звонков
  queue.ts         — durable-очередь событий на WAL
  events/
    server.ts      — Express: POST /webhook (200-first), GET /health
    handlers.ts    — диспетчер событий (событие → *.get → бизнес-логика)
  index.ts         — точка входа: очередь + воркер + сервер + graceful shutdown
smoke.ts           — smoke-тест user.current
loadtest.ts        — 10k событий на /webhook
```

---

## Быстрый старт

```bash
pnpm install
cp .env.example .env      # впиши B24_HOOK и B24_APPLICATION_TOKEN
pnpm typecheck            # проверка типов
pnpm smoke                # вызвать user.current и напечатать пользователя
pnpm dev                  # поднять приёмник событий (watch)
```

### Переменные окружения

Смотри [.env.example](.env.example). Ключевые:

- `B24_HOOK` — полный URL входящего вебхука:
  `https://<portal>.bitrix24.ru/rest/<userId>/<secret>/`
- `B24_APPLICATION_TOKEN` — токен, который Битрикс шлёт в теле события; сверяется
  в constant-time, несовпадение → событие молча дропается.
- `PORT`, `B24_TARIFF` (`default`|`enterprise`), `QUEUE_CONCURRENCY` и др.

---

## Настройка в портале Битрикс24

1. **Входящий вебхук** (для наших вызовов REST):
   *Разработчикам → Другое → Входящий вебхук*. Выдай **минимальные** права:
   `crm`, `telephony`, `user`, при необходимости `im`. Скопируй URL в `B24_HOOK`.
2. **Обработчик событий** (исходящие вебхуки Битрикс → наш сервер):
   *Разработчикам → Другое → Обработчик событий* (или через `event.bind`).
   URL обработчика: `https://<your-server>/webhook`. Задай `application_token`
   и продублируй его в `B24_APPLICATION_TOKEN`.
3. Проброс наружу для локальной разработки — любым туннелем (например `cloudflared`
   или `ngrok`) на `http://localhost:3000`.

События приходят как `application/x-www-form-urlencoded`; `data[FIELDS][ID]`
парсится в `payload.data.FIELDS.ID` (включён `express.urlencoded`).

---

## Проверка готовности

**Smoke:**
```bash
B24_HOOK="https://portal.bitrix24.ru/rest/1/xxxx/" pnpm smoke
# → OK: user.current → #1 Иван Иванов ivan@example.com
```

**Нагрузка (не теряем события):** в одном терминале `pnpm dev`, в другом:
```bash
LOADTEST_N=10000 pnpm loadtest
# обработчик отвечает 200 мгновенно; проверь .data/events.done.log — 10000 строк,
# .data/events.dead.jsonl — пусто.
```

---

## Обработка ошибок (4 слоя)

- `SdkError` — ошибка программиста (неправильный вызов) → чинить код.
- `AjaxError` — REST вернул ошибку (`QUERY_LIMIT_EXCEEDED`, `OPERATION_TIME_LIMIT`,
  `INVALID_CREDENTIALS`, `EXPIRED_TOKEN`, `INSUFFICIENT_SCOPE`, `ERROR_NOT_FOUND`).
  Лимитные коды ретраит SDK; auth-коды — фатальны (см. [src/errors.ts](src/errors.ts)).
- **Сетевой** — `NETWORK_ERROR`/`REQUEST_TIMEOUT`: чтения ретраим, записи — нет
  (reconcile вместо ретрая, чтобы избежать дублей).
- **Soft** — коды из `softErrorCodes` приходят как `isSuccess:false` (не throw).

---

## Официальная документация (сверяй методы/поля)

- MCP-документация Битрикс24 (без авторизации, только доки):
  `claude mcp add --transport http b24-dev-mcp https://mcp-dev.bitrix24.tech/mcp`
- Лимиты: apidocs.bitrix24.ru/settings/performance/limits.html
- Входящая очередь: apidocs.bitrix24.ru/settings/performance/queue.html
- Большие объёмы (`start=-1`): apidocs.bitrix24.ru/settings/performance/huge-data.html
- Batch: apidocs.bitrix24.ru/settings/how-to-call-rest-api/batch.html
- SDK: github.com/bitrix24/b24jssdk • bitrix24.github.io/b24jssdk

> Имена методов телефонии (`telephony.externalcall.*`) и события звонков сверяй
> через MCP-доку — в [src/telephony.ts](src/telephony.ts) дан рабочий каркас.

---

## Масштабирование

Файловый WAL и JSONL-идемпотентность годятся для старта и одного инстанса.
Под нагрузку/несколько инстансов замените:
- очередь → Redis (`LPUSH`/`BRPOP`) или BullMQ/RabbitMQ/Kafka;
- идемпотентность → Redis/БД (интерфейс `get/set` тот же).
