/**
 * Телефония: регистрация/финализация внешних звонков и привязка к CRM.
 * ВНИМАНИЕ: точные имена методов и полей телефонии сверяй через MCP-документацию
 * Битрикс24 (b24-dev-mcp) и apidocs.bitrix24.ru — здесь дан рабочий каркас.
 */
import { callRead, callWrite } from './b24.js'
import { log } from './logger.js'

export interface RegisterCallInput {
  /** ID сотрудника Битрикс24, на которого регистрируется звонок. */
  userId: number
  /** Номер абонента. */
  phoneNumber: string
  /** 1 — исходящий, 2 — входящий (по умолчанию входящий). */
  type?: 1 | 2
  /** Номер линии (если несколько). */
  lineNumber?: string
  /** Создавать сущность CRM автоматически. */
  crmCreate?: boolean
  /** Дата начала звонка в формате Битрикс (ISO). */
  callStartDate?: string
  /** Наш стабильный uuid звонка — ключ идемпотентности. */
  idempotencyKey: string
}

export interface RegisteredCall {
  CALL_ID: string
  CRM_CREATED_LEAD?: string
  CRM_ENTITY_TYPE?: string
  CRM_ENTITY_ID?: string
  [k: string]: unknown
}

/** Зарегистрировать внешний звонок (telephony.externalcall.register). */
export async function registerCall(input: RegisterCallInput): Promise<RegisteredCall> {
  const params = {
    USER_ID: input.userId,
    PHONE_NUMBER: input.phoneNumber,
    TYPE: input.type ?? 2,
    CRM_CREATE: input.crmCreate ? 'Y' : 'N',
    SHOW: 'Y',
    ...(input.lineNumber ? { LINE_NUMBER: input.lineNumber } : {}),
    ...(input.callStartDate ? { CALL_START_DATE: input.callStartDate } : {}),
  }
  const call = await callWrite<RegisteredCall>('telephony.externalcall.register', params, {
    idempotencyKey: input.idempotencyKey,
    requestId: `tel-register-${input.idempotencyKey}`,
  })
  log.info('telephony.registered', { callId: call.CALL_ID, key: input.idempotencyKey })
  return call
}

export interface FinishCallInput {
  callId: string
  userId: number
  durationSec: number
  /** '200' — успешный звонок. */
  statusCode?: string
  failedReason?: string
  addToChat?: boolean
  cost?: number
  costCurrency?: string
}

/** Завершить внешний звонок (telephony.externalcall.finish). */
export async function finishCall(input: FinishCallInput): Promise<Record<string, unknown>> {
  const params = {
    CALL_ID: input.callId,
    USER_ID: input.userId,
    DURATION: input.durationSec,
    STATUS_CODE: input.statusCode ?? '200',
    ADD_TO_CHAT: input.addToChat ? 1 : 0,
    ...(input.failedReason ? { FAILED_REASON: input.failedReason } : {}),
    ...(input.cost !== undefined ? { COST: input.cost } : {}),
    ...(input.costCurrency ? { COST_CURRENCY: input.costCurrency } : {}),
  }
  return callWrite<Record<string, unknown>>('telephony.externalcall.finish', params, {
    idempotencyKey: `finish-${input.callId}`,
    requestId: `tel-finish-${input.callId}`,
  })
}

/** Прикрепить запись разговора (telephony.externalCall.attachRecord). */
export async function attachRecord(
  callId: string,
  recordUrl: string,
  fileName = 'record.mp3',
): Promise<unknown> {
  return callWrite(
    'telephony.externalCall.attachRecord',
    { CALL_ID: callId, FILENAME: fileName, RECORD_URL: recordUrl },
    { idempotencyKey: `record-${callId}`, requestId: `tel-record-${callId}` },
  )
}

/** Текущий пользователь вебхука (для smoke-теста). */
export async function currentUser(): Promise<{ ID: string; NAME?: string; LAST_NAME?: string }> {
  return callRead('user.current', {}, 'user-current')
}
