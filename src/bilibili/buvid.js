// Activated-buvid management. Bilibili risk control (HTTP 412) requires the
// buvid3/buvid4 device cookies to come from finger/spi AND be "activated"
// via the ExClimbWuzhi gateway before playurl endpoints will respond —
// browser-issued buvids carried by a server-side fetch get banned.
//
// Flow (all calls go through the upstream proxy when BILI_PROXY_URL is set,
// so activation and playurl share the same egress IP):
//   1. GET  /x/frontend/finger/spi            → fresh b_3 / b_4
//   2. POST GenWebTicket (HMAC-SHA256 signed) → bili_ticket (anti-crawl token)
//   3. POST /x/internal/gaia-gateway/ExClimbWuzhi (best-effort, non-fatal)
//   4. Use `buvid3=..; buvid4=..; bili_ticket=..` in the Cookie for playurl
import { fetchGetJson, fetchPostJson, buildHeaders, setUpstreamProxy } from '../utils/base-crawler.js'
import { BiliEndpoints as EP, BILI_REFERER } from './endpoints.js'

const SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi'
const EX_CLIMB_URL = 'https://api.bilibili.com/x/internal/gaia-gateway/ExClimbWuzhi'
const TTL_MS = 12 * 3600 * 1000

let cache = null // { cookie, ts }
let inflight = null

// 32 random bytes + 4 zero bytes + "IEND" + 4 random bytes — the trailing
// 50 base64 chars of a random PNG, mirroring the web 412 challenge payload.
function randPngTail () {
  const bytes = new Uint8Array(44)
  crypto.getRandomValues(bytes)
  bytes.set([0, 0, 0, 0, 73, 69, 78, 68], 32) // IEND
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).slice(-50)
}

// GenWebTicket uses an HMAC-SHA256 signature with a fixed secret key to
// mint a bili_ticket (server-issued anti-crawl token, mirrors the web
// client's ticket refresh flow).
const TICKET_HMAC_KEY = 'XgwSnGZ1p'

async function hmacSha256Hex (key, message) {
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Best-effort: returns the bili_ticket string, or null when the ticket
// API is unreachable — a missing ticket degrades but doesn't block.
async function fetchBiliTicket (headers) {
  try {
    const ts = Math.floor(Date.now() / 1000)
    const hexsign = await hmacSha256Hex(TICKET_HMAC_KEY, 'ts' + ts)
    const q = `key_id=ec02&hexsign=${hexsign}&context%5Bts%5D=${ts}&csrf=`
    const res = await fetchPostJson(`${EP.GEN_WEB_TICKET}?${q}`, headers, '')
    return res?.data?.ticket || null
  } catch { return null }
}

async function activateBuvid (ctx) {
  setUpstreamProxy(ctx.config.upstreamProxy)
  const h = buildHeaders({
    userAgent: ctx.config.bili.userAgent,
    referer: BILI_REFERER,
    extra: { Origin: 'https://www.bilibili.com' }
  })
  const spi = await fetchGetJson(SPI_URL, h)
  const b3 = spi?.data?.b_3
  const b4 = spi?.data?.b_4
  if (!b3) throw new Error('finger/spi returned no b_3')
  const parts = [`buvid3=${b3}`]
  if (b4) parts.push(`buvid4=${b4}`)
  // bili_ticket — signed anti-crawl token; best-effort like ExClimbWuzhi.
  const ticket = await fetchBiliTicket(h)
  if (ticket) parts.push(`bili_ticket=${ticket}`)
  const cookie = parts.join('; ')
  // Best-effort activation — the gateway's response code is non-fatal.
  try {
    const payload = JSON.stringify({ 3064: 1, '39c8': '333.1387.fp.risk', '3c43': { adca: 'Windows', bfe9: randPngTail() } })
    await fetchPostJson(EX_CLIMB_URL, { ...h, Cookie: cookie, 'Content-Type': 'application/json' }, JSON.stringify({ payload }))
  } catch { /* activation failure doesn't block — playurl may still pass */ }
  return cookie
}

// Returns `buvid3=..; buvid4=..; bili_ticket=..` for an activated device,
// cached for TTL. Concurrent callers share one activation round-trip.
export async function getActivatedBuvidCookie (ctx) {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.cookie
  if (!inflight) {
    inflight = activateBuvid(ctx)
      .then((cookie) => { cache = { cookie, ts: Date.now() }; return cookie })
      .finally(() => { inflight = null })
  }
  return inflight
}
