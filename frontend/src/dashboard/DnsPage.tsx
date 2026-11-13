import { useCallback, useEffect, useState } from 'react'
import { dashboardRequest } from './api'
import type { DnsCheck, DnsResult } from './types'

const RECORD_GUIDE: { record: DnsCheck['record']; title: string; body: string }[] = [
  { record: 'SPF', title: 'SPF — who may send for your domain', body: 'SPF lists the servers allowed to send mail for your domain. Receiving mailboxes check it first: if the server sending your mail is not on the list, the message looks suspicious even when the content is fine. Add the SPF record your mailbox provider gives you to your domain’s DNS.' },
  { record: 'DKIM', title: 'DKIM — proof the message was not altered', body: 'DKIM signs each message so receivers can confirm it was not altered on the way. Your mailbox provider gives you a DKIM key to publish as a DNS record; once it is there, every message you send carries a signature receivers can verify.' },
  { record: 'DMARC', title: 'DMARC — what to do when a check fails', body: 'DMARC tells receivers what to do when a message fails the SPF or DKIM checks — for example, to reject it or send it to spam — and where to send reports about failures. Start with a reporting-only policy, then move to reject once SPF and DKIM pass.' },
]

export function DnsPage({ workspaceId, csrfToken, senderEmail }: { workspaceId: string; csrfToken: string; senderEmail: string }) {
  const [result, setResult] = useState<DnsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [notAvailable, setNotAvailable] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')

  const domain = result?.domain ?? (senderEmail.includes('@') ? senderEmail.split('@')[1] : '')
  const sender = result?.senderEmail ?? senderEmail

  const checkNow = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setError('')
    setNotAvailable(false)
    try {
      const { response, payload } = await dashboardRequest<DnsResult>(`/dns?workspaceId=${encodeURIComponent(workspaceId)}`, {}, csrfToken)
      if (response.status === 404 || response.status === 501) {
        setNotAvailable(true)
        setResult(null)
        return
      }
      if (!response.ok || payload.data === undefined) throw new Error(payload.error ?? 'The DNS check could not be completed.')
      setResult(payload.data)
      setNotAvailable(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The DNS check could not be completed.')
    } finally {
      setLoading(false)
    }
  }, [workspaceId, csrfToken])

  useEffect(() => {
    void checkNow()
  }, [checkNow])

  const copyRecord = async (record: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(record)
      window.setTimeout(() => setCopied(''), 2000)
    } catch {
      setCopied('')
    }
  }

  const statusBadge = (status: DnsCheck['status']) => {
    if (status === 'pass') return <span className="bento-badge running">Pass</span>
    if (status === 'fail') return <span className="bento-badge" style={{ background: '#fff1f2', color: '#be123c', borderColor: '#ffe4e6' }}>Fail</span>
    return <span className="bento-badge draft">Could not be checked</span>
  }

  return (
    <div className="bento-page">
      <div className="bento-page-head">
        <div>
          <h1>DNS setup</h1>
          <p className="bento-page-sub">SPF, DKIM and DMARC for {domain || 'your sending domain'} — what each record does, and whether yours is set up correctly.</p>
        </div>
        <button type="button" className="bento-btn-dark" disabled={loading} onClick={() => void checkNow()}>{loading ? 'Checking…' : 'Check now'}</button>
      </div>

      {error && <div className="bento-notice-error" role="alert">{error}</div>}
      {notAvailable && (
        <div className="bento-panel">
          <div className="bento-empty">
            <p>The live DNS check is not available yet.</p>
            <p>The DNS endpoint is not answering yet, so records cannot be checked live. The guide below still applies — set the records up with your mailbox or domain provider, then check again once the endpoint is live.</p>
          </div>
        </div>
      )}

      <div className="bento-panel">
        <div className="bento-panel-head">
          <div>
            <h2>Record status</h2>
            <p className="bento-panel-sub">Checked for {sender || 'your sender address'}{domain ? ` on ${domain}` : ''}. Green means the record is in place; red means it is missing or wrong.</p>
          </div>
        </div>
        {result && result.checks.length > 0 ? (
          <div className="bento-dns-grid">
            {result.checks.map((check) => (
              <article className={`bento-dns-card ${check.status}`} key={check.record}>
                <div className="bento-dns-card-head">
                  <h3>{check.record}</h3>
                  {statusBadge(check.status)}
                </div>
                <p>{check.detail}</p>
                {check.status === 'fail' && check.expected && (
                  <div>
                    <p className="bento-dns-expected-label">Add this record to your DNS:</p>
                    <pre className="bento-code">{check.expected}</pre>
                    <button type="button" className="bento-text-btn" onClick={() => void copyRecord(check.record, check.expected as string)}>{copied === check.record ? 'Copied' : 'Copy record'}</button>
                  </div>
                )}
                {check.status === 'unknown' && <p className="bento-dns-unknown">This record could not be checked — try again, or check it with your domain provider.</p>}
              </article>
            ))}
          </div>
        ) : !notAvailable && !error ? (
          <div className="bento-empty">
            <p>{loading ? 'Checking your DNS records…' : 'No DNS results yet.'}</p>
            <p>Press “Check now” to verify SPF, DKIM and DMARC for your sending domain.</p>
          </div>
        ) : null}
      </div>

      <div className="bento-panel">
        <div className="bento-panel-head">
          <div>
            <h2>What each record does</h2>
            <p className="bento-panel-sub">Sending from generic addresses guarantees the spam folder. These three records authenticate your domain so your emails land in the primary inbox.</p>
          </div>
        </div>
        <div className="bento-feature-grid">
          {RECORD_GUIDE.map((guide) => (
            <article className="bento-feature-card" key={guide.record}>
              <div className="bento-feature-top"><span>{guide.record}</span><b aria-hidden="true">✓</b></div>
              <h3>{guide.title}</h3>
              <p>{guide.body}</p>
            </article>
          ))}
        </div>
        {result && result.guidance.length > 0 && (
          <div className="bento-guidance">
            {result.guidance.map((item) => (
              <div key={item.title}>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </div>
            ))}
          </div>
        )}
        <p className="bento-panel-foot">Set the records up with your mailbox or domain provider — DNS changes can take a while to spread, so re-check after a few hours if a record still shows as failing. Keep reading: <a href="/blog/a-practical-guide-to-email-deliverability/">A practical guide to email deliverability</a></p>
      </div>
    </div>
  )
}
