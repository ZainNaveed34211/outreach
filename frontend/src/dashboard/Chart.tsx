import { formatShortDate } from './api'
import type { DailyPoint } from './types'

export function PerformanceChart({ series }: { series: DailyPoint[] | null }) {
  if (series === null) {
    return (
      <div className="bento-chart-empty" role="status">
        <p>Daily performance history is not available yet.</p>
        <p>Workspace analytics will add a 30-day breakdown here — sends and replies per day, with a comparison to the previous 30 days.</p>
      </div>
    )
  }
  if (series.length === 0) {
    return (
      <div className="bento-chart-empty" role="status">
        <p>No sends in the last 30 days yet.</p>
        <p>Launch a campaign and the daily breakdown will appear here.</p>
      </div>
    )
  }
  const maxSent = Math.max(...series.map((point) => point.sent), 1)
  const first = series[0]
  const last = series[series.length - 1]
  return (
    <div>
      <div className="bento-chart" role="img" aria-label={`Campaign performance, ${series.length} days`}>
        {series.map((point) => {
          const totalHeight = point.sent > 0 ? Math.max(4, (point.sent / maxSent) * 100) : 0
          const replyShare = point.sent > 0 ? (point.replied / point.sent) * 100 : 0
          return (
            <div
              key={point.date}
              className="bento-bar"
              style={{ height: `${totalHeight}%` }}
              title={`${formatShortDate(point.date)}: ${point.sent} sent · ${point.opened} opened · ${point.replied} replies`}
            >
              <div className="bento-bar-fill" style={{ height: `${replyShare}%` }} />
            </div>
          )
        })}
      </div>
      <div className="bento-chart-axis">
        <span>{formatShortDate(first.date)}</span>
        <span>{formatShortDate(last.date)}</span>
      </div>
    </div>
  )
}
