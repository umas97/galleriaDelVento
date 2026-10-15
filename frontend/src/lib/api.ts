// galleriaDelVento -- real-time 2D wind tunnel for sections, sketches and profiles
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The one place that talks to the server. Errors carry the server's `detail`,
// an Italian sentence written for a person: the interface shows it as it is,
// because only the server knows *which* file was wrong. `technical` goes behind
// the collapsible "Dettagli" (SPEC §15).
import { t } from '../i18n/it'
import type {
  CasePlan,
  CaseSetup,
  CheckResult,
  DrawingInfo,
  ImportResult,
  ModelRecord,
  ModelUpdate,
  Profile2D,
  ProfileDraft,
  ProfileEnvelope,
  ProfileSummary,
  StudyTypePreset,
} from './types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly technical: string = '',
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export type WindowInfo = {
  mode: 'app' | 'tab' | 'webview' | 'none'
  note?: string | null
  can_quit: boolean
}

type ErrorBody = { detail?: unknown; technical?: string }

function errorFrom(status: number, statusText: string, body: ErrorBody | null): ApiError {
  const detail = typeof body?.detail === 'string' ? body.detail : statusText || t('error.generic')
  return new ApiError(status, detail, body?.technical ?? '')
}

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  let response: Response
  try {
    response = await fetch(path, { ...init, headers })
  } catch {
    throw new ApiError(0, t('error.network'))
  }
  if (!response.ok) {
    let body: ErrorBody | null = null
    try {
      body = (await response.json()) as ErrorBody
    } catch {
      // not JSON: keep the status text
    }
    throw errorFrom(response.status, response.statusText, body)
  }
  return response
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await send(path, init)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export async function requestBuffer(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  return (await send(path, { signal })).arrayBuffer()
}

/** Upload raw bytes with progress (fetch cannot report upload progress). */
export function uploadBytes<T>(
  path: string,
  body: Blob,
  onProgress?: (fraction: number) => void,
  method = 'POST',
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(method, path)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.responseType = 'json'
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total)
    }
    xhr.onerror = () => reject(new ApiError(0, t('error.network')))
    xhr.onload = () => {
      const body = xhr.response as ErrorBody | T | null
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T)
      else reject(errorFrom(xhr.status, xhr.statusText, body as ErrorBody | null))
    }
    xhr.send(body)
  })
}

const json = (value: unknown) => JSON.stringify(value)

export const api = {
  health: () => request<{ status: string; app: string; version: string }>('/api/health'),
  window: () => request<WindowInfo>('/api/window'),
  quit: () => request<{ detail: string }>('/api/app/quit', { method: 'POST' }),
  log: (message: string, details = '', level: 'error' | 'warning' | 'info' = 'error') =>
    request<void>('/api/log', { method: 'POST', body: json({ message, details, level }) }),

  studyTypes: () => request<StudyTypePreset[]>('/api/study-types'),
  models: () => request<ModelRecord[]>('/api/models'),
  model: (id: string) => request<ModelRecord>(`/api/models/${id}`),
  updateModel: (id: string, change: ModelUpdate) =>
    request<ModelRecord>(`/api/models/${id}`, { method: 'PATCH', body: json(change) }),
  deleteModel: (id: string) =>
    request<{ freed_bytes: number }>(`/api/models/${id}`, { method: 'DELETE' }),
  importModel: (file: File, onProgress?: (f: number) => void) =>
    uploadBytes<ImportResult>(
      `/api/models/import?nome=${encodeURIComponent(file.name)}`,
      file,
      onProgress,
    ),
  meshUrl: (id: string, view: boolean) => `/api/models/${id}/${view ? 'vista' : 'mesh'}.bin`,
  thumbnailUrl: (id: string) => `/api/models/${id}/thumbnail.png`,
  putThumbnail: (id: string, png: Blob) =>
    uploadBytes<ModelRecord>(`/api/models/${id}/thumbnail`, png, undefined, 'PUT'),

  profiles: () => request<ProfileSummary[]>('/api/profiles'),
  profile: (id: string) => request<ProfileEnvelope>(`/api/profiles/${id}`),
  checkProfile: (draft: ProfileDraft, minArea = 0) =>
    request<CheckResult>(`/api/profiles/check?min_area=${minArea}`, { method: 'POST', body: json(draft) }),
  createProfile: (draft: ProfileDraft) =>
    request<Profile2D>('/api/profiles', { method: 'POST', body: json(draft) }),
  updateProfile: (id: string, draft: ProfileDraft) =>
    request<Profile2D>(`/api/profiles/${id}`, { method: 'PUT', body: json(draft) }),
  deleteProfile: (id: string) =>
    request<{ freed_bytes: number }>(`/api/profiles/${id}`, { method: 'DELETE' }),
  profileThumbnailUrl: (id: string) => `/api/profiles/${id}/thumbnail.png`,
  putProfileThumbnail: (id: string, png: Blob) =>
    uploadBytes<void>(`/api/profiles/${id}/thumbnail`, png, undefined, 'PUT'),
  exportProfile: (id: string, format: 'svg' | 'dxf') => download(`/api/profiles/${id}/export.${format}`),
  exportDraft: (draft: ProfileDraft, format: 'svg' | 'dxf') =>
    download(`/api/profiles/export.${format}`, { method: 'POST', body: json(draft) }),

  plan: (setup: CaseSetup, signal?: AbortSignal) =>
    request<CasePlan>('/api/cases/plan', { method: 'POST', body: json(setup), signal }),

  importDrawing: (file: File, onProgress?: (f: number) => void) =>
    uploadBytes<DrawingInfo>(`/api/drawings/import?nome=${encodeURIComponent(file.name)}`, file, onProgress),
  drawingDraft: (id: string, scale: number, name: string) =>
    request<CheckResult>(`/api/drawings/${id}/draft`, { method: 'POST', body: json({ scale, name }) }),
}

/**
 * Save a server download as a file through the browser (SPEC §2.1: exports never
 * write on the server side). The name comes from Content-Disposition.
 */
async function download(path: string, init: RequestInit = {}): Promise<void> {
  const response = await send(path, init)
  const header = response.headers.get('Content-Disposition') ?? ''
  const utf8 = /filename\*=UTF-8''([^;]+)/.exec(header)
  const plain = /filename="([^"]+)"/.exec(header)
  const name = utf8 ? decodeURIComponent(utf8[1]) : (plain?.[1] ?? 'profilo')
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Report an unexpected frontend error to the server log; never throws. */
export function reportError(message: string, details = ''): void {
  api.log(message, details).catch(() => undefined)
}
