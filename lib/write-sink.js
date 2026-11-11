/**
 * Mulqi Context Compression: host-readable decompress-to-file sink.
 *
 * Shared by the tools entry and the auto fold engine entry so both register
 * their fold state with the identical write policy: files land under
 * `<os tmpdir>/mulqi-cc/<sessionKey>/`, the session key is confined to one
 * safe directory name (same policy as the host's safeSessionId), and every
 * target is resolved back against its base directory before writing.
 *
 * Exclusive-create only: an existing file is never overwritten and a
 * symlink planted in the shared tmp dir is never followed (wx flag; a
 * free name is picked first).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Confine a host session identity to one safe directory name.
 * @param {unknown} key
 * @returns {string}
 */
export function safeSessionKey(key) {
  return String(key ?? 'default').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'default'
}

/**
 * Build the write sink used by fold state.
 * @returns {(fileBaseName: string, text: string, key?: string) => string} path of the written file.
 */
export function createWriteSink() {
  const base = path.resolve(tmpdir(), 'mulqi-cc')
  return (fileBaseName, text, key) => {
    const dir = path.join(base, safeSessionKey(key))
    const target = path.resolve(dir, fileBaseName)
    if (target !== dir && !target.startsWith(dir + path.sep)) {
      throw new Error('mulqi-cc: refusing to write outside the session directory')
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // pick a free name, then exclusive-create: never overwrite an existing
    // file and never follow a symlink planted in the shared tmp dir
    let free = target
    let n = 1
    while (existsSync(free)) free = path.join(dir, fileBaseName.replace(/\.txt$/, `-${n++}.txt`))
    writeFileSync(free, text, { encoding: 'utf8', flag: 'wx' })
    return free
  }
}
