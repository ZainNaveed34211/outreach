import type { EmailTemplate } from './types'

export function TemplatePicker({
  templates,
  value,
  onSelect,
  disabled,
}: {
  templates: EmailTemplate[]
  value?: string | null
  onSelect: (template: EmailTemplate) => void
  disabled?: boolean
}) {
  if (templates.length === 0) {
    return (
      <p className="bento-picker-empty">
        No saved templates yet. <a href="/dashboard/templates/">Design one in Templates</a>, then pick it here.
      </p>
    )
  }
  return (
    <label className="bento-picker">
      <span>Use a saved template</span>
      <select
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => {
          const template = templates.find((item) => item.id === event.target.value)
          if (template) onSelect(template)
        }}
      >
        <option value="">Choose a template…</option>
        {templates.map((template) => (
          <option value={template.id} key={template.id}>
            {template.name}{template.subject ? ` — ${template.subject}` : ''}
          </option>
        ))}
      </select>
      <small>Inserting a template replaces this step’s message with the template’s text version. The designed HTML is stored on the step alongside it, and variables like {'{{first_name}}'} still resolve per lead.</small>
    </label>
  )
}
