import { useEffect, useState } from 'react'
import { dashboardRequest, fetchJson } from './api'
import { BentoIcon } from './icons'
import type { EmailTemplate, Workflow, WorkflowAction, WorkflowRule } from './types'

type LeadListRef = { id: string; name: string; lead_count: number }

const LEAD_STATUSES = ['new', 'contacted', 'replied', 'interested', 'not_interested', 'bounced', 'unsubscribed']

function newRuleId(): string {
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function blankRule(): WorkflowRule {
  return { id: newRuleId(), condition: { type: 'reply_any' }, actions: [{ type: 'stop' }] }
}

function blankAction(): WorkflowAction {
  return { type: 'stop' }
}

function conditionLabel(rule: WorkflowRule): string {
  if (rule.condition.type === 'reply_contains') return `Reply contains “${rule.condition.value ?? ''}”`
  if (rule.condition.type === 'no_reply_after_days') return `No reply after ${rule.condition.value ?? ''} days`
  return 'Any reply'
}

function actionLabel(action: WorkflowAction, lists: LeadListRef[], templates: EmailTemplate[]): string {
  if (action.type === 'move_to_list') return `Move to list “${lists.find((list) => list.id === action.listId)?.name ?? 'a list'}”`
  if (action.type === 'send_email') return `Send email “${templates.find((template) => template.id === action.templateId)?.name ?? 'a template'}”`
  if (action.type === 'change_status') return `Change lead status to ${action.status.replaceAll('_', ' ')}`
  if (action.type === 'follow_up_step') return `Send follow-up step ${action.stepNo}`
  if (action.type === 'stop') return 'Stop sequence'
  return 'Notify me'
}

function validateRules(rules: WorkflowRule[]): string {
  if (rules.length < 1) return 'Add at least one rule.'
  if (rules.length > 20) return 'A workflow can have at most 20 rules.'
  for (const rule of rules) {
    if (rule.actions.length < 1) return 'Every rule needs at least one action.'
    if (rule.actions.length > 5) return 'A rule can have at most 5 actions.'
    if (rule.condition.type === 'reply_contains') {
      const word = String(rule.condition.value ?? '').trim()
      if (word.length < 1 || word.length > 100) return 'A “reply contains” word must be 1–100 characters.'
    }
    if (rule.condition.type === 'no_reply_after_days') {
      const days = Number(rule.condition.value)
      if (!Number.isInteger(days) || days < 1 || days > 365) return '“No reply after” must be 1–365 days.'
    }
    for (const action of rule.actions) {
      if (action.type === 'move_to_list' && !action.listId) return 'Choose a list for the “move to list” action.'
      if (action.type === 'send_email' && !action.templateId) return 'Choose a template for the “send email” action.'
      if (action.type === 'change_status' && !action.status) return 'Choose a status for the “change lead status” action.'
      if (action.type === 'follow_up_step' && (!Number.isInteger(action.stepNo) || action.stepNo < 1 || action.stepNo > 50)) return 'A follow-up step must be 1–50.'
    }
  }
  return ''
}

export function WorkflowsPage({ workspaceId, csrfToken, lists, templates }: { workspaceId: string; csrfToken: string; lists: LeadListRef[]; templates: EmailTemplate[] }) {
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [loading, setLoading] = useState(true)
  const [notAvailable, setNotAvailable] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftRules, setDraftRules] = useState<WorkflowRule[]>([])
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const { response, payload } = await dashboardRequest<Workflow[]>(`/workflows?workspaceId=${encodeURIComponent(workspaceId)}`, {}, csrfToken)
      if (response.status === 404 || response.status === 501) {
        setNotAvailable(true)
        setWorkflows([])
        return
      }
      if (!response.ok || payload.data === undefined) throw new Error(payload.error ?? 'Workflows could not be loaded.')
      setWorkflows(payload.data)
      setNotAvailable(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Workflows could not be loaded.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [workspaceId, csrfToken])

  const startNew = () => {
    setEditingId('new')
    setDraftName('')
    setDraftRules([blankRule()])
    setError('')
    setNotice('')
  }

  const startEdit = (workflow: Workflow) => {
    setEditingId(workflow.id)
    setDraftName(workflow.name)
    setDraftRules(workflow.rules.length ? workflow.rules : [blankRule()])
    setError('')
    setNotice('')
  }

  const updateCondition = (ruleId: string, type: WorkflowRule['condition']['type'], value?: string | number) => {
    setDraftRules((current) => current.map((rule) => {
      if (rule.id !== ruleId) return rule
      if (type === 'reply_contains') return { ...rule, condition: { type, value: typeof value === 'string' ? value : '' } }
      if (type === 'no_reply_after_days') return { ...rule, condition: { type, value: typeof value === 'number' ? value : 3 } }
      return { ...rule, condition: { type } }
    }))
  }

  const updateAction = (ruleId: string, index: number, patch: Partial<WorkflowAction>) => {
    setDraftRules((current) => current.map((rule) => {
      if (rule.id !== ruleId) return rule
      const actions = rule.actions.map((action, i) => (i === index ? ({ ...action, ...patch } as WorkflowAction) : action))
      return { ...rule, actions }
    }))
  }

  const setActionType = (ruleId: string, index: number, type: WorkflowAction['type']) => {
    setDraftRules((current) => current.map((rule) => {
      if (rule.id !== ruleId) return rule
      const actions = rule.actions.map((action, i) => {
        if (i !== index) return action
        if (type === 'move_to_list') return { type, listId: lists[0]?.id ?? '' } as WorkflowAction
        if (type === 'send_email') return { type, templateId: templates[0]?.id ?? '' } as WorkflowAction
        if (type === 'change_status') return { type, status: 'interested' } as WorkflowAction
        if (type === 'follow_up_step') return { type, stepNo: 2 } as WorkflowAction
        if (type === 'stop') return { type } as WorkflowAction
        return { type } as WorkflowAction
      })
      return { ...rule, actions }
    }))
  }

  const moveRule = (ruleId: string, direction: -1 | 1) => {
    setDraftRules((current) => {
      const index = current.findIndex((rule) => rule.id === ruleId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= current.length) return current
      const next = [...current]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      return next
    })
  }

  const saveDraft = async () => {
    const validation = validateRules(draftRules)
    if (!draftName.trim()) {
      setError('Give the workflow a name first.')
      return
    }
    if (validation) {
      setError(validation)
      return
    }
    setError('')
    setSaving(true)
    try {
      if (editingId === 'new') {
        await fetchJson('/workflows', csrfToken, { method: 'POST', body: JSON.stringify({ workspaceId, name: draftName.trim(), rules: draftRules }) })
        setNotice('Workflow created.')
      } else if (editingId) {
        await fetchJson(`/workflows/${encodeURIComponent(editingId)}?workspaceId=${encodeURIComponent(workspaceId)}`, csrfToken, { method: 'PATCH', body: JSON.stringify({ name: draftName.trim(), rules: draftRules }) })
        setNotice('Workflow saved.')
      }
      setEditingId(null)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The workflow could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const deleteWorkflow = async (workflow: Workflow) => {
    setBusyId(workflow.id)
    setError('')
    try {
      const { response } = await dashboardRequest(`/workflows/${encodeURIComponent(workflow.id)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' }, csrfToken)
      if (!response.ok) throw new Error('The workflow could not be deleted.')
      setWorkflows((current) => current.filter((item) => item.id !== workflow.id))
      setNotice(`“${workflow.name}” was deleted.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The workflow could not be deleted.')
    } finally {
      setBusyId('')
    }
  }

  const toggleActive = async (workflow: Workflow) => {
    setBusyId(workflow.id)
    setError('')
    try {
      await fetchJson(`/workflows/${encodeURIComponent(workflow.id)}?workspaceId=${encodeURIComponent(workspaceId)}`, csrfToken, { method: 'PATCH', body: JSON.stringify({ is_active: !workflow.is_active }) })
      setWorkflows((current) => current.map((item) => (item.id === workflow.id ? { ...item, is_active: !item.is_active } : item)))
      setNotice(workflow.is_active ? `“${workflow.name}” is paused.` : `“${workflow.name}” is active.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The workflow could not be updated.')
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="bento-page">
      <div className="bento-page-head">
        <div>
          <h1>Workflows</h1>
          <p className="bento-page-sub">Decide what happens after a reply — or when there is none. Workflows run automatically on your leads.</p>
        </div>
        {!editingId && (
          <button type="button" className="bento-btn-dark" onClick={startNew}>
            <BentoIcon name="plus" size={16} />
            New workflow
          </button>
        )}
      </div>

      {error && <div className="bento-notice-error" role="alert">{error}</div>}
      {notice && <div className="bento-notice-success" role="status">{notice}</div>}

      {editingId ? (
        <div className="bento-panel">
          <div className="bento-panel-head">
            <div>
              <h2>{editingId === 'new' ? 'New workflow' : 'Edit workflow'}</h2>
              <p className="bento-panel-sub">Each rule is a WHEN card followed by THEN actions. Rules run in order, top to bottom.</p>
            </div>
            <button type="button" className="bento-text-btn" onClick={() => setEditingId(null)}>Close editor</button>
          </div>
          <div className="bento-form bento-form-padded">
            <label>
              Workflow name
              <input value={draftName} onChange={(event) => setDraftName(event.target.value)} maxLength={100} placeholder="e.g. Interested replies go to sales" />
            </label>
          </div>
          <div className="bento-flow">
            {draftRules.map((rule, ruleIndex) => (
              <div className="bento-rule" key={rule.id}>
                <div className="bento-rule-head">
                  <span className="bento-rule-number">Rule {ruleIndex + 1}</span>
                  <div className="bento-row-actions">
                    <button type="button" className="bento-text-btn" disabled={ruleIndex === 0} onClick={() => moveRule(rule.id, -1)} aria-label="Move rule up">↑</button>
                    <button type="button" className="bento-text-btn" disabled={ruleIndex === draftRules.length - 1} onClick={() => moveRule(rule.id, 1)} aria-label="Move rule down">↓</button>
                    <button type="button" className="bento-text-btn danger" disabled={draftRules.length <= 1} onClick={() => setDraftRules((current) => current.filter((item) => item.id !== rule.id))}>Remove rule</button>
                  </div>
                </div>
                <div className="bento-when-card">
                  <span className="bento-flow-tag">WHEN</span>
                  <select aria-label="Rule condition" value={rule.condition.type} onChange={(event) => updateCondition(rule.id, event.target.value as WorkflowRule['condition']['type'])}>
                    <option value="reply_any">Any reply</option>
                    <option value="reply_contains">Reply contains…</option>
                    <option value="no_reply_after_days">No reply after N days</option>
                  </select>
                  {rule.condition.type === 'reply_contains' && (
                    <input aria-label="Word to look for in the reply" value={String(rule.condition.value ?? '')} maxLength={100} placeholder="e.g. interested" onChange={(event) => updateCondition(rule.id, 'reply_contains', event.target.value)} />
                  )}
                  {rule.condition.type === 'no_reply_after_days' && (
                    <label className="bento-inline-label">
                      Days
                      <input type="number" min={1} max={365} value={Number(rule.condition.value ?? 3)} onChange={(event) => updateCondition(rule.id, 'no_reply_after_days', Number(event.target.value))} />
                    </label>
                  )}
                </div>
                <div className="bento-connector" aria-hidden="true"><span>↓</span><em>THEN</em></div>
                {rule.actions.map((action, actionIndex) => (
                  <div className="bento-action-card" key={actionIndex}>
                    <span className="bento-flow-tag">THEN</span>
                    <select aria-label="Action" value={action.type} onChange={(event) => setActionType(rule.id, actionIndex, event.target.value as WorkflowAction['type'])}>
                      <option value="move_to_list">Move to list</option>
                      <option value="send_email">Send email</option>
                      <option value="change_status">Change lead status</option>
                      <option value="follow_up_step">Send follow-up step</option>
                      <option value="stop">Stop sequence</option>
                      <option value="notify">Notify me</option>
                    </select>
                    {action.type === 'move_to_list' && (
                      <select aria-label="List to move to" value={action.listId} onChange={(event) => updateAction(rule.id, actionIndex, { listId: event.target.value } as Partial<WorkflowAction>)}>
                        {lists.length === 0 && <option value="">No lists yet</option>}
                        {lists.map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}
                      </select>
                    )}
                    {action.type === 'send_email' && (
                      <select aria-label="Template to send" value={action.templateId} onChange={(event) => updateAction(rule.id, actionIndex, { templateId: event.target.value } as Partial<WorkflowAction>)}>
                        {templates.length === 0 && <option value="">No templates yet</option>}
                        {templates.map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}
                      </select>
                    )}
                    {action.type === 'change_status' && (
                      <select aria-label="New lead status" value={action.status} onChange={(event) => updateAction(rule.id, actionIndex, { status: event.target.value } as Partial<WorkflowAction>)}>
                        {LEAD_STATUSES.map((status) => <option value={status} key={status}>{status.replaceAll('_', ' ')}</option>)}
                      </select>
                    )}
                    {action.type === 'follow_up_step' && (
                      <label className="bento-inline-label">
                        Step
                        <input type="number" min={1} max={50} value={action.stepNo} onChange={(event) => updateAction(rule.id, actionIndex, { stepNo: Number(event.target.value) } as Partial<WorkflowAction>)} />
                      </label>
                    )}
                    <button type="button" className="bento-text-btn danger" disabled={rule.actions.length <= 1} onClick={() => setDraftRules((current) => current.map((item) => (item.id === rule.id ? { ...item, actions: item.actions.filter((_, i) => i !== actionIndex) } : item)))}>Remove</button>
                  </div>
                ))}
                <button type="button" className="bento-btn-outline" disabled={draftRules[ruleIndex].actions.length >= 5} onClick={() => setDraftRules((current) => current.map((item) => (item.id === rule.id && item.actions.length < 5 ? { ...item, actions: [...item.actions, blankAction()] } : item)))}>+ Add action</button>
              </div>
            ))}
            <button type="button" className="bento-btn-outline" disabled={draftRules.length >= 20} onClick={() => setDraftRules((current) => [...current, blankRule()])}>+ Add rule</button>
          </div>
          <div className="bento-designer-actions">
            <button type="button" className="bento-btn-outline" onClick={() => setEditingId(null)}>Cancel</button>
            <button type="button" className="bento-btn-dark" disabled={saving} onClick={() => void saveDraft()}>{saving ? 'Saving…' : 'Save workflow'}</button>
          </div>
        </div>
      ) : (
        <>
          <div className="bento-panel">
            <div className="bento-panel-head">
              <div>
                <h2>Your workflows</h2>
                <p className="bento-panel-sub">Active workflows run automatically when a lead replies — or does not reply.</p>
              </div>
              <span className="bento-pill">{workflows.length} {workflows.length === 1 ? 'workflow' : 'workflows'}</span>
            </div>
            {notAvailable ? (
              <div className="bento-empty">
                <p>Workflows are not available yet.</p>
                <p>The workflows endpoint is not answering yet, so saved workflows cannot be loaded. Nothing is shown here until it is — no sample workflow is shown in its place.</p>
              </div>
            ) : loading ? (
              <div className="bento-empty"><p>Loading workflows…</p></div>
            ) : workflows.length > 0 ? (
              <div className="bento-list">
                {workflows.map((workflow) => (
                  <div className="bento-list-row" key={workflow.id}>
                    <div>
                      <strong>{workflow.name}</strong>
                      <span>{workflow.rules.length} {workflow.rules.length === 1 ? 'rule' : 'rules'}{workflow.rules[0] ? ` · ${conditionLabel(workflow.rules[0])}` : ''} · updated {new Date(workflow.updated_at).toLocaleDateString()}</span>
                      <span>{workflow.rules.flatMap((rule) => rule.actions.map((action) => actionLabel(action, lists, templates))).slice(0, 3).join(' · ')}</span>
                    </div>
                    <div className="bento-row-actions">
                      <button type="button" className="bento-text-btn" disabled={busyId === workflow.id} onClick={() => void toggleActive(workflow)}>{workflow.is_active ? 'Pause' : 'Activate'}</button>
                      <button type="button" className="bento-text-btn" onClick={() => startEdit(workflow)}>Edit</button>
                      <button type="button" className="bento-text-btn danger" disabled={busyId === workflow.id} onClick={() => void deleteWorkflow(workflow)}>Delete</button>
                      <span className={workflow.is_active ? 'bento-badge running' : 'bento-badge paused'}>{workflow.is_active ? 'Active' : 'Paused'}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bento-empty">
                <p>No workflows yet.</p>
                <p>A workflow is a set of rules you design: when something happens, do something automatically. For example — if a reply contains “interested”, move the lead to your Interested list and send them your pricing email. If nobody replies after 5 days, send a follow-up instead.</p>
                <button type="button" className="bento-btn-outline" onClick={startNew}>Create your first workflow</button>
              </div>
            )}
          </div>
          <div className="bento-panel">
            <div className="bento-panel-head">
              <div>
                <h2>How workflows work</h2>
                <p className="bento-panel-sub">Plain rules, checked in order, top to bottom.</p>
              </div>
            </div>
            <div className="bento-feature-grid">
              <article className="bento-feature-card"><div className="bento-feature-top"><span>01</span><b aria-hidden="true">✓</b></div><h3>When something happens</h3><p>A lead replies, a reply contains a word you choose, or nobody replies after a number of days you choose.</p></article>
              <article className="bento-feature-card"><div className="bento-feature-top"><span>02</span><b aria-hidden="true">✓</b></div><h3>Then do something</h3><p>Move the lead to a list, send them an email from one of your templates, change their status, send a follow-up step, stop the sequence, or notify you.</p></article>
              <article className="bento-feature-card"><div className="bento-feature-top"><span>03</span><b aria-hidden="true">✓</b></div><h3>Automatically, every time</h3><p>Active workflows run on their own — you decide the rules once, and they apply to every matching lead.</p></article>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
