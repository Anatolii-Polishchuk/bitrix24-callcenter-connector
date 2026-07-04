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

export const config = {
  /** Полный URL входящего вебхука Битрикс24. */
  b24Hook: req('B24_HOOK'),
  /** application_token из тела события (для сверки входящих вебхуков). */
  appToken: (process.env.B24_APPLICATION_TOKEN ?? '').trim(),
  /** Порт Express-приёмника событий. */
  port: num('PORT', 3000),
  /** 'default' (2 req/s) | 'enterprise' (5 req/s). */
  tariff: (process.env.B24_TARIFF ?? 'default').trim().toLowerCase(),
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
} as const

export type AppConfig = typeof config
