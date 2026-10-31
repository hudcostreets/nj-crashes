/** `chat.postMessage` (same bot + channel as `.github/scripts/notify-ci-failure.sh`). */
export async function postSlack(token: string, channel: string, text: string, fetch_: typeof fetch = (input, init) => fetch(input, init)): Promise<void> {
  const res = await fetch_('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
  })
  const body = await res.json() as { ok?: boolean, error?: string }
  if (!body.ok) throw new Error(`Slack chat.postMessage failed: ${body.error ?? res.status}`)
}
