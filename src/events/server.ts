/**
 * Express-приёмник исходящих вебхуков (событий) Битрикс24.
 * Ключевое правило: СНАЧАЛА отвечаем 200, ПОТОМ обрабатываем — Битрикс не делает
 * повторную доставку, а медленный ответ понижает приоритет и вводит паузы.
 * Токен application_token сверяем в constant-time уже ПОСЛЕ ответа 200.
 */
import express from 'express'
import type { Express, Request, Response } from 'express'
import { timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { log } from '../logger.js'
import type { DurableQueue } from '../queue.js'
import type { B24EventPayload } from './handlers.js'

function tokenMatches(received: string | undefined): boolean {
  const expected = config.appToken
  if (!expected) {
    // Токен не настроен — принимаем, но громко предупреждаем (только для dev).
    log.warn('webhook.token_not_configured')
    return true
  }
  if (!received) return false
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function createServer(queue: DurableQueue): Express {
  const app = express()
  app.use(express.urlencoded({ extended: true })) // события идут form-urlencoded
  app.use(express.json())

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', queue: queue.stats(), ts: new Date().toISOString() })
  })

  app.post('/webhook', (req: Request, res: Response) => {
    // 1) Мгновенный ответ 200 — до любой обработки.
    res.status(200).send('OK')
    // 2) Обработка после ответа: проверка токена + постановка в очередь.
    setImmediate(() => {
      try {
        const payload = req.body as B24EventPayload
        if (!tokenMatches(payload?.auth?.application_token)) {
          log.warn('webhook.token_mismatch_drop')
          return
        }
        const event = (payload?.event ?? 'UNKNOWN').toString()
        const job = queue.enqueue(event, payload)
        log.info('webhook.enqueued', { jobId: job.id, event })
      } catch (err) {
        log.error('webhook.handler_error', { err: String(err) })
      }
    })
  })

  return app
}
