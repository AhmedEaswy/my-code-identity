// Content negotiation for agents, per the "markdown for agents" convention.
//
// Browsers ask for HTML. Agents increasingly ask for Markdown because it costs
// a fraction of the tokens and carries none of the layout noise. Rather than
// run a second rendering pipeline, this hook takes the HTML the server already
// rendered and converts it at the edge of the response.
//
// The subtle parts:
//   1. `Vary: Accept` is mandatory. Without it an intermediary cache will hand
//      Markdown to a browser or HTML to an agent — whichever variant it saw
//      first.
//   2. The token counters are an estimate, not a tokenizer. They exist so an
//      agent can budget a context window before it downloads the body.
//   3. If conversion throws, the original HTML is served untouched. A broken
//      optimisation must never become a broken page.
//
// References: RFC 7231 §5.3.2 (Accept), the llmstxt.org convention.

import { NodeHtmlMarkdown } from 'node-html-markdown'

const translator = new NodeHtmlMarkdown()

/** Rough budget figure (~4 characters per token for mixed prose). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * True when the client explicitly listed `text/markdown`. Full q-value parsing
 * is deliberately out of scope: a listed type is intent enough to negotiate.
 */
export function acceptsMarkdown(acceptHeader: string | undefined): boolean {
  if (!acceptHeader) return false

  return /(^|,|\s)text\/markdown(\s*;.*?)?(,|$)/i.test(acceptHeader)
}

export interface PageMarkdownOptions {
  siteUrl: string
  timeoutMs?: number
  /** Cap applied to the returned Markdown before it leaves the tool. */
  maxChars?: number
}

export interface PageMarkdownResult {
  path: string
  content_type: 'text/markdown'
  markdown: string
  tokens: number
  original_tokens: number
  truncated: boolean
}

/**
 * Outbound counterpart to the hook: fetch one same-origin page asking for
 * Markdown directly. Only a relative path is accepted — the tool must never be
 * usable as an open proxy.
 */
export async function fetchPageMarkdown(
  path: string,
  options: PageMarkdownOptions,
): Promise<PageMarkdownResult> {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) {
    throw new Error('path must be a same-origin relative path beginning with "/".')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
  const maxChars = options.maxChars ?? 40_000

  try {
    const response = await fetch(`${options.siteUrl.replace(/\/+$/, '')}${path}`, {
      headers: { Accept: 'text/markdown, text/html;q=0.5' },
      signal: controller.signal,
    })

    const body = await response.text()
    const isMarkdown = (response.headers.get('content-type') ?? '').includes('text/markdown')
    const markdown = isMarkdown ? body : translator.translate(body)
    const truncated = markdown.length > maxChars

    return {
      path,
      content_type: 'text/markdown',
      markdown: truncated ? markdown.slice(0, maxChars) : markdown,
      tokens: estimateTokens(truncated ? markdown.slice(0, maxChars) : markdown),
      original_tokens: estimateTokens(body),
      truncated,
    }
  } finally {
    clearTimeout(timer)
  }
}

export interface NegotiableResponse {
  body: string | undefined
  headers: Record<string, string | undefined>
}

/**
 * Mutate one response in place if the client asked for Markdown and the body
 * is HTML. Returns whether the response was negotiated, so the decision is
 * testable without standing up a server.
 */
export function negotiateMarkdownResponse(
  response: NegotiableResponse,
  accept: string | undefined,
): boolean {
  // API routes, static files, and well-known JSON are never negotiated.
  if (!response.body || typeof response.body !== 'string') return false

  const contentType = response.headers['content-type']
  if (!contentType || !contentType.startsWith('text/html')) return false
  if (!acceptsMarkdown(accept)) return false

  try {
    const html = response.body
    const markdown = translator.translate(html)

    response.body = markdown
    response.headers['content-type'] = 'text/markdown; charset=utf-8'

    // Append rather than replace: existing Vary tokens (Cookie, etc.) still
    // matter for cache correctness.
    const existing = response.headers['vary']
    response.headers['vary'] = existing ? `${existing}, Accept` : 'Accept'

    response.headers['x-markdown-tokens'] = String(estimateTokens(markdown))
    response.headers['x-original-tokens'] = String(estimateTokens(html))
    response.headers['content-length'] = String(Buffer.byteLength(markdown, 'utf-8'))

    return true
  } catch (err) {
    console.error('[markdown-negotiation] conversion failed; serving HTML', err)
    return false
  }
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('render:response', (response, { event }) => {
    negotiateMarkdownResponse(
      {
        body: typeof response.body === 'string' ? response.body : undefined,
        headers: response.headers as Record<string, string | undefined>,
      },
      getRequestHeader(event, 'accept'),
    )
  })
})
