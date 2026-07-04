/**
 * Transparent governed-прокси Битрикс24.
 *
 * Приложение (например control-center sync-воркер) меняет только BITRIX_WEBHOOK_URL
 * на  http://b24-connector:3000/px/<APP_API_KEY>/  и продолжает звать методы как
 * раньше (crm.deal.list и т.п.). Прокси:
 *   - держит реальные вебхук-креды у себя (в env), приложение их не видит;
 *   - единый token-bucket (2/50 или 5/250) — сериализует и ограничивает интенсивность;
 *   - backoff-ретраи на 503 QUERY_LIMIT_EXCEEDED / 429 OPERATION_TIME_LIMIT / OVERLOAD_LIMIT
 *     (запрос отвергнут сервером и НЕ применён → повтор безопасен даже для записей);
 *   - single-flight: одинаковые одновременные *.list/*.get склеиваются в один апстрим;
 *   - короткий TTL-кэш идемпотентных чтений;
 *   - отдаёт ответ Битрикса один-в-один (result/total/next/time), поэтому пагинация
 *     и парсинг на стороне приложения не меняются.
 */
import express from 'express'
import type { Router, Request, Response } from 'express'
import { timingSafeEqual, createHash } from 'node:crypto'
import { config } from './config.js'
import { log } from './logger.js'
import { TokenBucket } from './rateLimiter.js'
import { sleep, backoffDelay } from './util.js'

const bucket = new TokenBucket(config.proxy.ratePerSec, config.proxy.burst)

/** Идемпотентные методы — можно кэшировать, дедуплицировать и ретраить по сети. */
const IDEMPOTENT = /\.(list|get|fields|stages|statistic\.get)$/i

interface UpstreamResult {
  status: number
  contentType: string
  body: Buffer
}
interface CacheEntry extends UpstreamResult {
  expires: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<UpstreamResult>>()

// Периодическая чистка протухших записей кэша.
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of cache) if (v.expires <= now) cache.delete(k)
}, 60_000).unref()

function keyMatches(received: string): boolean {
  const expected = config.proxy.appApiKey
  if (!expected) return false
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function cacheKey(method: string, query: string, body: Buffer): string {
  return createHash('sha1')
    .update(method)
    .update('\0')
    .update(query)
    .update('\0')
    .update(body)
    .digest('hex')
}

/** Решение о ретрае по ответу Битрикса (лимитные коды — безопасно повторить). */
function retryDecision(status: number, bodyText: string): { retry: boolean; waitMs: number; code?: string } {
  if (status === 429 || /OPERATION_TIME_LIMIT/.test(bodyText)) {
    let waitMs = 0
    try {
      const reset = (JSON.parse(bodyText) as { time?: { operating_reset_at?: number } })?.time?.operating_reset_at
      if (reset) waitMs = Math.max(0, reset * 1000 - Date.now())
    } catch {
      // тело не JSON — используем backoff
    }
    return { retry: true, waitMs, code: 'OPERATION_TIME_LIMIT' }
  }
  if (/OVERLOAD_LIMIT/.test(bodyText)) return { retry: true, waitMs: 5_000, code: 'OVERLOAD_LIMIT' }
  if (status === 503 || /QUERY_LIMIT_EXCEEDED/.test(bodyText)) {
    return { retry: true, waitMs: 0, code: 'QUERY_LIMIT_EXCEEDED' }
  }
  return { retry: false, waitMs: 0 }
}

async function forwardOnce(
  method: string,
  query: string,
  httpMethod: string,
  contentType: string,
  body: Buffer,
): Promise<UpstreamResult> {
  const target = `${config.b24Hook}${method}.json${query ? `?${query}` : ''}`
  const bodyless = httpMethod === 'GET' || httpMethod === 'HEAD'
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), config.proxy.upstreamTimeoutMs)
  try {
    const resp = await fetch(target, {
      method: httpMethod,
      headers: bodyless ? {} : { 'content-type': contentType },
      body: bodyless ? undefined : body,
      signal: ac.signal,
    })
    const buf = Buffer.from(await resp.arrayBuffer())
    return {
      status: resp.status,
      contentType: resp.headers.get('content-type') ?? 'application/json',
      body: buf,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function governedForward(
  method: string,
  query: string,
  httpMethod: string,
  contentType: string,
  body: Buffer,
): Promise<UpstreamResult> {
  const idempotent = IDEMPOTENT.test(method)
  const maxRetries = config.proxy.maxRetries
  for (let attempt = 0; ; attempt++) {
    await bucket.acquire()
    try {
      const res = await forwardOnce(method, query, httpMethod, contentType, body)
      const decision = retryDecision(res.status, res.body.toString('utf8'))
      if (decision.retry && attempt < maxRetries) {
        const delay = decision.waitMs > 0 ? decision.waitMs : backoffDelay(attempt, config.proxy.retryBaseMs)
        log.warn('proxy.retry', { method, attempt, code: decision.code, status: res.status, delay })
        await sleep(delay)
        continue
      }
      return res
    } catch (err) {
      // Сетевая ошибка/таймаут: ретраим только идемпотентные (для записей — небезопасно).
      if (idempotent && attempt < maxRetries) {
        const delay = backoffDelay(attempt, config.proxy.retryBaseMs)
        log.warn('proxy.network_retry', { method, attempt, err: String(err), delay })
        await sleep(delay)
        continue
      }
      throw err
    }
  }
}

export function createProxyRouter(): Router {
  const router = express.Router()
  // Сырое тело (любой content-type) — прокидываем в Битрикс как есть.
  router.use(express.raw({ type: () => true, limit: config.proxy.maxBodySize }))

  router.all('/:key/:method', async (req: Request, res: Response) => {
    if (!keyMatches(req.params.key ?? '')) {
      log.warn('proxy.unauthorized')
      res.status(401).json({ error: 'UNAUTHORIZED', error_description: 'invalid api key' })
      return
    }

    const method = (req.params.method ?? '').replace(/\.json$/i, '')
    if (!method) {
      res.status(400).json({ error: 'BAD_METHOD' })
      return
    }
    const query = req.originalUrl.split('?')[1] ?? ''
    const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    const contentType = req.headers['content-type'] ?? 'application/x-www-form-urlencoded'
    const idempotent = IDEMPOTENT.test(method)

    try {
      if (idempotent) {
        const ck = cacheKey(method, query, body)
        const hit = cache.get(ck)
        if (hit && hit.expires > Date.now()) {
          res.set('content-type', hit.contentType)
          res.set('x-b24proxy', 'cache-hit')
          res.status(hit.status).send(hit.body)
          return
        }
        // single-flight: склеиваем одинаковые одновременные запросы
        let p = inflight.get(ck)
        const coalesced = Boolean(p)
        if (!p) {
          p = governedForward(method, query, req.method, contentType, body)
          inflight.set(ck, p)
          void p.finally(() => inflight.delete(ck))
        }
        const r = await p
        if (r.status === 200 && config.proxy.cacheTtlMs > 0) {
          cache.set(ck, { ...r, expires: Date.now() + config.proxy.cacheTtlMs })
        }
        res.set('content-type', r.contentType)
        res.set('x-b24proxy', coalesced ? 'coalesced' : 'miss')
        res.status(r.status).send(r.body)
        return
      }

      // Не-идемпотентные (записи): без кэша и дедупа.
      const r = await governedForward(method, query, req.method, contentType, body)
      res.set('content-type', r.contentType)
      res.set('x-b24proxy', 'write')
      res.status(r.status).send(r.body)
    } catch (err) {
      log.error('proxy.error', { method, err: String(err) })
      res.status(502).json({ error: 'PROXY_UPSTREAM_ERROR', error_description: String(err) })
    }
  })

  return router
}

export function proxyStats(): { bucket: { tokens: number; capacity: number }; cache: number; inflight: number } {
  return { bucket: bucket.stats(), cache: cache.size, inflight: inflight.size }
}
