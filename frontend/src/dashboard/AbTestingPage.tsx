import { useEffect, useState } from 'react'
import { dashboardRequest, fetchJson } from './api'
import { TemplatePicker } from './TemplatePicker'
import type { AbTest, AbTestDetail, AbTestStats, AbTestVariantStats, EmailTemplate } from './types'

type CampaignRef = { id: string; name: string; status: string }

function rate(value: number | null): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(1)}%`
}

function StatsTable({ stats }: { stats: AbTestVariantStats[] }) {
  if (stats.length === 0) return <div className="bento-empty"><p>No sends yet.</p><p>Stats appear here once variant A and variant B have both been sent.</p></div>
  return (
    <div className="bento-table-wrap">
      <table className="bento-table">
        <thead>
          <tr><th>Variant</th><th className="num">Sent</th><th className="num">Opened</th><th className="num">Replied</th><th className="num">Open rate</th><th className="num">Reply rate</th></tr>
        </thead>
        <tbody>
          {stats.map((variant) => (
            <tr key={variant.id}>
              <td><span className="bento-table-name">Variant {variant.label}</span></td>
              <td className="num">{variant.sent}</td>
              <td className="num">{variant.opened}</td>
              <td className="num">{variant.replied}</td>
              <td className="num">{rate(variant.openRate)}</td>
              <td className="num strong">{rate(variant.replyRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AbTestingPage({ workspaceId, csrfToken, templates }: { workspaceId: string; csrfToken: string; templates: EmailTemplate[] }) {
  const [tests, setTests] = useState<AbTest[]>([])
  const [campaigns, setCampaigns] = useState<CampaignRef[]>([])
  const [loading, setLoading] = useState(true)
  const [notAvailable, setNotAvailable] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [campaignId, setCampaignId] = useState('')
  const [testName, setTestName] = useState('')
  const [variantSubject, setVariantSubject] = useState('')
  const [variantBody, setVariantBody] = useState('')
  const [variantTemplateId, setVariantTemplateId] = useState<string | null>(null)
  const [variantBodyHtml, setVariantBodyHtml] = useState<string | null>(null)
  const [splitPercent, setSplitPercent] = useState(50)
  const [creating, setCreating] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<AbTestDetail | null>(null)
  const [stats, setStats] = useState<AbTestStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsUnavailable, setStatsUnavailable] = useState(false)
  const [busyId, setBusyId] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const { response, payload } = await dashboardRequest<AbTest[]>(`/ab-tests?workspaceId=${encodeURIComponent(workspaceId)}`, {}, csrfToken)
      if (response.status === 404 || response.status === 501) {
        setNotAvailable(true)
        setTests([])
        setCampaigns([])
        return
      }
      if (!response.ok || payload.data === undefined) throw new Error(payload.error ?? 'A/B tests could not be loaded.')
      const campaignRows = await fetchJson<CampaignRef[]>(`/campaigns?workspaceId=${encodeURIComponent(workspaceId)}`, csrfToken).catch(() => [] as CampaignRef[])
      setTests(payload.data)
      setCampaigns(campaignRows)
      setNotAvailable(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'A/B tests could not be loaded.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [workspaceId, csrfToken])

  const openDetail = async (test: AbTest) => {
    setSelectedId(test.id)
    setDetail(null)
    setStats(null)
    setStatsUnavailable(false)
    setError('')
    setStatsLoading(true)
    try {
      const [testDetail, testStats] = await Promise.all([
        fetchJson<AbTestDetail>(`/ab-tests/${encodeURIComponent(test.id)}?workspaceId=${encodeURIComponent(workspaceId)}`, csrfToken),
        fetchJson<AbTestStats>(`/ab-tests/${encodeURIComponent(test.id)}/stats?workspaceId=${encodeURIComponent(workspaceId)}`, csrfToken).catch(() => null),
      ])
      setDetail(testDetail)
      if (testStats) setStats(testStats)
      else setStatsUnavailable(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The test could not be loaded.')
    } finally {
      setStatsLoading(false)
    }
  }

  const createTest = async () => {
    if (!campaignId) {
      setError('Choose a campaign first.')
      return
    }
    if (!testName.trim()) {
      setError('Give the test a name first.')
      return
    }
    if (!variantSubject.trim() || !variantBody.trim()) {
      setError('Variant B needs a subject and a message.')
      return
    }
    if (splitPercent < 10 || splitPercent > 90) {
      setError('The split must be between 10% and 90%.')
      return
    }
    setError('')
    setCreating(true)
    try {
      const created = await fetchJson<AbTest>('/ab-tests', csrfToken, {
        method: 'POST',
        body: JSON.stringify({ workspaceId, campaignId, name: testName.trim(), splitPercent, variantB: { subject: variantSubject.trim(), bodyTemplate: variantBody, bodyHtml: variantBodyHtml } }),
      })
      setTests((current) => [created, ...current])
      setShowForm(false)
      setTestName('')
      setVariantSubject('')
      setVariantBody('')
      setVariantTemplateId(null)
      setVariantBodyHtml(null)
      setSplitPercent(50)
      setNotice('A/B test created. Variant A is the campaign’s first step; variant B is the version you just wrote.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The test could not be created.')
    } finally {
      setCreating(false)
    }
  }

  const declareWinner = async (test: AbTest, winnerVariantId: string) => {
    setBusyId(test.id)
    setError('')
    try {
      await fetchJson(`/ab-tests/${encodeURIComponent(test.id)}?workspaceId=${encodeURIComponent(workspaceId)}`, csrfToken, { method: 'PATCH', body: JSON.stringify({ status: 'complete', winnerVariantId }) })
      setTests((current) => current.map((item) => (item.id === test.id ? { ...item, status: 'complete', winner_variant_id: winnerVariantId } : item)))
      setDetail((current) => (current && current.id === test.id ? { ...current, status: 'complete', winner_variant_id: winnerVariantId } : current))
      setNotice('Winner declared. The winning variant now applies to the campaign’s first step.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The winner could not be declared.')
    } finally {
      setBusyId('')
    }
  }

  const deleteTest = async (test: AbTest) => {
    setBusyId(test.id)
    setError('')
    try {
      const { response } = await dashboardRequest(`/ab-tests/${encodeURIComponent(test.id)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' }, csrfToken)
      if (!response.ok) throw new Error('The test could not be deleted.')
      setTests((current) => current.filter((item) => item.id !== test.id))
      if (selectedId === test.id) {
        setSelectedId(null)
        setDetail(null)
        setStats(null)
      }
      setNotice(`“${test.name}” was deleted.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The test could not be deleted.')
    } finally {
      setBusyId('')
    }
  }

  const eligibleCampaigns = campaigns.filter((campaign) => campaign.status === 'draft' || campaign.status === 'active')

  return (
    <div className="bento-page">
      <div className="bento-page-head">
        <div>
          <h1>A/B testing</h1>
          <p className="bento-page-sub">Test two versions of your first email against each other — then keep the one that earns more replies.</p>
        </div>
        {!showForm && (
          <button type="button" className="bento-btn-dark" onClick={() => setShowForm(true)}>New test</button>
        )}
      </div>

      {error && <div className="bento-notice-error" role="alert">{error}</div>}
      {notice && <div className="bento-notice-success" role="status">{notice}</div>}

      {showForm && (
        <div className="bento-panel">
          <div className="bento-panel-head">
            <div>
              <h2>New A/B test</h2>
              <p className="bento-panel-sub">Variant A is copied from the campaign’s first step. You write variant B here. New recipients are split between the two.</p>
            </div>
            <button type="button" className="bento-text-btn" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
          <div className="bento-form bento-form-padded">
            <label>
              Campaign
              <select value={campaignId} onChange={(event) => setCampaignId(event.target.value)}>
                <option value="">Choose a campaign…</option>
                {eligibleCampaigns.map((campaign) => <option value={campaign.id} key={campaign.id}>{campaign.name} ({campaign.status})</option>)}
              </select>
            </label>
            <label>
              Test name
              <input value={testName} onChange={(event) => setTestName(event.target.value)} maxLength={100} placeholder="e.g. Short subject vs question subject" />
            </label>
            <label>
              Variant B subject
              <input value={variantSubject} onChange={(event) => setVariantSubject(event.target.value)} maxLength={200} placeholder="The subject line to test" />
            </label>
            <TemplatePicker templates={templates} value={variantTemplateId} onSelect={(template) => { setVariantSubject((current) => current || template.subject); setVariantBody(template.text); setVariantTemplateId(template.id); setVariantBodyHtml(template.html) }} />
            <label>
              Variant B message
              <textarea value={variantBody} onChange={(event) => setVariantBody(event.target.value)} maxLength={10000} rows={6} placeholder="Write variant B in your own words." />
            </label>
            <label>
              Split — {splitPercent}% get variant B
              <input type="range" min={10} max={90} value={splitPercent} onChange={(event) => setSplitPercent(Number(event.target.value))} />
              <span className="bento-form-hint">{100 - splitPercent}% get variant A, {splitPercent}% get variant B.</span>
            </label>
            <div className="bento-designer-actions">
              <button type="button" className="bento-btn-outline" onClick={() => setShowForm(false)}>Cancel</button>
              <button type="button" className="bento-btn-dark" disabled={creating} onClick={() => void createTest()}>{creating ? 'Creating…' : 'Create test'}</button>
            </div>
          </div>
        </div>
      )}

      <div className="bento-panel">
        <div className="bento-panel-head">
          <div>
            <h2>Your tests</h2>
            <p className="bento-panel-sub">Open a test to see both variants and their results, and declare a winner when you are sure.</p>
          </div>
          <span className="bento-pill">{tests.length} {tests.length === 1 ? 'test' : 'tests'}</span>
        </div>
        {notAvailable ? (
          <div className="bento-empty">
            <p>A/B testing is not available yet.</p>
            <p>The A/B testing endpoint is not answering yet, so saved tests cannot be loaded. Nothing is shown here until it is — no sample test is shown in its place.</p>
          </div>
        ) : loading ? (
          <div className="bento-empty"><p>Loading tests…</p></div>
        ) : tests.length > 0 ? (
          <div className="bento-list">
            {tests.map((test) => (
              <div className="bento-list-row" key={test.id}>
                <div>
                  <strong>{test.name}</strong>
                  <span>{test.campaign_name} · {100 - test.split_percent}% A / {test.split_percent}% B · created {new Date(test.created_at).toLocaleDateString()}</span>
                </div>
                <div className="bento-row-actions">
                  <span className={test.status === 'complete' ? 'bento-badge done' : 'bento-badge running'}>{test.status === 'complete' ? `Complete${test.winner_variant_id ? ' · winner declared' : ''}` : test.status}</span>
                  <button type="button" className="bento-text-btn" onClick={() => void openDetail(test)}>{selectedId === test.id ? 'Close' : 'View results'}</button>
                  <button type="button" className="bento-text-btn danger" disabled={busyId === test.id} onClick={() => void deleteTest(test)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="bento-empty">
            <p>No A/B tests yet.</p>
            <p>An A/B test sends two versions of your first email to different halves of your audience and shows which one gets more opens and replies. Variant A is your campaign’s first step; variant B is the version you write for the test. When one clearly wins, declare it the winner and it becomes the campaign’s first step.</p>
            <button type="button" className="bento-btn-outline" onClick={() => setShowForm(true)}>Create your first test</button>
          </div>
        )}
      </div>

      {selectedId && detail && (
        <div className="bento-panel">
          <div className="bento-panel-head">
            <div>
              <h2>{detail.name}</h2>
              <p className="bento-panel-sub">{detail.campaign_name} · {100 - detail.split_percent}% A / {detail.split_percent}% B</p>
            </div>
            <button type="button" className="bento-text-btn" onClick={() => { setSelectedId(null); setDetail(null); setStats(null) }}>Close results</button>
          </div>
          <div className="bento-variant-grid">
            {detail.variants.map((variant) => (
              <article className="bento-variant-card" key={variant.id}>
                <div className="bento-variant-head">
                  <h3>Variant {variant.label}</h3>
                  {detail.winner_variant_id === variant.id && <span className="bento-badge running">Winner</span>}
                </div>
                <p className="bento-variant-subject">{variant.subject || '(no subject)'}</p>
                <pre className="bento-variant-body">{variant.body_template}</pre>
                {variant.body_html && <p className="bento-variant-note">Includes a designed HTML version.</p>}
                {detail.status !== 'complete' && (
                  <button type="button" className="bento-btn-outline" disabled={busyId === detail.id} onClick={() => void declareWinner(detail, variant.id)}>Declare variant {variant.label} the winner</button>
                )}
              </article>
            ))}
          </div>
          <div className="bento-panel-head">
            <div>
              <h2>Results</h2>
              <p className="bento-panel-sub">Recorded sends, opens and replies per variant.</p>
            </div>
          </div>
          {statsLoading ? (
            <div className="bento-empty"><p>Loading stats…</p></div>
          ) : statsUnavailable ? (
            <div className="bento-empty"><p>Stats are not available yet.</p><p>The stats endpoint is not answering yet — results will appear here once it is.</p></div>
          ) : stats ? (
            <StatsTable stats={stats.variants} />
          ) : (
            <div className="bento-empty"><p>No sends yet.</p><p>Stats appear here once variant A and variant B have both been sent.</p></div>
          )}
        </div>
      )}
    </div>
  )
}
