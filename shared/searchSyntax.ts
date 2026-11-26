/**
 * Inline search operators, so filters can be typed instead of clicked:
 *
 *   project:trove  branch:main  role:me|user|assistant  tag:bug
 *   after:2026-10-01  before:2026-11-01  is:archived  is:live
 *   /regex/          (the whole query as a JavaScript regular expression)
 *
 * Unknown `word:value` tokens stay in the text, so a query like `http://…` or
 * `TODO:` still searches for itself. Quoted values work: `project:"my app"`.
 */

export type ParsedQuery = {
  /** What is left for full-text search. */
  text: string
  project?: string
  branch?: string
  role?: 'user' | 'assistant'
  tag?: string
  /** Local-midnight epoch ms. `before` is exclusive of the named day's end (end of day). */
  sinceMs?: number
  untilMs?: number
  archived?: 'archived' | 'live'
  /** Source of a `/…/flags` query; validated with `isValidRegex`. */
  regex?: string
  regexFlags?: string
  /** The operators that were recognised, for display as chips. */
  operators: { key: string; value: string }[]
}

const OPERATOR = /(^|\s)(project|branch|role|tag|after|before|is):("([^"]*)"|(\S+))/gi

/** Local midnight of `YYYY-MM-DD` (or `YYYY-MM`, `YYYY`), or null. */
export function parseDay(v: string, endOfPeriod = false): number | null {
  const m = v.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/)
  if (!m) return null
  const y = Number(m[1])
  const mo = m[2] ? Number(m[2]) - 1 : 0
  const d = m[3] ? Number(m[3]) : 1
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null
  if (!endOfPeriod) return new Date(y, mo, d).getTime()
  // End of the named period: the next day / month / year, minus one millisecond.
  const next = m[3] ? new Date(y, mo, d + 1) : m[2] ? new Date(y, mo + 1, 1) : new Date(y + 1, 0, 1)
  return next.getTime() - 1
}

export function isValidRegex(source: string, flags = ''): boolean {
  try {
    new RegExp(source, flags)
    return true
  } catch {
    return false
  }
}

export function parseSearchQuery(raw: string): ParsedQuery {
  const out: ParsedQuery = { text: '', operators: [] }
  const trimmed = raw.trim()
  const rx = trimmed.match(/^\/(.+)\/([imsu]*)$/s)
  if (rx) {
    out.regex = rx[1]
    out.regexFlags = rx[2]
    out.text = ''
    return out
  }
  const text = raw.replace(OPERATOR, (whole, lead: string, key: string, _v, quoted?: string, bare?: string) => {
    const value = (quoted ?? bare ?? '').trim()
    const k = key.toLowerCase()
    let used = true
    switch (k) {
      case 'project':
        if (value) out.project = value
        else used = false
        break
      case 'branch':
        if (value) out.branch = value
        else used = false
        break
      case 'tag':
        if (value) out.tag = value
        else used = false
        break
      case 'role': {
        const r = value.toLowerCase()
        if (r === 'me' || r === 'user' || r === '나') out.role = 'user'
        else if (r === 'assistant' || r === 'claude' || r === 'ai') out.role = 'assistant'
        else used = false
        break
      }
      case 'after': {
        const ms = parseDay(value)
        if (ms != null) out.sinceMs = ms
        else used = false
        break
      }
      case 'before': {
        const ms = parseDay(value, true)
        if (ms != null) out.untilMs = ms
        else used = false
        break
      }
      case 'is': {
        const v = value.toLowerCase()
        if (v === 'archived' || v === '보관') out.archived = 'archived'
        else if (v === 'live' || v === '원본') out.archived = 'live'
        else used = false
        break
      }
      default:
        used = false
    }
    if (!used) return whole
    out.operators.push({ key: k, value })
    return lead
  })
  out.text = text.replace(/\s+/g, ' ').trim()
  return out
}
