/**
 * Secret masking for text that leaves the app (clipboard, exported files). Transcripts
 * carry tool output, and tool output carries `.env` files, tokens and keys; a shared
 * export must not. Masking is pattern-based, so it is a safety net, not a guarantee.
 */

export type RedactResult = { text: string; count: number }

const MASK = '••••'

/** Keep a short, recognisable prefix so the reader still knows what kind of value it was. */
function keepPrefix(value: string, n: number): string {
  return `${value.slice(0, n)}${MASK}`
}

type Rule = { re: RegExp; replace: (m: string, ...groups: string[]) => string }

const RULES: Rule[] = [
  // PEM private keys: the whole block goes.
  {
    re: /-----BEGIN ((?:[A-Z]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
    replace: (_m, kind) => `-----BEGIN ${kind}-----\n${MASK}\n-----END ${kind}-----`,
  },
  // Provider tokens with a recognisable shape.
  { re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replace: (m) => keepPrefix(m, 10) },
  { re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, replace: (m) => keepPrefix(m, 5) },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, replace: (m) => keepPrefix(m, 4) },
  { re: /\bgithub_pat_[A-Za-z0-9_]{30,}/g, replace: (m) => keepPrefix(m, 11) },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g, replace: (m) => keepPrefix(m, 6) },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: (m) => keepPrefix(m, 5) },
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: (m) => keepPrefix(m, 4) },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: (m) => keepPrefix(m, 4) },
  { re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: (m) => keepPrefix(m, 8) },
  { re: /\bnpm_[A-Za-z0-9]{30,}/g, replace: (m) => keepPrefix(m, 4) },
  // JSON Web Tokens.
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: () => `eyJ${MASK}`,
  },
  // Credentials inside URLs: scheme://user:password@host
  {
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]{3,})@/gi,
    replace: (_m, head) => `${head}:${MASK}@`,
  },
  // Bearer / Basic authorization headers.
  {
    re: /\b(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, head) => `${head}${MASK}`,
  },
  // KEY=value and "key": "value" where the key name says it is a secret.
  {
    re: /\b([A-Za-z0-9_.-]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"'`,;]{6,})/gi,
    replace: (m, key, sep, value) => (value.startsWith(MASK) || /^[*•x]+$/i.test(value) ? m : `${key}${sep}${MASK}`),
  },
]

/** Masks secrets in `text`. `count` is how many values were replaced. */
export function redactSecrets(text: string): RedactResult {
  let count = 0
  let out = text
  for (const rule of RULES) {
    out = out.replace(rule.re, (...args: unknown[]) => {
      const m = args[0] as string
      const groups = args.slice(1, -2).map((g) => (typeof g === 'string' ? g : ''))
      const next = rule.replace(m, ...groups)
      if (next !== m) count += 1
      return next
    })
  }
  return { text: out, count }
}
