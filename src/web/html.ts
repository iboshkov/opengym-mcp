const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Anything `html` accepts as an interpolated value. */
export type HtmlValue = string | number | boolean | null | undefined | SafeHtml | HtmlValue[]

/** Escape a value for use in HTML text or a double-quoted attribute. */
export const escapeHtml = (value: unknown): string => String(value).replace(/[&<>"']/g, character => ENTITIES[character as keyof typeof ENTITIES])

/**
 * Tagged template that escapes every interpolated value. Wrap markup that is
 * already safe in `raw()`; arrays are joined, and null, undefined and false render nothing.
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  const render = (value: HtmlValue): string => {
    if (value === null || value === undefined || value === false) return ''
    if (Array.isArray(value)) return value.map(render).join('')
    return value instanceof SafeHtml ? value.markup : escapeHtml(value)
  }
  return new SafeHtml(strings.reduce((out, part, index) => out + render(values[index - 1]) + part))
}

class SafeHtml {
  markup: string
  constructor(markup: string) { this.markup = markup }
  toString(): string { return this.markup }
}

export const raw = (markup: string): SafeHtml => new SafeHtml(markup)
