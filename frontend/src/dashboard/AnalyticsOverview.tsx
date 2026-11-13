import { DAILY_SEND_LIMIT, SEND_INTERVAL_SECONDS, formatNumber, formatShortDate } from './api'
import { BentoIcon } from './icons'
import { PerformanceChart } from './Chart'
import { OnboardingPanel } from './OnboardingPanel'
import type { AnalyticsOverviewData, Campaign, CampaignStats } from './types'

function formatPercent(value: number | null): string {
  if (value === null) return '—'
  return `${value.toFixed(1)}%`
}

function TrendChip({ change, invert, label }: { change: number | null; invert?: boolean; label: string }) {
  if (change === null) {
    return (
      <span className="bento-trend neutral" title="Previous-period comparison needs the workspace analytics endpoint.">
        —
      </span>
    )
  }
  const good = invert ? change <= 0 : change >= 0
  const arrow = change > 0 ? 'up' : change < 0 ? 'down' : 'up'
  const sign = change > 0 ? '+' : ''
  return (
    <span className={good ? 'bento-trend good' : 'bento-trend bad'} title={label}>
      <BentoIcon name={arrow} size={12} />
      {sign}
      {Math.abs(change).toFixed(1)}%
    </span>
  )
}

function statusBadge(status: string): { label: string; className: string } {
  if (status === 'active') return { label: 'Running', className: 'bento-badge running' }
  if (status === 'paused') return { label: 'Paused', className: 'bento-badge paused' }
  if (status === 'scheduled') return { label: 'Scheduled', className: 'bento-badge scheduled' }
  if (status === 'done') return { label: 'Done', className: 'bento-badge done' }
  if (status === 'archived') return { label: 'Archived', className: 'bento-badge archived' }
  return { label: 'Draft', className: 'bento-badge draft' }
}

function campaignRate(numerator: number, sent: number): string {
  if (sent <= 0) return '—'
  return `${((numerator / sent) * 100).toFixed(0)}%`
}

export function AnalyticsOverview({ data, lists, accountHref, onMarkNotificationsRead }: { data: AnalyticsOverviewData; lists: { id: string; name: string }[]; accountHref: string; onMarkNotificationsRead: () => void }) {
  const { analytics, campaigns, campaignStats, senders, suppressionCount, onboarding, activity, notifications } = data
  const visibleCampaigns = campaigns
    .filter((campaign) => ['active', 'paused', 'draft', 'scheduled'].includes(campaign.status))
    .slice(0, 8)
  const monitored = senders.filter((sender) => sender.type === 'gmail_oauth' || sender.type === 'outlook_oauth')
  const healthFraction = senders.length > 0 ? monitored.length / senders.length : 0
  const healthTitle = senders.length === 0 ? 'No sender connected' : monitored.length > 0 ? 'Ready to send' : 'Test mode only'
  const healthCopy =
    senders.length === 0
      ? 'Connect Gmail or Microsoft to send production campaigns. The Kluzar sender is for tests only.'
      : monitored.length > 0
        ? `${monitored.length} of ${senders.length} connected ${senders.length === 1 ? 'mailbox' : 'mailboxes'} ${monitored.length === 1 ? 'is' : 'are'} reply-monitored, so follow-ups stop on reply.`
        : 'Only the Kluzar test sender is connected. It cannot receive replies, so campaigns sent from it never stop on reply.'
  const ringCircumference = 264
  const ringOffset = ringCircumference * (1 - healthFraction)

  return (
    <div className="bento-page">
      <div className="bento-page-head">
        <div>
          <h1>Overview</h1>
          <p className="bento-page-sub">
            {analytics.windowLabel === 'All time' ? 'All-time totals · trends and the 30-day chart need the workspace analytics endpoint.' : `Last ${analytics.windowDays} days · compared with the previous ${analytics.windowDays} days.`}
          </p>
        </div>
        <a className="bento-btn-dark" href="/dashboard/campaigns/">
          <BentoIcon name="plus" size={16} />
          New Campaign
        </a>
      </div>

      {onboarding && <OnboardingPanel onboarding={onboarding} />}

      <div className="bento-metrics">
        <div className="bento-metric">
          <div className="bento-metric-label">Total Sent</div>
          <div className="bento-metric-row">
            <div className="bento-metric-value">{formatNumber(analytics.sent)}</div>
            <TrendChip change={analytics.trends.sent} label="Change in sends versus the previous period." />
          </div>
        </div>
        <div className="bento-metric">
          <div className="bento-metric-label">Open Rate</div>
          <div className="bento-metric-row">
            <div className="bento-metric-value">{formatPercent(analytics.openRate)}</div>
            <TrendChip change={analytics.trends.openRate} label="Change in open rate versus the previous period, in percentage points." />
          </div>
        </div>
        <div className="bento-metric">
          <div className="bento-metric-label">Reply Rate</div>
          <div className="bento-metric-row">
            <div className="bento-metric-value">{formatPercent(analytics.replyRate)}</div>
            <TrendChip change={analytics.trends.replyRate} label="Change in reply rate versus the previous period, in percentage points." />
          </div>
        </div>
        <div className="bento-metric">
          <div className="bento-metric-label">Bounce Rate</div>
          <div className="bento-metric-row">
            <div className="bento-metric-value">{formatPercent(analytics.bounceRate)}</div>
            <TrendChip change={analytics.trends.bounceRate} invert label="Change in bounce rate versus the previous period. A lower bounce rate is better." />
          </div>
        </div>
      </div>

      <div className="bento-panel bento-chart-panel">
        <div className="bento-panel-head">
          <h2>Performance (Last 30 days)</h2>
          <div className="bento-legend">
            <span><i className="bento-legend-swatch dark" /> Replies</span>
            <span><i className="bento-legend-swatch light" /> Sent</span>
          </div>
        </div>
        <PerformanceChart series={analytics.series} />
      </div>

      <div className="bento-split">
        <div className="bento-panel bento-table-panel">
          <div className="bento-panel-head">
            <h2>Active Campaigns</h2>
            <a className="bento-link" href="/dashboard/campaigns/">View all →</a>
          </div>
          {visibleCampaigns.length > 0 ? (
            <div className="bento-table-wrap">
              <table className="bento-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th className="num">Sent</th>
                    <th className="num">Opens</th>
                    <th className="num">Replies</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleCampaigns.map((campaign: Campaign) => {
                    const stats: CampaignStats | undefined = campaignStats[campaign.id]
                    const badge = statusBadge(campaign.status)
                    const listName = lists.find((list) => list.id === campaign.lead_list_id)?.name
                    return (
                      <tr key={campaign.id}>
                        <td>
                          <a className="bento-table-name" href="/dashboard/campaigns/">{campaign.name}</a>
                          {listName && <span className="bento-table-sub">{listName}</span>}
                        </td>
                        <td>
                          <span className={badge.className}>
                            {campaign.status === 'active' && <i className="bento-dot" />}
                            {badge.label}
                          </span>
                        </td>
                        <td className="num">{stats ? formatNumber(stats.sent) : '—'}</td>
                        <td className="num">{stats ? campaignRate(stats.opened, stats.sent) : '—'}</td>
                        <td className="num strong">{stats ? campaignRate(stats.replied, stats.sent) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="bento-empty">
              <p>No campaigns yet.</p>
              <p>Create a draft after connecting a mailbox and adding a lead list — then test it to your own email before launch.</p>
              <a className="bento-btn-outline" href="/dashboard/campaigns/">Go to campaigns</a>
            </div>
          )}
        </div>

        <div className="bento-panel bento-health-panel">
          <div className="bento-panel-head">
            <h2>Domain Health</h2>
            <BentoIcon name="check" size={20} className={monitored.length > 0 ? 'bento-health-icon ok' : 'bento-health-icon'} />
          </div>
          <div className="bento-health-body">
            <div className="bento-ring">
              <svg viewBox="0 0 100 100" aria-hidden="true">
                <circle cx="50" cy="50" r="42" fill="transparent" stroke="#f4f4f5" strokeWidth="8" />
                <circle cx="50" cy="50" r="42" fill="transparent" stroke="#10b981" strokeWidth="8" strokeDasharray={ringCircumference} strokeDashoffset={ringOffset} transform="rotate(-90 50 50)" strokeLinecap="round" />
              </svg>
              <div className="bento-ring-center">
                <span className="bento-ring-value">{monitored.length}/{senders.length}</span>
                <span className="bento-ring-label">Mailboxes</span>
              </div>
            </div>
            <div className="bento-health-copy">
              <h3>{healthTitle}</h3>
              <p>{healthCopy}</p>
            </div>
          </div>
          <div className="bento-health-rows">
            <div><span>Reply-monitored mailboxes</span><strong>{monitored.length} of {senders.length}</strong></div>
            <div><span>Suppressed addresses</span><strong>{formatNumber(suppressionCount)}</strong></div>
            <div><span>Daily limit</span><strong>{DAILY_SEND_LIMIT}/day · {SEND_INTERVAL_SECONDS}s gap</strong></div>
          </div>
          <div className="bento-health-foot">
            <a className="bento-btn-outline bento-btn-block" href="/dashboard/warmup/">View Deliverability</a>
          </div>
        </div>
      </div>

      <div className="bento-panel">
        <div className="bento-panel-head">
          <div>
            <h2>Recent activity</h2>
            <p className="bento-panel-sub">What happened in this workspace, newest first.</p>
          </div>
        </div>
        {activity.length > 0 ? (
          <div className="bento-activity">
            {activity.slice(0, 10).map((item) => (
              <div className="bento-activity-row" key={item.id}>
                <span className="bento-activity-dot" />
                <p>{item.message}</p>
                <time dateTime={new Date(item.created_at * 1000).toISOString()}>{formatShortDate(item.created_at)}</time>
              </div>
            ))}
          </div>
        ) : (
          <div className="bento-empty"><p>No activity yet. Campaigns, imports, replies and suppressions will appear here.</p></div>
        )}
      </div>

      {notifications.length > 0 && (
        <div className="bento-panel">
          <div className="bento-panel-head">
            <div>
              <h2>Notifications</h2>
              <p className="bento-panel-sub">Replies and campaign updates for this workspace.</p>
            </div>
            <button className="bento-text-btn" type="button" onClick={onMarkNotificationsRead}>Mark all read</button>
          </div>
          <div className="bento-activity">
            {notifications.slice(0, 10).map((item) => (
              <div className="bento-activity-row" key={item.id}>
                <span className="bento-activity-dot" style={{ background: item.read_at ? '#d4d4d8' : '#18181b' }} />
                <p>{item.message}</p>
                <time dateTime={new Date(item.created_at * 1000).toISOString()}>{formatShortDate(item.created_at)}</time>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="bento-account-note">
        Signed in as this workspace’s owner. <a href={accountHref}>Account ↗</a>
      </p>
    </div>
  )
}
