/**
 * Фабрика клиента Битрикс24 (B24Hook) + тонкие типизированные помощники поверх
 * официального SDK actions.v2. Устойчивость (rate-limit, ретраи 503/429,
 * hard/soft-коды) обеспечивает встроенный RestrictionManager SDK — свои
 * HTTP-обёртки НЕ пишем. Сверх SDK добавляем:
 *   - идемпотентность записей (callWrite);
 *   - ретрай сетевых ошибок только для чтений (callRead).
 */
import { B24Hook, ParamsFactory } from '@bitrix24/b24jssdk'
import type { RestrictionParams, TypeCallParams, BatchCommandsArrayUniversal } from '@bitrix24/b24jssdk'
import { config } from './config.js'
import { log } from './logger.js'
import { sleep, backoffDelay } from './util.js'
import { isNetworkError } from './errors.js'
import { idem } from './idempotency.js'

export type CallParams = Record<string, unknown>

let hookPromise: Promise<B24Hook> | null = null

async function initHook(): Promise<B24Hook> {
  const base: RestrictionParams =
    config.tariff === 'enterprise' ? ParamsFactory.getEnterprise() : ParamsFactory.getDefault()

  const hook = B24Hook.fromWebhookUrl(config.b24Hook)
  hook.offClientSideWarning()

  await hook.setRestrictionManagerParams({
    ...base,
    maxRetries: config.maxRetries,
    retryDelay: config.retryDelayMs,
    // Записи (*.add/*.update/файлы) НЕ ретраим на сетевых ошибках — иначе дубли.
    // Чтения ретраим сами в callRead (повтор безопасен).
    retryOnNetworkError: false,
    // Пример бизнес-кода, который надо бросать сразу (расширь под себя):
    hardErrorCodes: ['MY_APP_BAD_PAYLOAD'],
  })

  log.info('b24.hook.init', { tariff: config.tariff, maxRetries: config.maxRetries })
  return hook
}

/** Ленивая инициализация синглтона хука. */
export function getB24(): Promise<B24Hook> {
  if (!hookPromise) hookPromise = initHook()
  return hookPromise
}

/** Корректно закрыть клиент (вызывать при завершении процесса). */
export async function destroyB24(): Promise<void> {
  if (!hookPromise) return
  const hook = await hookPromise
  hook.destroy()
  hookPromise = null
  log.info('b24.hook.destroyed')
}

/**
 * Идемпотентное ЧТЕНИЕ одного метода. SDK держит rate-limit и ретраит 503/429.
 * Сетевые ошибки ретраим здесь (для чтения повтор безопасен).
 */
export async function callRead<T = unknown>(
  method: string,
  params: CallParams = {},
  requestId?: string,
): Promise<T> {
  const maxNet = config.readNetworkRetries
  for (let attempt = 0; ; attempt++) {
    try {
      const b24 = await getB24()
      const res = await b24.actions.v2.call.make<T>({
        method,
        params: params as unknown as TypeCallParams,
        requestId,
      })
      if (!res.isSuccess) throw new Error(`${method}: ${res.getErrorMessages().join('; ')}`)
      const data = res.getData()
      if (data === undefined) throw new Error(`${method}: пустой ответ`)
      return data.result
    } catch (err) {
      if (isNetworkError(err) && attempt < maxNet) {
        const delay = backoffDelay(attempt, config.retryDelayMs)
        log.warn('b24.read.network_retry', { method, attempt, delay })
        await sleep(delay)
        continue
      }
      throw err
    }
  }
}

/**
 * ЗАПИСЬ (*.add/*.update/register). Не ретраится на сетевых ошибках.
 *  - idempotencyKey: стабильный ключ операции → дубли невозможны при повторах;
 *  - reconcile: при сетевой неопределённости проверяет, создалась ли сущность.
 */
export async function callWrite<T = unknown>(
  method: string,
  params: CallParams,
  opts: {
    idempotencyKey?: string
    reconcile?: () => Promise<T | null>
    requestId?: string
  } = {},
): Promise<T> {
  const { idempotencyKey, reconcile, requestId } = opts

  if (idempotencyKey) {
    const cached = await idem.get<T>(idempotencyKey)
    if (cached !== undefined) {
      log.info('b24.write.idem_hit', { method, idempotencyKey })
      return cached
    }
  }

  try {
    const b24 = await getB24()
    const res = await b24.actions.v2.call.make<T>({
      method,
      params: params as unknown as TypeCallParams,
      requestId,
    })
    if (!res.isSuccess) throw new Error(`${method}: ${res.getErrorMessages().join('; ')}`)
    const data = res.getData()
    if (data === undefined) throw new Error(`${method}: пустой ответ`)
    const result = data.result
    if (idempotencyKey) await idem.set(idempotencyKey, result)
    return result
  } catch (err) {
    // Сетевая неопределённость: возможно, сервер всё-таки создал сущность.
    if (isNetworkError(err) && reconcile) {
      log.warn('b24.write.network_uncertain', { method, idempotencyKey, err: String(err) })
      const found = await reconcile()
      if (found !== null && found !== undefined) {
        if (idempotencyKey) await idem.set(idempotencyKey, found)
        log.info('b24.write.reconciled', { method, idempotencyKey })
        return found
      }
    }
    throw err
  }
}

/** Пакетный вызов до 50 методов за 1 хит (для группировки чтений/записей). */
export async function batch<T = unknown>(
  calls: Array<[string, CallParams]>,
  opts: { haltOnError?: boolean; requestId?: string } = {},
): Promise<T[]> {
  const b24 = await getB24()
  const res = await b24.actions.v2.batch.make<T>({
    calls: calls as unknown as BatchCommandsArrayUniversal,
    options: { isHaltOnError: opts.haltOnError ?? false, requestId: opts.requestId },
  })
  if (!res.isSuccess) throw new Error(`batch: ${res.getErrorMessages().join('; ')}`)
  return (res.getData() ?? []) as T[]
}

/**
 * Потоковое чтение больших списков (huge-data, алгоритм start=-1).
 * SDK сам ведёт курсор по ID — не используем start=start+50.
 */
export async function* fetchList<T = Record<string, unknown>>(
  method: string,
  params: Omit<CallParams, 'start' | 'order'> = {},
  opts: { idKey?: string; cursorIdKey?: string; customKeyForResult?: string; requestId?: string } = {},
): AsyncGenerator<T[]> {
  const b24 = await getB24()
  const gen = b24.actions.v2.fetchList.make<T>({
    method,
    params: params as unknown as TypeCallParams,
    idKey: opts.idKey,
    cursorIdKey: opts.cursorIdKey,
    customKeyForResult: opts.customKeyForResult,
    requestId: opts.requestId,
  })
  for await (const chunk of gen) yield chunk
}

/** Собрать весь список в память (для небольших объёмов). */
export async function fetchAll<T = Record<string, unknown>>(
  method: string,
  params: Omit<CallParams, 'start' | 'order'> = {},
  opts: { idKey?: string; cursorIdKey?: string; customKeyForResult?: string; requestId?: string } = {},
): Promise<T[]> {
  const out: T[] = []
  for await (const chunk of fetchList<T>(method, params, opts)) out.push(...chunk)
  return out
}
