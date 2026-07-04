/** Минималистичный structured-логгер (JSON-строки), без внешних зависимостей. */

type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = ORDER[(process.env.LOG_LEVEL as Level | undefined) ?? 'info'] ?? ORDER.info

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return
  const record = { ts: new Date().toISOString(), level, msg, ...(meta ?? {}) }
  const line = JSON.stringify(record, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  if (level === 'warn' || level === 'error') process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): Logger
}

function make(bindings: Record<string, unknown>): Logger {
  const merge = (extra?: Record<string, unknown>): Record<string, unknown> => ({ ...bindings, ...(extra ?? {}) })
  return {
    debug: (msg, extra) => emit('debug', msg, merge(extra)),
    info: (msg, extra) => emit('info', msg, merge(extra)),
    warn: (msg, extra) => emit('warn', msg, merge(extra)),
    error: (msg, extra) => emit('error', msg, merge(extra)),
    child: (extra) => make(merge(extra)),
  }
}

export const log = make({})
