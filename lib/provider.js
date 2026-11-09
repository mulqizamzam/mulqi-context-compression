/**
 * Mulqi Context Compression — bundled skill provider.
 *
 * One skill (`mulqi-context-compression`): the compression doctrine that
 * makes the fold executable by the model. The catalog entry is DERIVED at
 * runtime from the shipped SKILL.md frontmatter (never hardcoded), so a
 * doc edit changes the catalog text in lockstep.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const PROVIDER_NAME = 'mulqi-context-compression'
export const SKILL_NAME = 'mulqi-context-compression'
/** DSH bundled-skill rank (platform constant BUNDLED_SKILL_RANK = 600). */
export const BUNDLED_SKILL_RANK = 600

const SKILL_FILE_URL = new URL('../skills/mulqi-context-compression/SKILL.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../skills/mulqi-context-compression/', import.meta.url)),
}
const INVOCATION = Object.freeze({ modelInvocable: true, userInvocable: true })

/**
 * Minimal YAML frontmatter reader (plain scalars + folded/literal blocks).
 * No dependency; tolerant, never throws.
 * @param {string} raw
 * @returns {{ name?: string, description?: string, body: string }}
 */
export function parseFrontmatter(raw) {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return { name: undefined, description: undefined, body: raw }
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine.trim() !== '---') return { name: undefined, description: undefined, body: raw }

  // Walk lines with offsets to locate the closing fence precisely.
  const lines = []
  let pos = firstLineEnd + 1
  let closePos = -1
  while (pos <= raw.length) {
    const nl = raw.indexOf('\n', pos)
    const end = nl < 0 ? raw.length : nl
    const text = raw.slice(pos, end).replace(/\r$/, '')
    if (text.trim() === '---') {
      closePos = pos
      break
    }
    lines.push({ text, start: pos })
    if (nl < 0) break
    pos = nl + 1
  }
  if (closePos < 0) return { name: undefined, description: undefined, body: raw }
  const bodyStart = raw.indexOf('\n', closePos)
  const body = bodyStart < 0 ? '' : raw.slice(bodyStart + 1)

  const fields = { name: undefined, description: undefined }
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i].text)
    if (!m) continue
    let value = m[2].trim()
    if (value === '>-' || value === '>' || value === '|' || value === '|-' || value === '|>') {
      const literal = value.startsWith('|')
      const block = []
      i += 1
      while (i < lines.length && (/^\s/.test(lines[i].text) || lines[i].text.trim() === '')) {
        block.push(lines[i].text.trim())
        i += 1
      }
      i -= 1
      value = literal ? block.join('\n') : block.join(' ')
    }
    value = value.replace(/^["']/, '').replace(/["']$/, '').trim()
    fields[m[1]] = value
  }
  return { ...fields, body }
}

/** Strip the leading YAML frontmatter block; returns the body only. */
export function stripFrontmatter(raw) {
  return parseFrontmatter(raw).body
}

function buildCandidate(parsed) {
  const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : SKILL_NAME
  const description =
    typeof parsed.description === 'string' && parsed.description.trim()
      ? parsed.description.trim()
      : 'Mulqi Context Compression: model-driven, incremental, hierarchical context compression (the fold) for long-lived agent sessions.'
  return {
    name,
    description,
    invocation: INVOCATION,
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase: RESOURCE_BASE,
    rank: BUNDLED_SKILL_RANK,
    locator: SKILL_FILE_URL,
  }
}

/** @returns {object} a DSH SkillProvider. */
export function makeProvider() {
  return {
    name: PROVIDER_NAME,
    async list() {
      const raw = await readFile(SKILL_FILE_URL, 'utf8')
      return [buildCandidate(parseFrontmatter(raw))]
    },
    async get(_candidate, _options) {
      const raw = await readFile(SKILL_FILE_URL, 'utf8')
      const parsed = parseFrontmatter(raw)
      const cand = buildCandidate(parsed)
      return {
        name: cand.name,
        description: cand.description,
        invocation: cand.invocation,
        provider: cand.provider,
        source: cand.source,
        resourceBase: cand.resourceBase,
        content: parsed.body.trim(),
      }
    },
  }
}
