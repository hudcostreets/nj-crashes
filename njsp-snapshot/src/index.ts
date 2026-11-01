import { GitHub } from './github'
import { DEFAULT_CONFIG, loadState, runTick, type Config } from './snapshot'
import { postSlack } from './slack'

export interface Env {
  STATE: KVNamespace
  /** Fine-grained PAT (hudcostreets/nj-crashes: Contents RW, Actions RW). Secret; unset → anonymous reads (local DRY_RUN). */
  GH_TOKEN?: string
  /** Secret. */
  SLACK_BOT_TOKEN?: string
  SLACK_CI_CHANNEL_ID: string
  GH_REPO: string
  GH_BRANCH: string
  GH_WORKFLOW: string
  COMMIT_AUTHOR_NAME: string
  COMMIT_AUTHOR_EMAIL: string
  /** "1" → do everything except write to GitHub / Slack. */
  DRY_RUN?: string
  /** "0" → commit but don't dispatch the daily (staging). */
  DISPATCH?: string
  /** Prefixed to Slack alerts (e.g. "[staging] "). */
  ALERT_PREFIX?: string
}

function config(env: Env): Config {
  return {
    ...DEFAULT_CONFIG,
    author: { name: env.COMMIT_AUTHOR_NAME, email: env.COMMIT_AUTHOR_EMAIL },
    dryRun: env.DRY_RUN === '1' || env.DRY_RUN === 'true',
    dispatch: env.DISPATCH !== '0' && env.DISPATCH !== 'false',
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const cfg = config(env)
    const state = await runTick({
      repo: new GitHub(env.GH_TOKEN ?? '', env.GH_REPO, env.GH_BRANCH, env.GH_WORKFLOW),
      upstream: (input, init) => fetch(input, init),
      kv: env.STATE,
      alert: async text => {
        if (!env.SLACK_BOT_TOKEN) throw new Error(`SLACK_BOT_TOKEN unset; alert: ${text}`)
        await postSlack(env.SLACK_BOT_TOKEN, env.SLACK_CI_CHANNEL_ID, `${env.ALERT_PREFIX ?? ''}${text}`)
      },
      now: new Date(controller.scheduledTime),
      config: cfg,
      log: msg => console.log(msg),
    })
    console.log(JSON.stringify(state.lastTick))
  },

  /** Read-only status: the persisted tick state (no secrets in it). */
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (req.method !== 'GET' || url.pathname !== '/') return new Response('Not found', { status: 404 })
    const state = await loadState(env.STATE)
    return Response.json({ dryRun: config(env).dryRun, ...state })
  },
} satisfies ExportedHandler<Env>
