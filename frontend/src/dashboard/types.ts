export type Workspace = { id: string; name: string }
export type Campaign = { id: string; name: string; status: string; lead_list_id: string; sender_id?: string | null; scheduled_at?: number | null; created_at: number }
export type CampaignStats = { sent: number; queued: number; failed: number; delivered: number; opened: number; clicked: number; replied: number; bounced: number }
export type Sender = { id: string; type: string; address: string; display_name: string; is_default: number; created_at: number }
export type Snippet = { id: string; title: string; body: string; created_at: number }
export type Suppression = { id: string; email: string; reason: string; created_at: number }
export type OnboardingState = { senderConnected: boolean; leadsAdded: boolean; campaignCreated: boolean; testSent: boolean; launched: boolean }
export type ActivityItem = { id: string; type: string; message: string; created_at: number }
export type Notification = { id: string; message: string; created_at: number; read_at: number | null }

export type DailyPoint = { date: number; sent: number; opened: number; replied: number; bounced: number }

export type WorkspaceAnalytics = {
  windowDays: number
  windowLabel: string
  sent: number
  delivered: number
  opened: number
  clicked: number
  replied: number
  bounced: number
  openRate: number | null
  replyRate: number | null
  bounceRate: number | null
  trends: { sent: number | null; openRate: number | null; replyRate: number | null; bounceRate: number | null }
  series: DailyPoint[] | null
}

export type AnalyticsOverviewData = {
  analytics: WorkspaceAnalytics
  campaigns: Campaign[]
  campaignStats: Record<string, CampaignStats>
  senders: Sender[]
  suppressionCount: number
  onboarding: OnboardingState | null
  activity: ActivityItem[]
  notifications: Notification[]
}

export type EmailBlockBase = { id: string }
export type HeadingBlock = EmailBlockBase & { type: 'heading'; text: string; size: 'small' | 'medium' | 'large'; color: string; align: 'left' | 'center' | 'right' }
export type TextBlock = EmailBlockBase & { type: 'text'; text: string; size: number; color: string; align: 'left' | 'center' | 'right' }
export type ImageBlock = EmailBlockBase & { type: 'image'; src: string; fileId?: string | null; alt: string; width: number; align: 'left' | 'center' | 'right' }
export type ButtonBlock = EmailBlockBase & { type: 'button'; label: string; url: string; background: string; color: string; align: 'left' | 'center' | 'right' }
export type DividerBlock = EmailBlockBase & { type: 'divider'; color: string }
export type SpacerBlock = EmailBlockBase & { type: 'spacer'; height: number }
export type EmailBlock = HeadingBlock | TextBlock | ImageBlock | ButtonBlock | DividerBlock | SpacerBlock

export type EmailTemplate = {
  id: string
  name: string
  subject: string
  blocks: EmailBlock[]
  html: string
  text: string
  created_at: number
  updated_at: number
}

export type EmailTemplateDraft = { id?: string | null; name: string; subject: string; blocks: EmailBlock[]; html: string; text: string }

export type SampleLead = { first_name: string; company: string }

export type WarmupState = { senderId: string; senderEmail: string; status: 'not_started' | 'ramping' | 'paused' | 'complete'; startedAt: number | null; currentDailyCap: number; targetDailyCap: number; rampStep: number }

export type TeamMember = { userId: string; email: string; role: string; created_at: number }
export type TeamInvite = { id: string; email: string; role: string; expires_at: number | null }

export type DnsCheck = { record: 'SPF' | 'DKIM' | 'DMARC'; status: 'pass' | 'fail' | 'unknown'; detail: string; expected?: string | null }
export type DnsGuidance = { title: string; body: string }
export type DnsResult = { domain: string; senderEmail: string; checks: DnsCheck[]; guidance: DnsGuidance[] }

export type WorkflowConditionType = 'reply_contains' | 'reply_any' | 'no_reply_after_days'
export type WorkflowCondition = { type: WorkflowConditionType; value?: string | number }
export type WorkflowAction =
  | { type: 'move_to_list'; listId: string }
  | { type: 'send_email'; templateId: string }
  | { type: 'change_status'; status: string }
  | { type: 'follow_up_step'; stepNo: number }
  | { type: 'stop' }
  | { type: 'notify' }
export type WorkflowRule = { id: string; condition: WorkflowCondition; actions: WorkflowAction[] }
export type Workflow = { id: string; name: string; is_active: boolean; rules: WorkflowRule[]; created_at: number; updated_at: number }

export type AbTestVariant = { id: string; label: 'A' | 'B'; subject: string; body_template: string; body_html?: string | null }
export type AbTest = { id: string; campaign_id: string; campaign_name: string; name: string; status: string; split_percent: number; winner_variant_id: string | null; created_at: number }
export type AbTestDetail = AbTest & { variants: AbTestVariant[] }
export type AbTestVariantStats = { id: string; label: 'A' | 'B'; sent: number; opened: number; replied: number; openRate: number | null; replyRate: number | null }
export type AbTestStats = { variants: AbTestVariantStats[] }
