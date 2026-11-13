import { useEffect, useMemo, useState } from 'react'
import { fetchImageBlob, uploadTemplateImage } from './api'
import { BentoIcon } from './icons'
import type { EmailBlock, EmailTemplate, EmailTemplateDraft, SampleLead } from './types'

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function resolveVariables(text: string, lead: SampleLead): string {
  return text.replace(/\{\{(first_name|company)\}\}/g, (_match, key: string) => {
    const value = key === 'first_name' ? lead.first_name : lead.company
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  })
}

function isSafeHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function headingSize(size: 'small' | 'medium' | 'large'): number {
  return size === 'small' ? 20 : size === 'large' ? 36 : 28
}

function blockHtml(block: EmailBlock): string {
  if (block.type === 'heading') {
    return `<h2 style="margin:0 0 12px;font-size:${headingSize(block.size)}px;line-height:1.25;font-weight:700;color:${block.color};text-align:${block.align};font-family:Inter,Arial,Helvetica,sans-serif;">${escapeHtml(block.text)}</h2>`
  }
  if (block.type === 'text') {
    const lines = escapeHtml(block.text).split('\n').map((line) => (line === '' ? '&nbsp;' : line)).join('<br>')
    return `<p style="margin:0 0 12px;font-size:${block.size}px;line-height:1.65;color:${block.color};text-align:${block.align};font-family:Inter,Arial,Helvetica,sans-serif;">${lines}</p>`
  }
  if (block.type === 'image') {
    const src = escapeHtml(block.src)
    if (!src) return ''
    return `<div style="text-align:${block.align};margin:0 0 12px;"><img src="${src}" alt="${escapeHtml(block.alt)}" style="width:${block.width}%;max-width:100%;height:auto;border:0;display:inline-block;"></div>`
  }
  if (block.type === 'button') {
    const href = isSafeHttpUrl(block.url) ? escapeHtml(block.url) : '#'
    return `<div style="text-align:${block.align};margin:0 0 12px;"><a href="${href}" style="display:inline-block;background:${block.background};color:${block.color};font-family:Inter,Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;line-height:1;text-decoration:none;padding:12px 24px;border-radius:8px;">${escapeHtml(block.label)}</a></div>`
  }
  if (block.type === 'divider') {
    return `<hr style="border:0;border-top:1px solid ${block.color};margin:16px 0;">`
  }
  return `<div style="height:${block.height}px;line-height:${block.height}px;font-size:1px;">&nbsp;</div>`
}

export function compileTemplateHtml(blocks: EmailBlock[]): string {
  const inner = blocks.map(blockHtml).filter(Boolean).join('\n')
  return `<div style="max-width:600px;margin:0 auto;padding:24px 16px;background:#ffffff;font-family:Inter,Arial,Helvetica,sans-serif;">\n${inner}\n</div>`
}

export function compileTemplateText(blocks: EmailBlock[]): string {
  const lines: string[] = []
  for (const block of blocks) {
    if (block.type === 'heading' || block.type === 'text') lines.push(block.text)
    if (block.type === 'image' && block.alt) lines.push(`[Image: ${block.alt}]`)
    if (block.type === 'button') lines.push(`${block.label}: ${block.url}`)
  }
  return lines.filter((line) => line.trim() !== '').join('\n\n')
}

function newBlockId(): string {
  return `block-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function makeBlock(type: EmailBlock['type']): EmailBlock {
  const id = newBlockId()
  if (type === 'heading') return { id, type, text: 'Your heading', size: 'medium', color: '#18181b', align: 'left' }
  if (type === 'text') return { id, type, text: 'Write your message here. Use {{first_name}} to personalise it for each lead.', size: 15, color: '#3f3f46', align: 'left' }
  if (type === 'image') return { id, type, src: '', fileId: null, alt: '', width: 100, align: 'center' }
  if (type === 'button') return { id, type, label: 'Learn more', url: '', background: '#18181b', color: '#ffffff', align: 'left' }
  if (type === 'divider') return { id, type, color: '#e4e4e7' }
  return { id, type: 'spacer', height: 24 }
}

function BlockCanvas({ block, lead, imageUrls }: { block: EmailBlock; lead: SampleLead; imageUrls: Record<string, string> }) {
  if (block.type === 'heading') {
    const size = headingSize(block.size)
    return <h2 style={{ margin: '0 0 12px', fontSize: size, lineHeight: 1.25, fontWeight: 700, color: block.color, textAlign: block.align }}>{resolveVariables(block.text, lead)}</h2>
  }
  if (block.type === 'text') {
    return (
      <p style={{ margin: '0 0 12px', fontSize: block.size, lineHeight: 1.65, color: block.color, textAlign: block.align, whiteSpace: 'pre-wrap' }}>
        {resolveVariables(block.text, lead)}
      </p>
    )
  }
  if (block.type === 'image') {
    const src = imageUrls[block.id] ?? block.src
    if (!src) return <div className="bento-designer-image-empty">No image yet — upload one or paste an image URL.</div>
    return (
      <div style={{ textAlign: block.align, margin: '0 0 12px' }}>
        <img src={src} alt={block.alt} style={{ width: `${block.width}%`, maxWidth: '100%', height: 'auto', display: 'inline-block', borderRadius: 6 }} />
      </div>
    )
  }
  if (block.type === 'button') {
    return (
      <div style={{ textAlign: block.align, margin: '0 0 12px' }}>
        <span style={{ display: 'inline-block', background: block.background, color: block.color, fontSize: 14, fontWeight: 600, padding: '12px 24px', borderRadius: 8 }}>{block.label || 'Button'}</span>
      </div>
    )
  }
  if (block.type === 'divider') return <hr style={{ border: 0, borderTop: `1px solid ${block.color}`, margin: '16px 0' }} />
  return <div style={{ height: block.height }} aria-hidden="true" />
}

export function EmailDesigner({
  workspaceId,
  csrfToken,
  initial,
  onSave,
  onCancel,
  saving,
}: {
  workspaceId: string
  csrfToken: string
  initial?: EmailTemplate | null
  onSave: (draft: EmailTemplateDraft) => Promise<void> | void
  onCancel?: () => void
  saving?: boolean
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [subject, setSubject] = useState(initial?.subject ?? '')
  const [blocks, setBlocks] = useState<EmailBlock[]>(initial?.blocks ?? [makeBlock('heading'), makeBlock('text'), makeBlock('button')])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sampleLead, setSampleLead] = useState<SampleLead>({ first_name: 'Alex', company: 'Acme Corp' })
  const [showText, setShowText] = useState(false)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({})

  const selected = blocks.find((block) => block.id === selectedId) ?? null
  const html = useMemo(() => compileTemplateHtml(blocks), [blocks])
  const text = useMemo(() => compileTemplateText(blocks), [blocks])

  useEffect(() => {
    const imageBlocks = blocks.filter((block): block is Extract<EmailBlock, { type: 'image' }> => block.type === 'image' && Boolean(block.fileId) && !imageUrls[block.id])
    if (imageBlocks.length === 0) return
    let active = true
    void Promise.all(
      imageBlocks.map(async (block) => {
        try {
          const blob = await fetchImageBlob(block.fileId as string, workspaceId, csrfToken)
          const url = URL.createObjectURL(blob)
          if (active) setImageUrls((current) => ({ ...current, [block.id]: url }))
        } catch {
          return
        }
      }),
    )
    return () => {
      active = false
    }
  }, [blocks, imageUrls, workspaceId, csrfToken])

  const updateBlock = (id: string, patch: Partial<EmailBlock>) => {
    setBlocks((current) => current.map((block) => (block.id === id ? ({ ...block, ...patch } as EmailBlock) : block)))
  }

  const addBlock = (type: EmailBlock['type']) => {
    const block = makeBlock(type)
    setBlocks((current) => [...current, block])
    setSelectedId(block.id)
  }

  const moveBlock = (id: string, direction: -1 | 1) => {
    setBlocks((current) => {
      const index = current.findIndex((block) => block.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= current.length) return current
      const next = [...current]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      return next
    })
  }

  const duplicateBlock = (id: string) => {
    setBlocks((current) => {
      const index = current.findIndex((block) => block.id === id)
      if (index < 0) return current
      const copy = { ...current[index], id: newBlockId() } as EmailBlock
      const next = [...current]
      next.splice(index + 1, 0, copy)
      return next
    })
  }

  const removeBlock = (id: string) => {
    setBlocks((current) => current.filter((block) => block.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

  const handleImageFile = async (blockId: string, file: File | null) => {
    if (!file) return
    setError('')
    const localUrl = URL.createObjectURL(file)
    setImageUrls((current) => ({ ...current, [blockId]: localUrl }))
    setUploading(true)
    try {
      const uploaded = await uploadTemplateImage(file, workspaceId, csrfToken)
      updateBlock(blockId, { src: uploaded.url, fileId: uploaded.id })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Image upload failed.')
      setImageUrls((current) => {
        const next = { ...current }
        delete next[blockId]
        return next
      })
    } finally {
      setUploading(false)
    }
  }

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Give the template a name first.')
      return
    }
    if (blocks.length === 0) {
      setError('Add at least one block to the template.')
      return
    }
    for (const block of blocks) {
      if (block.type === 'button' && block.url && !isSafeHttpUrl(block.url)) {
        setError('Button links must start with https://')
        return
      }
      if (block.type === 'image' && block.src && !block.fileId && !isSafeHttpUrl(block.src)) {
        setError('Image URLs must start with https://')
        return
      }
    }
    setError('')
    await onSave({ id: initial?.id ?? null, name: name.trim(), subject: subject.trim(), blocks, html, text })
  }

  return (
    <div className="bento-designer">
      <div className="bento-designer-top">
        <div className="bento-designer-fields">
          <label>
            Template name
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="e.g. Intro — founders" />
          </label>
          <label>
            Subject
            <input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={200} placeholder="e.g. Quick question, {{first_name}}" />
          </label>
        </div>
        <div className="bento-designer-sample">
          <span>Preview as</span>
          <label>
            First name
            <input value={sampleLead.first_name} onChange={(event) => setSampleLead((current) => ({ ...current, first_name: event.target.value }))} maxLength={100} />
          </label>
          <label>
            Company
            <input value={sampleLead.company} onChange={(event) => setSampleLead((current) => ({ ...current, company: event.target.value }))} maxLength={150} />
          </label>
          <span className="bento-designer-sample-note">Sample values only — the real preview uses a lead from your workspace.</span>
        </div>
      </div>

      {error && (
        <div className="bento-notice-error" role="alert">
          {error}
        </div>
      )}

      <div className="bento-designer-grid">
        <div className="bento-designer-blocks">
          <h3>Blocks</h3>
          <div className="bento-designer-add">
            <button type="button" onClick={() => addBlock('heading')}><BentoIcon name="heading" size={14} /> Heading</button>
            <button type="button" onClick={() => addBlock('text')}><BentoIcon name="type" size={14} /> Text</button>
            <button type="button" onClick={() => addBlock('image')}><BentoIcon name="image" size={14} /> Image</button>
            <button type="button" onClick={() => addBlock('button')}><BentoIcon name="mouse" size={14} /> Button</button>
            <button type="button" onClick={() => addBlock('divider')}><BentoIcon name="minus" size={14} /> Divider</button>
            <button type="button" onClick={() => addBlock('spacer')}><BentoIcon name="list" size={14} /> Spacer</button>
          </div>
          <ol className="bento-designer-list">
            {blocks.map((block, index) => (
              <li key={block.id} className={selectedId === block.id ? 'selected' : ''}>
                <button type="button" className="bento-designer-list-item" onClick={() => setSelectedId(block.id)}>
                  <BentoIcon name={block.type === 'heading' ? 'heading' : block.type === 'text' ? 'type' : block.type === 'image' ? 'image' : block.type === 'button' ? 'mouse' : block.type === 'divider' ? 'minus' : 'list'} size={14} />
                  <span>{block.type === 'heading' ? block.text || 'Heading' : block.type === 'text' ? block.text.slice(0, 28) || 'Text' : block.type === 'image' ? block.alt || 'Image' : block.type === 'button' ? block.label || 'Button' : block.type === 'divider' ? 'Divider' : `Spacer ${block.height}px`}</span>
                  <em>{index + 1}</em>
                </button>
                <span className="bento-designer-list-actions">
                  <button type="button" aria-label="Move block up" disabled={index === 0} onClick={() => moveBlock(block.id, -1)}>↑</button>
                  <button type="button" aria-label="Move block down" disabled={index === blocks.length - 1} onClick={() => moveBlock(block.id, 1)}>↓</button>
                  <button type="button" aria-label="Duplicate block" onClick={() => duplicateBlock(block.id)}><BentoIcon name="copy" size={13} /></button>
                  <button type="button" aria-label="Delete block" onClick={() => removeBlock(block.id)}><BentoIcon name="trash" size={13} /></button>
                </span>
              </li>
            ))}
          </ol>
          {blocks.length === 0 && <p className="bento-designer-hint">No blocks yet — add one above to start designing.</p>}
        </div>

        <div className="bento-designer-canvas-wrap">
          <div className="bento-designer-canvas-head">
            <h3>Live preview</h3>
            <div className="bento-designer-toggle" role="group" aria-label="Preview format">
              <button type="button" className={!showText ? 'active' : ''} onClick={() => setShowText(false)}>Designed</button>
              <button type="button" className={showText ? 'active' : ''} onClick={() => setShowText(true)}>Plain text</button>
            </div>
          </div>
          <div className="bento-designer-canvas">
            {showText ? (
              <pre>{resolveVariables(text, sampleLead)}</pre>
            ) : (
              <div className="bento-designer-email">
                {subject && <p className="bento-designer-subject">{resolveVariables(subject, sampleLead)}</p>}
                {blocks.map((block) => (
                  <div key={block.id} className={selectedId === block.id ? 'bento-designer-block selected' : 'bento-designer-block'} onClick={() => setSelectedId(block.id)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') setSelectedId(block.id) }}>
                    <BlockCanvas block={block} lead={sampleLead} imageUrls={imageUrls} />
                  </div>
                ))}
                {blocks.length === 0 && <p className="bento-designer-hint">Your design will appear here.</p>}
              </div>
            )}
          </div>
          <p className="bento-designer-note">Variables {'{{first_name}}'} and {'{{company}}'} resolve per lead when the email is sent. The plain-text version is always sent alongside the designed version.</p>
        </div>

        <div className="bento-designer-inspector">
          <h3>Block settings</h3>
          {!selected && <p className="bento-designer-hint">Select a block to edit its colours, size and content.</p>}
          {selected?.type === 'heading' && (
            <div className="bento-inspector-fields">
              <label>Text<textarea value={selected.text} onChange={(event) => updateBlock(selected.id, { text: event.target.value })} maxLength={200} rows={2} /></label>
              <label>Size<select value={selected.size} onChange={(event) => updateBlock(selected.id, { size: event.target.value as 'small' | 'medium' | 'large' })}><option value="small">Small — 20px</option><option value="medium">Medium — 28px</option><option value="large">Large — 36px</option></select></label>
              <label>Colour<span className="bento-color-row"><input type="color" value={selected.color} onChange={(event) => updateBlock(selected.id, { color: event.target.value })} /><input value={selected.color} onChange={(event) => updateBlock(selected.id, { color: event.target.value })} maxLength={7} /></span></label>
              <label>Align<span className="bento-align-row">{(['left', 'center', 'right'] as const).map((align) => <button type="button" key={align} className={selected.align === align ? 'active' : ''} onClick={() => updateBlock(selected.id, { align })}>{align}</button>)}</span></label>
            </div>
          )}
          {selected?.type === 'text' && (
            <div className="bento-inspector-fields">
              <label>Text<textarea value={selected.text} onChange={(event) => updateBlock(selected.id, { text: event.target.value })} maxLength={5000} rows={6} /></label>
              <label>Font size<input type="number" min={12} max={20} value={selected.size} onChange={(event) => updateBlock(selected.id, { size: Number(event.target.value) })} /></label>
              <label>Colour<span className="bento-color-row"><input type="color" value={selected.color} onChange={(event) => updateBlock(selected.id, { color: event.target.value })} /><input value={selected.color} onChange={(event) => updateBlock(selected.id, { color: event.target.value })} maxLength={7} /></span></label>
              <label>Align<span className="bento-align-row">{(['left', 'center', 'right'] as const).map((align) => <button type="button" key={align} className={selected.align === align ? 'active' : ''} onClick={() => updateBlock(selected.id, { align })}>{align}</button>)}</span></label>
            </div>
          )}
          {selected?.type === 'image' && (
            <div className="bento-inspector-fields">
              <label>Upload image<input type="file" accept="image/png,image/jpeg" disabled={uploading} onChange={(event) => void handleImageFile(selected.id, event.target.files?.[0] ?? null)} /></label>
              {uploading && <p className="bento-designer-hint">Uploading image…</p>}
              <label>Or image URL<input value={selected.src} onChange={(event) => updateBlock(selected.id, { src: event.target.value, fileId: null })} placeholder="https://…" maxLength={500} /></label>
              <label>Alt text<input value={selected.alt} onChange={(event) => updateBlock(selected.id, { alt: event.target.value })} maxLength={200} placeholder="Describe the image" /></label>
              <label>Width<select value={selected.width} onChange={(event) => updateBlock(selected.id, { width: Number(event.target.value) })}><option value={25}>25%</option><option value={50}>50%</option><option value={75}>75%</option><option value={100}>100%</option></select></label>
              <label>Align<span className="bento-align-row">{(['left', 'center', 'right'] as const).map((align) => <button type="button" key={align} className={selected.align === align ? 'active' : ''} onClick={() => updateBlock(selected.id, { align })}>{align}</button>)}</span></label>
              <p className="bento-designer-hint">Uploads go to your workspace’s private files (PNG or JPEG, up to 10 MB). Uploaded images are served to recipients from the template image link.</p>
            </div>
          )}
          {selected?.type === 'button' && (
            <div className="bento-inspector-fields">
              <label>Label<input value={selected.label} onChange={(event) => updateBlock(selected.id, { label: event.target.value })} maxLength={80} /></label>
              <label>Link URL<input value={selected.url} onChange={(event) => updateBlock(selected.id, { url: event.target.value })} placeholder="https://…" maxLength={500} /></label>
              <label>Background<span className="bento-color-row"><input type="color" value={selected.background} onChange={(event) => updateBlock(selected.id, { background: event.target.value })} /><input value={selected.background} onChange={(event) => updateBlock(selected.id, { background: event.target.value })} maxLength={7} /></span></label>
              <label>Text colour<span className="bento-color-row"><input type="color" value={selected.color} onChange={(event) => updateBlock(selected.id, { color: event.target.value })} /><input value={selected.color} onChange={(event) => updateBlock(selected.id, { color: event.target.value })} maxLength={7} /></span></label>
              <label>Align<span className="bento-align-row">{(['left', 'center', 'right'] as const).map((align) => <button type="button" key={align} className={selected.align === align ? 'active' : ''} onClick={() => updateBlock(selected.id, { align })}>{align}</button>)}</span></label>
            </div>
          )}
          {selected?.type === 'divider' && (
            <div className="bento-inspector-fields">
              <label>Colour<span className="bento-color-row"><input type="color" value={selected.color} onChange={(event) => updateBlock(selected.id, { color: event.target.value })} /><input value={selected.color} onChange={(event) => updateBlock(selected.id, { color: event.target.value })} maxLength={7} /></span></label>
            </div>
          )}
          {selected?.type === 'spacer' && (
            <div className="bento-inspector-fields">
              <label>Height (px)<input type="number" min={8} max={80} value={selected.height} onChange={(event) => updateBlock(selected.id, { height: Number(event.target.value) })} /></label>
            </div>
          )}
        </div>
      </div>

      <div className="bento-designer-actions">
        {onCancel && <button type="button" className="bento-btn-outline" onClick={onCancel}>Cancel</button>}
        <button type="button" className="bento-btn-dark" disabled={saving || uploading} onClick={() => void handleSave()}>
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Save template'}
        </button>
      </div>
    </div>
  )
}
