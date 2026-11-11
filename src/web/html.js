const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escape a value for use in HTML text or a double-quoted attribute. */
export const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ENTITIES[character])

/**
 * Tagged template that escapes every interpolated value. Wrap markup that is
 * already safe in `raw()`; arrays are joined, and null, undefined and false render nothing.
 */
export function html(strings, ...values) {
  const render = value => {
    if (value === null || value === undefined || value === false) return ''
    if (Array.isArray(value)) return value.map(render).join('')
    return value instanceof SafeHtml ? value.markup : escapeHtml(value)
  }
  return new SafeHtml(strings.reduce((out, part, index) => out + render(values[index - 1]) + part))
}

class SafeHtml {
  constructor(markup) { this.markup = markup }
  toString() { return this.markup }
}

export const raw = markup => new SafeHtml(markup)
