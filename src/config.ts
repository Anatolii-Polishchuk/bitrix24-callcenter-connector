/**
 * Конфигурация из окружения. Секрет вебхука — только здесь/в ENV, никогда в коде.
 * Поддерживает .env (минимальный парсер, без зависимости dotenv).
 */
import { existsSync, readFileSync } from 'node:fs'

function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    if (key in process.env) continue // реальный env имеет приоритет над .env
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    process.env[key] = val
  }
}
loadDotEnv()

function req(name: string): string {
  const v = process.env[name]
  if (!v || v.trim() === '') {
    throw new Error(`Не задана обязательная переменная окружения ${name}. Скопируй .env.example → .env`)
  }
  return v.trim()
}

function num(name: string, def: number): number {
  const v = process.env[name]
  if (v === undefined || v.trim() === '') return def
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`Переменная ${name} должна быть числом, получено "${v}"`)
  return n
}

const tariff = (process.env.B24_TARIFF ?? 'default').trim().toLowerCase()
const isEnterprise = tariff === 'enterprise'
const b24Hook = req('B24_HOOK')

export const config = {
  /** Полный URL входящего вебхука Битрикс24 (реальные креды живут только тут). */
  b24Hook,
  /** application_token из тела события (для сверки входящих вебхуков). */
  appToken: (process.env.B24_APPLICATION_TOKEN ?? '').trim(),
  /** Порт Express-приёмника событий/прокси. */
  port: num('PORT', 3000),
  /** 'default' (2 req/s) | 'enterprise' (5 req/s). */
  tariff,
  /** Ретраи временных ошибок REST (SDK). */
  maxRetries: num('B24_MAX_RETRIES', 3),
  retryDelayMs: num('B24_RETRY_DELAY_MS', 1000),
  /** Наши ретраи сетевых ошибок для ЧТЕНИЙ (записи не ретраим). */
  readNetworkRetries: num('B24_READ_NETWORK_RETRIES', 4),
  queue: {
    concurrency: num('QUEUE_CONCURRENCY', 4),
    dataDir: (process.env.QUEUE_DATA_DIR ?? '.data').trim(),
    maxAttempts: num('QUEUE_MAX_ATTEMPTS', 5),
  },
  /** Governed-прокси Битрикса для внешних приложений (например control-center). */
  proxy: {
    /** Bearer/path API-ключ синка (полная доля общего бакета). Пусто → выключен. */
    appApiKey: (process.env.APP_API_KEY ?? '').trim(),
    /** Отдельный ключ аналитики (тяжёлые full-pull) — под-лимит под общим бакетом. */
    analyticsKey: (process.env.PROXY_ANALYTICS_KEY ?? '').trim(),
    /** Под-лимит ключа аналитики (req/s), чтобы full-pull не душил синк. */
    analyticsRatePerSec: num('PROXY_ANALYTICS_RATE_PER_SEC', 1),
    /**
     * Апстрим-вебхук, КУДА прокси шлёт запросы. По умолчанию = B24_HOOK, но
     * приложение (control-center) использует свой вебхук с иными скоупами —
     * задай PROXY_B24_HOOK на его вебхук, чтобы права и поведение были 1:1.
     */
    upstreamHook: (process.env.PROXY_B24_HOOK ?? '').trim() || b24Hook,
    /** Leaky-bucket под лимиты Битрикса: refill/сек и ёмкость всплеска. */
    ratePerSec: num('PROXY_RATE_PER_SEC', isEnterprise ? 5 : 2),
    burst: num('PROXY_BURST', isEnterprise ? 250 : 50),
    /** Ретраи на 503/429/OVERLOAD (запрос отвергнут — повтор безопасен). */
    maxRetries: num('PROXY_MAX_RETRIES', 6),
    retryBaseMs: num('PROXY_RETRY_BASE_MS', 1000),
    /** Короткий TTL-кэш идемпотентных *.list/*.get (мс). 0 — выключить. */
    cacheTtlMs: num('PROXY_CACHE_TTL_MS', 15_000),
    /** Таймаут одного апстрим-запроса к Битриксу (мс). Тяжёлый deal.list. */
    upstreamTimeoutMs: num('PROXY_UPSTREAM_TIMEOUT_MS', 120_000),
    /** Максимальный размер тела запроса. */
    maxBodySize: (process.env.PROXY_MAX_BODY_SIZE ?? '4mb').trim(),
  },
} as const

export type AppConfig = typeof config
