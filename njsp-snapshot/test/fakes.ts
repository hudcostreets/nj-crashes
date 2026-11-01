import type { FileChange, Head, Person, Repo, Run } from '../src/github'
import type { Kv } from '../src/snapshot'

const enc = new TextEncoder()

export type Commit = { sha: string, parent: string, message: string, author: Person, paths: string[] }

/** In-memory `main`: a file map + linear commit list. */
export class FakeRepo implements Repo {
  files = new Map<string, Uint8Array>()
  commits: Commit[] = []
  sha = 'base'
  runsList: Run[] = []
  dispatches = 0
  /** Simulate N pushes landing between `head()` and `commit()` (→ non-FF). */
  racers = 0

  constructor(files: Record<string, string | Uint8Array>) {
    for (const [path, content] of Object.entries(files)) {
      this.files.set(path, typeof content === 'string' ? enc.encode(content) : content)
    }
  }

  async head(): Promise<Head> {
    return { sha: this.sha, treeSha: `tree-${this.sha}` }
  }

  async readFile(path: string, ref: string): Promise<Uint8Array | null> {
    if (ref !== this.sha) throw new Error(`readFile at stale ref ${ref} (head ${this.sha})`)
    return this.files.get(path) ?? null
  }

  async commit(parent: Head, files: FileChange[], message: string, author: Person): Promise<string | null> {
    if (this.racers > 0) {
      this.racers -= 1
      this.sha = `racer${this.racers}`
      return null
    }
    if (parent.sha !== this.sha) return null
    for (const { path, content } of files) this.files.set(path, content)
    const sha = `c${this.commits.length + 1}`
    this.commits.push({ sha, parent: parent.sha, message, author, paths: files.map(f => f.path) })
    this.sha = sha
    return sha
  }

  async runs(): Promise<Run[]> {
    return this.runsList
  }

  async dispatch(): Promise<void> {
    this.dispatches += 1
  }

  text(path: string): string | undefined {
    const b = this.files.get(path)
    return b && new TextDecoder().decode(b)
  }
}

/** `weakGetEtag`: GET returns `W/<etag>`, as NJSP's responses do when fetched through CF's network (compressed). */
export type UpstreamFile = { etag: string, lastModified: string, content: string, contentType?: string, weakGetEtag?: boolean }

/** NJSP feed: `FAUQStats{year}.xml` → file (absent → 404). Records requests. */
export class FakeUpstream {
  calls: string[] = []
  constructor(public files: Record<number, UpstreamFile>) {}

  fetch: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const year = Number(url.match(/FAUQStats(\d{4})\.xml$/)![1])
    this.calls.push(`${method} ${year}`)
    const f = this.files[year]
    if (!f) return new Response(null, { status: 404 })
    const etag = method === 'GET' && f.weakGetEtag ? `W/${f.etag}` : f.etag
    const headers = { ETag: etag, 'Last-Modified': f.lastModified, 'Content-Type': f.contentType ?? 'text/xml' }
    return new Response(method === 'HEAD' ? null : f.content, { status: 200, headers })
  }
}

export class FakeKv implements Kv {
  map = new Map<string, string>()
  async get(key: string) { return this.map.get(key) ?? null }
  async put(key: string, value: string) { this.map.set(key, value) }
}
