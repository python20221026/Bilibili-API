// Activated-buvid management. Bilibili risk control (HTTP 412) requires the
// buvid3/buvid4 device cookies to come from finger/spi AND be "activated"
// via the ExClimbWuzhi gateway before playurl endpoints will respond —
// browser-issued buvids carried by a server-side fetch get banned.
//
// Flow (all calls go through the upstream proxy when BILI_PROXY_URL is set,
// so activation and playurl share the same egress IP):
//   1. GET  /x/frontend/finger/spi            → fresh b_3 / b_4
//   2. POST /x/internal/gaia-gateway/ExClimbWuzhi (best-effort, non-fatal)
//   3. Use `buvid3=..; buvid4=..` in the Cookie for playurl requests
import { fetchGetJson, fetchPostJson, buildHeaders, setUpstreamProxy } from '../utils/base-crawler.js'
import { BILI_REFERER } from './endpoints.js'

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
  const cookie = `buvid3=${b3}${b4 ? `; buvid4=${b4}` : ''}`
  // Best-effort activation — the gateway's response code is non-fatal.
  try {
    const payload = JSON.stringify({ 3064: 1, '39c8': '333.1387.fp.risk', '3c43': { adca: 'Windows', bfe9: randPngTail() } })
    await fetchPostJson(EX_CLIMB_URL, { ...h, Cookie: cookie, 'Content-Type': 'application/json' }, JSON.stringify({ payload }))
  } catch { /* activation failure doesn't block — playurl may still pass */ }
  return cookie
}

// Returns `buvid3=..; buvid4=..` for an activated device, cached for TTL.
// Concurrent callers share one activation round-trip.
export async function getActivatedBuvidCookie (ctx) {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.cookie
  if (!inflight) {
    inflight = activateBuvid(ctx)
      .then((cookie) => { cache = { cookie, ts: Date.now() }; return cookie })
      .finally(() => { inflight = null })
  }
  return inflight
}
