// Minimal fetch-based crawler client, replacing the upstream httpx
// BaseCrawler. Carries the platform headers (UA / Referer / Cookie)
// and returns parsed JSON.
import { HTTPException } from './http-exception.js'

export function buildHeaders ({ userAgent, referer, cookie, extra = {} }) {
  const h = {
    'User-Agent': userAgent,
    'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
    ...extra
  }
  if (referer) h.Referer = referer
  if (cookie) h.Cookie = cookie
  return h
}

async function parseJson (resp, url) {
  const text = await resp.text()
  if (!resp.ok) {
    throw new HTTPException(resp.status === 404 ? 404 : 502, {
      message: `Upstream ${resp.status} for ${url}: ${text.slice(0, 200)}`
    })
  }
  if (!text) {
    // Douyin returns an empty body when it blocks the request (bad
    // cookie / signature). Surface it clearly.
    throw new HTTPException(502, {
      message: `Upstream returned an empty body for ${url} — usually a bad/expired cookie or blocked signature.`
    })
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new HTTPException(502, {
      message: `Upstream returned non-JSON for ${url}: ${text.slice(0, 200)}`
    })
  }
}

// Optional upstream proxy (e.g. a Vercel-edge forward proxy) to route
// bilibili API requests through a different egress IP. When set, requests
// are rewritten to `<proxy>?url=<encoded target>` and sent there instead.
let upstreamProxy = null

export function setUpstreamProxy (proxyUrl) {
  upstreamProxy = proxyUrl || null
}

function proxiedUrl (url) {
  if (!upstreamProxy) return url
  return `${upstreamProxy}${upstreamProxy.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`
}

export async function fetchGetJson (url, headers) {
  const resp = await fetchWithRetry(url, { method: 'GET', headers, redirect: 'follow' })
  return parseJson(resp, url)
}

export async function fetchPostJson (url, headers, body) {
  const resp = await fetchWithRetry(url, { method: 'POST', headers, body, redirect: 'follow' })
  return parseJson(resp, url)
}

// Exponential-backoff retry around raw fetch. Retries network errors and
// retryable upstream statuses (5xx / 429); other HTTP errors are returned
// for parseJson to surface. Mirrors BiliParser's proxy-fetch.
const RETRY_ATTEMPTS = 3
const RETRY_INITIAL_DELAY_MS = 500
const RETRY_MAX_DELAY_MS = 8000

async function fetchWithRetry (url, init, {
  attempts = RETRY_ATTEMPTS,
  initialDelay = RETRY_INITIAL_DELAY_MS,
  maxDelay = RETRY_MAX_DELAY_MS
} = {}) {
  let delay = initialDelay
  for (let attempt = 1; ; attempt++) {
    let resp = null
    try {
      resp = await fetch(proxiedUrl(url), init)
    } catch (err) {
      // Network-level failure — retry unless this was the last attempt.
      if (attempt >= attempts) throw err
    }
    if (resp) {
      const retryableStatus = !resp.ok && (resp.status >= 500 || resp.status === 429)
      if (!retryableStatus) return resp
      // Drain the body so the connection can be reused before retrying.
      await resp.body?.cancel().catch(() => {})
      if (attempt >= attempts) return resp // final attempt — surface the error
    }
    const jitter = Math.random() * 0.3 * delay
    await new Promise(resolve => setTimeout(resolve, delay + jitter))
    delay = Math.min(delay * 2, maxDelay)
  }
}
