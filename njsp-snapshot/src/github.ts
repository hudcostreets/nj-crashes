/** Minimal GitHub REST client: the Contents / Git Data / Actions calls the snapshot tick needs. */

export type Head = { sha: string, treeSha: string }
export type FileChange = { path: string, content: Uint8Array }
export type Person = { name: string, email: string }
export type Run = {
  id: number
  status: string
  conclusion: string | null
  event: string
  createdAt: string
  headSha: string
  url: string
}

/** What `runTick` needs from GitHub; `GitHub` implements it over REST, tests fake it. */
export interface Repo {
  head(): Promise<Head>
  /** File bytes at `ref`, or null if absent. */
  readFile(path: string, ref: string): Promise<Uint8Array | null>
  /** One commit on top of `parent`, fast-forwarding the branch; `null` if the branch moved (non-FF). */
  commit(parent: Head, files: FileChange[], message: string, author: Person): Promise<string | null>
  /** The workflow's most recent runs (newest first). */
  runs(): Promise<Run[]>
  dispatch(): Promise<void>
}

const API = 'https://api.github.com'

function b64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

export class GitHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export class GitHub implements Repo {
  constructor(
    readonly token: string,
    readonly repo: string,
    readonly branch: string,
    readonly workflow: string,
    readonly fetch_: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async req(method: string, path: string, body?: unknown, accept = 'application/vnd.github+json'): Promise<Response> {
    return await this.fetch_(`${API}${path}`, {
      method,
      headers: {
        Accept: accept,
        // Token-less (public reads only) for local `DRY_RUN` dev without the secret.
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        'User-Agent': 'njsp-snapshot-worker',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.req(method, path, body)
    if (!res.ok) {
      throw new GitHubError(res.status, `${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`)
    }
    return await res.json() as T
  }

  async head(): Promise<Head> {
    const ref = await this.json<{ object: { sha: string } }>('GET', `/repos/${this.repo}/git/ref/heads/${this.branch}`)
    const sha = ref.object.sha
    const commit = await this.json<{ tree: { sha: string } }>('GET', `/repos/${this.repo}/git/commits/${sha}`)
    return { sha, treeSha: commit.tree.sha }
  }

  async readFile(path: string, ref: string): Promise<Uint8Array | null> {
    const res = await this.req('GET', `/repos/${this.repo}/contents/${path}?ref=${ref}`, undefined, 'application/vnd.github.raw+json')
    if (res.status === 404) return null
    if (!res.ok) throw new GitHubError(res.status, `GET contents/${path}@${ref}: ${res.status} ${(await res.text()).slice(0, 300)}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async commit(parent: Head, files: FileChange[], message: string, author: Person): Promise<string | null> {
    const tree = []
    for (const { path, content } of files) {
      const blob = await this.json<{ sha: string }>('POST', `/repos/${this.repo}/git/blobs`, { content: b64(content), encoding: 'base64' })
      tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
    }
    const newTree = await this.json<{ sha: string }>('POST', `/repos/${this.repo}/git/trees`, { base_tree: parent.treeSha, tree })
    const commit = await this.json<{ sha: string }>('POST', `/repos/${this.repo}/git/commits`, {
      message,
      tree: newTree.sha,
      parents: [parent.sha],
      author,
      committer: author,
    })
    const res = await this.req('PATCH', `/repos/${this.repo}/git/refs/heads/${this.branch}`, { sha: commit.sha, force: false })
    // 422 "Update is not a fast forward": someone else pushed since `head()`.
    if (res.status === 422) return null
    if (!res.ok) throw new GitHubError(res.status, `PATCH ref: ${res.status} ${(await res.text()).slice(0, 300)}`)
    return commit.sha
  }

  async runs(): Promise<Run[]> {
    type R = { id: number, status: string, conclusion: string | null, event: string, created_at: string, head_sha: string, html_url: string }
    const res = await this.json<{ workflow_runs: R[] }>(
      'GET', `/repos/${this.repo}/actions/workflows/${this.workflow}/runs?branch=${this.branch}&per_page=20`,
    )
    return res.workflow_runs.map(r => ({
      id: r.id,
      status: r.status,
      conclusion: r.conclusion,
      event: r.event,
      createdAt: r.created_at,
      headSha: r.head_sha,
      url: r.html_url,
    }))
  }

  async dispatch(): Promise<void> {
    const res = await this.req('POST', `/repos/${this.repo}/actions/workflows/${this.workflow}/dispatches`, { ref: this.branch })
    if (res.status !== 204 && !res.ok) {
      throw new GitHubError(res.status, `dispatch ${this.workflow}: ${res.status} ${(await res.text()).slice(0, 300)}`)
    }
  }
}
