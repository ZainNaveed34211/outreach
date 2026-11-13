import { clearAssertion, getAssertion } from '../lib/account'
import type { ActivityItem, AnalyticsOverviewData, Campaign, CampaignStats, DailyPoint, Notification, OnboardingState, Sender, Suppression, WorkspaceAnalytics } from './types'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'https://outreach-api.kluzar.com/v1'

export const DAILY_SEND_LIMIT = 50
export const SEND_INTERVAL_SECONDS = 60

type ApiResult<T> = { data?: T; error?: string }

export async function dashboardRequest<T>(
  path: string,
  options: RequestInit,
  csrfToken: string,
): Promise<{ response: Response; payload: ApiResult<T> }> {
  const attempt = async (): Promise<{ response: Response; payload: ApiResult<T> }> => {
    const assertion = csrfToken ? await getAssertion(csrfToken) : null
    if (!assertion) return { response: new Response(null, { status: 401 }), payload: {} }
    const headers = new Headers(options.headers)
    headers.set('Accept', 'application/json')
    if (typeof options.body === 'string') headers.set('Content-Type', 'application/json')
    headers.set('Authorization', `Bearer ${assertion}`)
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include', cache: 'no-store' })
    const payload = (await response.json().catch(() => ({}))) as ApiResult<T>
    return { response, payload }
  }
  const first = await attempt()
  if (first.response.status !== 401) return first
  clearAssertion()
  return attempt()
}

export async function fetchJson<T>(path: string, csrfToken: string, options: RequestInit = {}): Promise<T> {
  const { response, payload } = await dashboardRequest<T>(path, options, csrfToken)
  if (response.status === 401) throw new Error('Your session expired. Please sign in again.')
  if (!response.ok || payload.data === undefined) throw new Error(payload.error ?? 'The request could not be completed.')
  return payload.data
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return (numerator / denominator) * 100
}

function buildAnalytics(totals: CampaignStats, windowDays: number, windowLabel: string, series: DailyPoint[] | null, trends: WorkspaceAnalytics['trends']): WorkspaceAnalytics {
  const deliveredBase = totals.delivered > 0 ? totals.delivered : totals.sent
  return {
    windowDays,
    windowLabel,
    sent: totals.sent,
    delivered: totals.delivered,
    opened: totals.opened,
    clicked: totals.clicked,
    replied: totals.replied,
    bounced: totals.bounced,
    openRate: rate(totals.opened, deliveredBase),
    replyRate: rate(totals.replied, deliveredBase),
    bounceRate: rate(totals.bounced, totals.sent),
    trends,
    series,
  }
}

export async function fetchAnalyticsOverview(workspaceId: string, csrfToken: string): Promise<AnalyticsOverviewData> {
  const query = `workspaceId=${encodeURIComponent(workspaceId)}`
  const [campaigns, senders, suppressions, onboarding, activity, notifications] = await Promise.all([
    fetchJson<Campaign[]>(`/campaigns?${query}`, csrfToken),
    fetchJson<Sender[]>(`/senders?${query}`, csrfToken),
    fetchJson<Suppression[]>(`/suppressions?${query}`, csrfToken),
    fetchJson<OnboardingState>(`/onboarding?${query}`, csrfToken).catch(() => null),
    fetchJson<ActivityItem[]>(`/activity?${query}`, csrfToken).catch(() => [] as ActivityItem[]),
    fetchJson<Notification[]>(`/notifications?${query}`, csrfToken).catch(() => [] as Notification[]),
  ])
  const statsEntries = await Promise.all(
    campaigns.map(async (campaign) => {
      try {
        const stats = await fetchJson<CampaignStats>(`/stats/${encodeURIComponent(campaign.id)}?${query}`, csrfToken)
        return [campaign.id, stats] as const
      } catch {
        return [campaign.id, { sent: 0, queued: 0, failed: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0 }] as const
      }
    }),
  )
  const campaignStats: Record<string, CampaignStats> = {}
  const totals: CampaignStats = { sent: 0, queued: 0, failed: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0 }
  for (const [id, stats] of statsEntries) {
    campaignStats[id] = stats
    totals.sent += stats.sent
    totals.queued += stats.queued
    totals.failed += stats.failed
    totals.delivered += stats.delivered
    totals.opened += stats.opened
    totals.clicked += stats.clicked
    totals.replied += stats.replied
    totals.bounced += stats.bounced
  }
  const analyticsResponse = await dashboardRequest<WorkspaceAnalytics>(`/analytics?${query}&days=30`, {}, csrfToken).catch(() => null)
  if (analyticsResponse && analyticsResponse.response.ok && analyticsResponse.payload.data) {
    const analytics = analyticsResponse.payload.data
    return { analytics, campaigns, campaignStats, senders, suppressionCount: suppressions.length, onboarding, activity, notifications }
  }
  const analytics = buildAnalytics(totals, 0, 'All time', null, { sent: null, openRate: null, replyRate: null, bounceRate: null })
  return { analytics, campaigns, campaignStats, senders, suppressionCount: suppressions.length, onboarding, activity, notifications }
}

export type UploadedImage = { id: string; filename: string; sizeBytes: number; url: string }

export async function uploadTemplateImage(file: File, workspaceId: string, csrfToken: string): Promise<UploadedImage> {
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') throw new Error('Only PNG and JPEG images are accepted.')
  if (file.size < 1 || file.size > 10 * 1024 * 1024) throw new Error('Image must be smaller than 10 MB.')
  const upload = await fetchJson<{ uploadId: string; uploadUrl: string; headers: Record<string, string> }>('/files', csrfToken, {
    method: 'POST',
    body: JSON.stringify({ workspaceId, filename: file.name, sizeBytes: file.size, contentType: file.type }),
  })
  const uploadResponse = await fetch(upload.uploadUrl, {
    method: 'PUT',
    headers: upload.headers,
    body: file,
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  })
  if (!uploadResponse.ok) throw new Error('Image upload could not be completed.')
  const completed = await fetchJson<{ id: string; filename: string; sizeBytes: number }>(`/files/${encodeURIComponent(upload.uploadId)}`, csrfToken, { method: 'POST' })
  return { ...completed, url: `${API_BASE}/files/${encodeURIComponent(completed.id)}?workspaceId=${encodeURIComponent(workspaceId)}` }
}

export async function fetchImageBlob(fileId: string, workspaceId: string, csrfToken: string): Promise<Blob> {
  const attempt = async (): Promise<Response> => {
    const assertion = csrfToken ? await getAssertion(csrfToken) : null
    if (!assertion) return new Response(null, { status: 401 })
    return fetch(`${API_BASE}/files/${encodeURIComponent(fileId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
      headers: { Authorization: `Bearer ${assertion}` },
      credentials: 'include',
      cache: 'no-store',
    })
  }
  let response = await attempt()
  if (response.status === 401) {
    clearAssertion()
    response = await attempt()
  }
  if (!response.ok) throw new Error('Image could not be loaded.')
  return response.blob()
}

export function formatShortDate(at: number): string {
  return new Date(at * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}
