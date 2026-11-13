import { useState } from 'react'
import { EmailDesigner } from './EmailDesigner'
import { BentoIcon } from './icons'
import type { EmailTemplate, EmailTemplateDraft, Snippet } from './types'

export function TemplatesPage({
  templates,
  snippets,
  workspaceId,
  csrfToken,
  onSaveTemplate,
  onDeleteTemplate,
  saving,
  templatesUnavailable,
}: {
  templates: EmailTemplate[]
  snippets: Snippet[]
  workspaceId: string
  csrfToken: string
  onSaveTemplate: (draft: EmailTemplateDraft) => Promise<void>
  onDeleteTemplate?: (templateId: string) => Promise<void> | void
  saving?: boolean
  templatesUnavailable?: boolean
}) {
  const [editing, setEditing] = useState<EmailTemplate | null>(null)
  const [showDesigner, setShowDesigner] = useState(false)
  const [deletingId, setDeletingId] = useState('')

  const handleSave = async (draft: EmailTemplateDraft) => {
    await onSaveTemplate(draft)
    setShowDesigner(false)
    setEditing(null)
  }

  return (
    <div className="bento-page">
      <div className="bento-page-head">
        <div>
          <h1>Templates</h1>
          <p className="bento-page-sub">Design an email once, then use it in any sequence step. Only your own saved templates appear here.</p>
        </div>
        {!showDesigner && (
          <button type="button" className="bento-btn-dark" onClick={() => { setEditing(null); setShowDesigner(true) }}>
            <BentoIcon name="plus" size={16} />
            New template
          </button>
        )}
      </div>

      {showDesigner ? (
        <div className="bento-panel">
          <EmailDesigner
            workspaceId={workspaceId}
            csrfToken={csrfToken}
            initial={editing}
            onSave={handleSave}
            onCancel={() => { setShowDesigner(false); setEditing(null) }}
            saving={saving}
          />
        </div>
      ) : (
        <>
          <div className="bento-panel">
            <div className="bento-panel-head">
              <div>
                <h2>Saved templates</h2>
                <p className="bento-panel-sub">Designed by you, in this workspace. Pick one when you write a sequence step.</p>
              </div>
              <span className="bento-pill">{templates.length} {templates.length === 1 ? 'template' : 'templates'}</span>
            </div>
            {templatesUnavailable ? (
              <div className="bento-empty">
                <p>The templates endpoint is not ready yet.</p>
                <p>Saved templates could not be loaded because the templates endpoint is not answering yet. Nothing is shown here until it is — no template is lost, and no sample template is shown in its place.</p>
              </div>
            ) : templates.length > 0 ? (
              <div className="bento-list">
                {templates.map((template) => (
                  <div className="bento-list-row" key={template.id}>
                    <div>
                      <strong>{template.name}</strong>
                      <span>{template.subject || 'No subject yet'} · {template.blocks.length} {template.blocks.length === 1 ? 'block' : 'blocks'} · updated {new Date(template.updated_at).toLocaleDateString()}</span>
                    </div>
                    <div className="bento-row-actions">
                      <button type="button" className="bento-text-btn" onClick={() => { setEditing(template); setShowDesigner(true) }}>Edit</button>
                      {onDeleteTemplate && (
                        <button
                          type="button"
                          className="bento-text-btn danger"
                          disabled={deletingId === template.id}
                          onClick={() => {
                            setDeletingId(template.id)
                            void Promise.resolve(onDeleteTemplate(template.id)).finally(() => setDeletingId(''))
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bento-empty">
                <p>No saved templates yet.</p>
                <p>Design your first one above — heading, text, image, button, divider and spacer blocks, with your own colours. There is no pre-made gallery: every template here is one you made.</p>
              </div>
            )}
          </div>

          <div className="bento-panel">
            <div className="bento-panel-head">
              <div>
                <h2>Saved replies</h2>
                <p className="bento-panel-sub">Your own short reply texts — written by you, inserted with one click while replying from the inbox. No AI writing involved.</p>
              </div>
              <a className="bento-link" href="/dashboard/settings/">Manage in Settings →</a>
            </div>
            {snippets.length > 0 ? (
              <div className="bento-list">
                {snippets.map((snippet) => (
                  <div className="bento-list-row" key={snippet.id}>
                    <div>
                      <strong>{snippet.title}</strong>
                      <span>{snippet.body.slice(0, 120)}{snippet.body.length > 120 ? '…' : ''}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bento-empty">
                <p>No saved replies yet.</p>
                <p>Save the short replies you send most often, then insert them from the inbox.</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
