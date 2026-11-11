/**
 * Mulqi Context Compression: mechanical (zero-LLM) fold digest.
 *
 * Pure template digest used by the auto fold engine in `mechanical` mode:
 * no LLM call, no provider cost. It shapes the shadowed conversation into
 * the doctrine's "TASK AS OF THIS BLOCK" skeleton with the doctrine's
 * priority order (goal > decisions > artifacts > conclusions > lessons).
 *
 * Input is the host summarizer's replay shape: a `SummarizationInput`
 * ({ tools?, messages: Message[] }) whose leading message may be the
 * conversation's system head. The digest keeps exact values (paths,
 * errors, hashes, ports) verbatim and drops everything else; the output
 * is bounded so it always fits the tier-1 block cap.
 */

import { estimateTokens } from './fold.js'

/** Default digest budget in approximate tokens (well under the tier-1 cap). */
export const MECHANICAL_DIGEST_CAP = 1500

/** Normalize one LLM message content (string or content blocks) to text. */
export function messageText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object') {
          if (typeof b.text === 'string') return b.text
          if (b.type === 'toolCall' || b.type === 'tool-call') return `[tool-call ${b.name ?? '?'}]`
          if (b.type === 'image') return '[image]'
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return content == null ? '' : String(content)
}

function clip(text, maxChars) {
  const t = String(text ?? '').trim()
  if (t.length <= maxChars) return t
  return `${t.slice(0, maxChars)}...`
}

const DIRECTIVE_RE = /(^|\n)\s*(please\s|must\s|do not\s|don't\s|stop\s|change\s|make it|fix\b|update\b|add\b|remove\b|use\b|kerjakan|jangan|buat|perbaiki|ganti)\b/i
const ERROR_RE = /\b(error|failed|failure|exception|panic|traceback|errno|fatal|refused|rejected|ENOENT|EACCES|429|5\d\d)\b/i
const ARTIFACT_RE =
  /[A-Za-z0-9_.@/-]+(?:\.(?:js|mjs|cjs|ts|tsx|jsx|json|ya?ml|toml|md|py|go|rs|java|c|cpp|h|hpp|sh|ps1|cs|lua|html|css|vue|svelte|patch|diff|sql|xml))\b|https?:\/\/[^\s"'`)+]+|\bport[:\s]+\d{2,5}\b|\b[0-9a-f]{7,40}\b|\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/g

/**
 * Build the mechanical digest of one shadowed conversation region.
 * @param {{ messages?: unknown[], tools?: unknown[] }} input the host summarizer input.
 * @param {{ capTokens?: number }} [options] digest budget in approximate tokens.
 * @returns {{ digest: string, tokens: number }} bounded digest text and its estimate.
 */
export function buildMechanicalDigest(input, options = {}) {
  const cap = Number(options?.capTokens) > 0 ? Number(options.capTokens) : MECHANICAL_DIGEST_CAP
  const raw = Array.isArray(input?.messages) ? input.messages : []
  // A leading system head (the conversation's own derived head, when present)
  // is framing, not task content: it never enters the digest.
  const region = raw.length > 0 && raw[0]?.role === 'system' ? raw.slice(1) : raw

  const users = []
  const assistants = []
  const tools = []
  for (const m of region) {
    if (m == null || typeof m !== 'object') continue
    const text = messageText(m.content ?? m.text ?? '')
    if (text.length === 0) continue
    if (m.role === 'user') users.push(text)
    else if (m.role === 'assistant') assistants.push(text)
    else tools.push(text)
  }

  const goal = users.length > 0 ? clip(users[0], 500) : '(none)'
  const directives = []
  for (const u of users.slice(1)) {
    if (DIRECTIVE_RE.test(u)) directives.push(clip(u, 300))
    if (directives.length >= 6) break
  }
  const errors = []
  for (const t of tools) {
    for (const line of t.split('\n')) {
      if (line.length > 0 && ERROR_RE.test(line)) errors.push(clip(line.trim(), 240))
      if (errors.length >= 8) break
    }
    if (errors.length >= 8) break
  }
  const seen = new Set()
  const artifacts = []
  for (const text of [...users, ...assistants, ...tools]) {
    for (const hit of String(text).match(ARTIFACT_RE) ?? []) {
      const norm = hit.trim()
      if (norm.length < 3 || seen.has(norm)) continue
      seen.add(norm)
      artifacts.push(norm)
      if (artifacts.length >= 30) break
    }
    if (artifacts.length >= 30) break
  }
  const finalState = assistants.length > 0 ? clip(assistants[assistants.length - 1], 700) : '(none)'
  const lastUser = users.length > 0 ? users[users.length - 1] : ''
  const open = /\?|open question|\btodo\b|\btbd\b|belum selesai/i.test(lastUser)
    ? clip(lastUser, 300)
    : ''

  // Priority order on a tight budget: goal > final state > directives >
  // errors > artifacts > open. Sections are dropped in reverse priority.
  const sections = [
    ['Goal', goal],
    ['Final state', finalState],
    ['Directives', directives.length > 0 ? directives.map((d) => `- ${d}`).join('\n') : '(none)'],
    ['Errors and failures', errors.length > 0 ? errors.map((e) => `- ${e}`).join('\n') : '(none)'],
    ['Artifacts', artifacts.length > 0 ? artifacts.join(' · ') : '(none)'],
    ['Open', open ? `- ${open}` : '(none)'],
  ]
  const render = (keepCount) =>
    ['TASK AS OF THIS BLOCK (auto mechanical digest)', '']
      .concat(sections.slice(0, keepCount).flatMap(([name, body]) => [`## ${name}`, String(body), '']))
      .concat('generated by mulqi-context-compression without an LLM call')
      .join('\n')
      .trimEnd()

  let out = render(sections.length)
  let keep = sections.length
  while (estimateTokens(out) > cap && keep > 1) {
    keep -= 1
    out = render(keep)
  }
  if (estimateTokens(out) > cap) out = clip(out, cap * 4)
  return { digest: out, tokens: estimateTokens(out) }
}
