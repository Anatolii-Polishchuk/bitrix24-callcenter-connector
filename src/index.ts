/**
 * Точка входа: поднимает durable-очередь, воркер обработки событий и
 * Express-приёмник вебхуков. Корректно завершается по SIGINT/SIGTERM.
 */
import { createServer } from './events/server.js'
import { handleEvent } from './events/handlers.js'
import { DurableQueue } from './queue.js'
import { destroyB24 } from './b24.js'
import { config } from './config.js'
import { log } from './logger.js'

async function main(): Promise<void> {
  const queue = new DurableQueue()
  queue.recover()
  queue.start(handleEvent)

  const app = createServer(queue)
  const server = app.listen(config.port, () => {
    log.info('server.listening', { port: config.port })
  })

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('server.shutdown', { signal })
    server.close()
    await queue.drain(15_000)
    await destroyB24()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

void main().catch((err) => {
  log.error('fatal', { err: String(err) })
  process.exit(1)
})
