import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// These integration tests opt into one extracted/installed official runtime.
// No profile is booted, and no packages are installed or copied into this repo.
export function useOfficialDependencies(root = process.env.DSH_OFFICIAL_ROOT) {
  if (!root) return { skip: 'Set DSH_OFFICIAL_ROOT to an official dsh runtime directory' }
  root = resolve(root)
  const manifest = join(root, 'node_modules', '@deepseek-ai', 'cordis', 'package.json')
  if (!existsSync(manifest)) throw new Error(`DSH_OFFICIAL_ROOT has no official Cordis package: ${root}`)
  const parentURL = pathToFileURL(join(root, 'package.json')).href
  const resolvedUrls = new Set()
  const hook = registerHooks({ resolve(specifier, context, next) {
    // Calling require.resolve() here would recursively enter this same hook.
    const result = next(specifier, specifier.startsWith('@deepseek-ai/')
      ? { ...context, parentURL } : context)
    resolvedUrls.add(result.url)
    return result
  } })
  return { root, resolvedUrls, dispose: () => hook.deregister(), skip: false }
}

// A subprocess capability seam, not a mock executor or mock Cordis runtime.
// The official executor still resolves, confines, spawns, and decorates results;
// spawn only records the envelope and never starts a host command or PTY.
export function recordingSubprocess() {
  const calls = []
  const reader = text => ({ readFrom(offset = 0) {
    const bytes = Buffer.from(text)
    return { text: bytes.subarray(offset).toString(), nextOffset: bytes.length, lossy: false }
  } })
  return { calls, spawn(spec) {
    calls.push(spec)
    return {
      collected: { stdout: reader('official-result\n'), stderr: reader('') },
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate() {},
    }
  } }
}
