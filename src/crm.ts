/**
 * CRM: создание/обновление лидов и сделок. Записи идемпотентны — служебный тег
 * idem:<key> кладём в COMMENTS и используем для сверки (reconcile) при сетевой
 * неопределённости, чтобы не плодить дубли.
 */
import { callRead, callWrite } from './b24.js'
import { log } from './logger.js'

export type Fields = Record<string, unknown>

function withIdemTag(fields: Fields, key: string): { fields: Fields; tag: string } {
  const tag = `idem:${key}`
  const prev = typeof fields.COMMENTS === 'string' ? fields.COMMENTS : ''
  return { fields: { ...fields, COMMENTS: [prev, tag].filter(Boolean).join('\n') }, tag }
}

async function findIdByCommentTag(method: string, tag: string): Promise<number | null> {
  const rows = await callRead<Array<{ ID: string }>>(method, {
    filter: { '%COMMENTS': tag },
    select: ['ID'],
    order: { ID: 'DESC' },
  })
  const first = rows[0]
  return first ? Number(first.ID) : null
}

/** Создать лид идемпотентно. Возвращает ID лида. */
export async function createLead(fields: Fields, idempotencyKey: string): Promise<number> {
  const { fields: merged, tag } = withIdemTag(fields, idempotencyKey)
  const id = await callWrite<number>(
    'crm.lead.add',
    { fields: merged, params: { REGISTER_SONET_EVENT: 'N' } },
    {
      idempotencyKey,
      requestId: `lead-add-${idempotencyKey}`,
      reconcile: () => findIdByCommentTag('crm.lead.list', tag),
    },
  )
  log.info('crm.lead.created', { id, idempotencyKey })
  return id
}

export async function getLead(id: number): Promise<Record<string, unknown> | null> {
  const res = await callRead<Record<string, unknown>>('crm.lead.get', { id }, `lead-get-${id}`)
  return res ?? null
}

export async function updateLead(id: number, fields: Fields): Promise<boolean> {
  return callWrite<boolean>('crm.lead.update', { id, fields }, { requestId: `lead-update-${id}` })
}

/** Создать сделку идемпотентно. Возвращает ID сделки. */
export async function createDeal(fields: Fields, idempotencyKey: string): Promise<number> {
  const { fields: merged, tag } = withIdemTag(fields, idempotencyKey)
  const id = await callWrite<number>(
    'crm.deal.add',
    { fields: merged, params: { REGISTER_SONET_EVENT: 'N' } },
    {
      idempotencyKey,
      requestId: `deal-add-${idempotencyKey}`,
      reconcile: () => findIdByCommentTag('crm.deal.list', tag),
    },
  )
  log.info('crm.deal.created', { id, idempotencyKey })
  return id
}

export async function getDeal(id: number): Promise<Record<string, unknown> | null> {
  const res = await callRead<Record<string, unknown>>('crm.deal.get', { id }, `deal-get-${id}`)
  return res ?? null
}
