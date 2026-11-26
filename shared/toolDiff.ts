/**
 * Turns a stored file-editing tool call back into before/after text so the UI can show
 * a diff. The index keeps tool calls as readable text (see `summarizeToolUse`):
 *
 *   [도구] Edit · description
 *   file_path: /src/App.tsx
 *   old_string:
 *   …multi-line value…
 *   new_string: single-line value
 *   replace_all: false
 *
 * Keys are written in the tool's input order, so a value runs until the next known key.
 */

export type FileEdit = { oldText: string; newText: string }
export type ToolEdit = {
  tool: 'Edit' | 'MultiEdit' | 'Write' | 'NotebookEdit'
  filePath: string
  edits: FileEdit[]
  /** Write replaces the whole file; there is no "before". */
  isCreate: boolean
}

const KNOWN_KEYS: Record<ToolEdit['tool'], string[]> = {
  Edit: ['file_path', 'old_string', 'new_string', 'replace_all'],
  MultiEdit: ['file_path', 'edits'],
  Write: ['file_path', 'content'],
  NotebookEdit: ['notebook_path', 'cell_id', 'new_source', 'cell_type', 'edit_mode'],
}

/** Splits one tool block into `key → value` using the known key names as boundaries. */
function readFields(lines: string[], keys: string[]): Map<string, string> {
  const fields = new Map<string, string>()
  const keyLine = new RegExp(`^(${keys.join('|')}):(?: (.*))?$`)
  let current: string | null = null
  let buf: string[] = []
  const commit = () => {
    if (current != null) fields.set(current, buf.join('\n'))
  }
  for (const line of lines) {
    const m = line.match(keyLine)
    // A key only starts a field once: repeated text inside a value stays a value.
    if (m && !fields.has(m[1]) && m[1] !== current) {
      commit()
      current = m[1]
      buf = m[2] != null ? [m[2]] : []
    } else if (current != null) {
      buf.push(line)
    }
  }
  commit()
  return fields
}

/** Every file edit in a stored assistant message (one message may hold several tool calls). */
export function parseToolEdits(body: string): ToolEdit[] {
  const out: ToolEdit[] = []
  const blocks = body.split(/^(?=\[도구\] )/m)
  for (const block of blocks) {
    const head = block.match(/^\[도구\] (Edit|MultiEdit|Write|NotebookEdit)(?: · .*)?$/m)
    if (!head || block.indexOf(head[0]) !== 0) continue
    const tool = head[1] as ToolEdit['tool']
    const lines = block.slice(head[0].length).replace(/^\n/, '').replace(/\n+$/, '').split('\n')
    const f = readFields(lines, KNOWN_KEYS[tool])
    const filePath = (f.get('file_path') ?? f.get('notebook_path') ?? '').trim()
    if (!filePath) continue
    if (tool === 'Edit') {
      if (!f.has('old_string') && !f.has('new_string')) continue
      out.push({ tool, filePath, isCreate: false, edits: [{ oldText: f.get('old_string') ?? '', newText: f.get('new_string') ?? '' }] })
    } else if (tool === 'MultiEdit') {
      try {
        const arr = JSON.parse(f.get('edits') ?? '[]') as { old_string?: unknown; new_string?: unknown }[]
        const edits = arr
          .filter((e) => e && typeof e === 'object')
          .map((e) => ({ oldText: String(e.old_string ?? ''), newText: String(e.new_string ?? '') }))
        if (edits.length) out.push({ tool, filePath, isCreate: false, edits })
      } catch {
        /* edits that are not JSON cannot be shown as a diff */
      }
    } else if (tool === 'Write') {
      out.push({ tool, filePath, isCreate: true, edits: [{ oldText: '', newText: f.get('content') ?? '' }] })
    } else {
      out.push({ tool, filePath, isCreate: false, edits: [{ oldText: '', newText: f.get('new_source') ?? '' }] })
    }
  }
  return out
}

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

/** Above this many cells the LCS table is skipped and the change is shown as all-removed / all-added. */
const MAX_LCS_CELLS = 2_000_000

/** Line diff by longest common subsequence; good enough for the edit-sized hunks tools send. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  // Trim the common head and tail first: most edits touch a few lines in the middle.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const am = a.slice(head, a.length - tail)
  const bm = b.slice(head, b.length - tail)
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: 'same' as const, text }))
  if ((am.length + 1) * (bm.length + 1) > MAX_LCS_CELLS) {
    for (const text of am) out.push({ kind: 'del', text })
    for (const text of bm) out.push({ kind: 'add', text })
  } else {
    const n = am.length
    const m = bm.length
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        out.push({ kind: 'same', text: am[i] })
        i++
        j++
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ kind: 'del', text: am[i++] })
      } else {
        out.push({ kind: 'add', text: bm[j++] })
      }
    }
    while (i < n) out.push({ kind: 'del', text: am[i++] })
    while (j < m) out.push({ kind: 'add', text: bm[j++] })
  }
  for (const text of a.slice(a.length - tail)) out.push({ kind: 'same', text })
  return out
}
