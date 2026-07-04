/**
 * Устойчивое хранилище идемпотентности: append-only JSONL (key → value).
 * Защищает *.add/register от дублей при повторах/перезапусках.
 * Для нагрузки замените реализацию на Redis/БД — интерфейс (get/set) тот же.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'
import { log } from './logger.js'

const dir = config.queue.dataDir
const file = join(dir, 'idempotency.jsonl')
const mem = new Map<string, unknown>()
let loaded = false

function ensureLoaded(): void {
  if (loaded) return
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (existsSync(file)) {
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line) continue
      try {
        const rec = JSON.parse(line) as { k: string; v: unknown }
        mem.set(rec.k, rec.v)
      } catch {
        // повреждённая строка — пропускаем
      }
    }
  }
  loaded = true
  log.info('idem.loaded', { keys: mem.size })
}

export const idem = {
  async get<T>(key: string): Promise<T | undefined> {
    ensureLoaded()
    return mem.has(key) ? (mem.get(key) as T) : undefined
  },
  async set<T>(key: string, value: T): Promise<void> {
    ensureLoaded()
    mem.set(key, value)
    appendFileSync(file, JSON.stringify({ k: key, v: value, ts: new Date().toISOString() }) + '\n')
  },
}
