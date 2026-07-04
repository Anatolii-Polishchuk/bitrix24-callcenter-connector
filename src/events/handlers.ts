/**
 * Обработчики событий Битрикс24. Событие несёт только идентификаторы —
 * детали подтягиваем через *.get. Если обработчик бросит ошибку, очередь
 * повторит задачу (с backoff), поэтому обработчики должны быть идемпотентны.
 */
import type { Job } from '../queue.js'
import { getLead, getDeal } from '../crm.js'
import { log } from '../logger.js'

export interface B24EventPayload {
  event?: string
  data?: {
    FIELDS?: { ID?: string | number } & Record<string, unknown>
  } & Record<string, unknown>
  ts?: string
  auth?: {
    application_token?: string
    domain?: string
    member_id?: string
  } & Record<string, unknown>
}

function extractId(payload: B24EventPayload): number | null {
  const raw = payload?.data?.FIELDS?.ID
  const id = Number(raw)
  return Number.isFinite(id) && id > 0 ? id : null
}

export async function handleEvent(job: Job): Promise<void> {
  const payload = job.payload as B24EventPayload
  const event = (payload?.event ?? job.type ?? 'UNKNOWN').toUpperCase()
  const l = log.child({ jobId: job.id, event })

  switch (event) {
    case 'ONCRMLEADADD':
    case 'ONCRMLEADUPDATE': {
      const id = extractId(payload)
      if (id === null) {
        l.warn('event.no_id')
        return
      }
      const lead = await getLead(id)
      l.info('event.lead', { id, title: lead?.TITLE })
      // TODO: бизнес-логика — маршрутизация лида, уведомление оператора и т.п.
      return
    }
    case 'ONCRMDEALADD':
    case 'ONCRMDEALUPDATE': {
      const id = extractId(payload)
      if (id === null) {
        l.warn('event.no_id')
        return
      }
      const deal = await getDeal(id)
      l.info('event.deal', { id, title: deal?.TITLE })
      return
    }
    case 'ONVOXIMPLANTCALLSTART':
    case 'ONVOXIMPLANTCALLEND':
    case 'ONEXTERNALCALLSTART':
    case 'ONEXTERNALCALLBACKSTART': {
      l.info('event.telephony', { data: payload?.data })
      // TODO: связать звонок с CRM, зарегистрировать/финализировать через telephony.*
      return
    }
    default:
      l.info('event.unhandled')
  }
}
