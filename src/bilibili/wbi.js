// Bilibili wbi signing — port of crawlers/bilibili/web/{wrid.py,utils.py}.
//
// w_rid = md5( urlencode( sorted, char-filtered params + wts ) + mixinKey ).
// The mixin key is derived dynamically from the nav API's wbi_img keys
// (img_url + sub_url file names, re-ordered through the 64-slot obfuscation
// table, first 32 chars) — the official web-client scheme. A hard-coded
// fallback key is kept in case the nav API is unreachable.
import { md5HexOfBytes } from '../lib/md5.js'
import { quotePlus } from '../utils/params.js'
import { fetchGetJson, buildHeaders, setUpstreamProxy } from '../utils/base-crawler.js'
import { BiliEndpoints as EP, BILI_REFERER } from './endpoints.js'
import { getActivatedBuvidCookie } from './buvid.js'

const FALLBACK_MIXIN_KEY = 'ea1db124af3c7062474693fa704f4ff8'
// 64-slot obfuscation table: how the web client re-orders the concatenated
// img_key+sub_key into the 32-char mixin key.
const MIXIN_KEY_ENC = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]
const MIXIN_KEY_TTL_MS = 3600 * 1000

const utf8 = (s) => Array.from(new TextEncoder().encode(s))
const filterChars = (v) => String(v).split('').filter(c => !"!'()*".includes(c)).join('')

let mixinKeyCache = null // { key, ts }
let mixinKeyInflight = null

// Fetch the current mixin key from the nav API (with the activated buvid
// cookie + browser disguise). Cached for MIXIN_KEY_TTL_MS; concurrent
// callers share one round-trip. Falls back to the hard-coded key on failure.
async function fetchWbiMixinKey (ctx) {
  setUpstreamProxy(ctx.config.upstreamProxy)
  const headers = buildHeaders({
    userAgent: ctx.config.bili.userAgent,
    referer: BILI_REFERER,
    cookie: await getActivatedBuvidCookie(ctx).catch(() => ''),
    extra: { Origin: 'https://www.bilibili.com' }
  })
  const nav = await fetchGetJson(EP.WEB_NAV, headers)
  const imgUrl = nav?.data?.wbi_img?.img_url
  const subUrl = nav?.data?.wbi_img?.sub_url
  if (!imgUrl || !subUrl) throw new Error('nav returned no wbi_img keys')
  const imgKey = imgUrl.split('/').pop().split('.')[0]
  const subKey = subUrl.split('/').pop().split('.')[0]
  const orig = imgKey + subKey
  if (orig.length < 64) throw new Error('wbi_img keys too short')
  return MIXIN_KEY_ENC.map(n => orig[n]).join('').slice(0, 32)
}

export async function getWbiMixinKey (ctx) {
  if (mixinKeyCache && Date.now() - mixinKeyCache.ts < MIXIN_KEY_TTL_MS) return mixinKeyCache.key
  if (!mixinKeyInflight) {
    mixinKeyInflight = fetchWbiMixinKey(ctx)
      .then((key) => { mixinKeyCache = { key, ts: Date.now() }; return key })
      .finally(() => { mixinKeyInflight = null })
  }
  try {
    return await mixinKeyInflight
  } catch {
    return FALLBACK_MIXIN_KEY // nav failed — sign with the last-known key
  }
}

// Given a params object (without wts/w_rid), return a new object with wts
// + w_rid added, ready to be query-joined. `now` overridable for tests.
export function wbiSign (params, mixinKey, now) {
  const wts = String(now ?? Math.floor(Date.now() / 1000))
  const sorted = {}
  for (const k of Object.keys({ ...params, wts }).sort()) sorted[k] = filterChars(params[k] ?? wts)
  const query = Object.entries(sorted).map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join('&')
  const wRid = md5HexOfBytes(utf8(query + mixinKey))
  return { ...params, wts, w_rid: wRid }
}

// Build a wbi-signed query string (raw "k=v&k=v" join, as upstream does).
// Async: resolves the current mixin key from nav (cached) first.
export async function wbiQuery (params, ctx, now) {
  const mixinKey = ctx ? await getWbiMixinKey(ctx) : FALLBACK_MIXIN_KEY
  const p = wbiSign(params, mixinKey, now)
  return Object.entries(p).map(([k, v]) => `${k}=${v}`).join('&')
}

// BV id -> AV (aid) number. Port of bv2av; BigInt so large modern aids
// don't overflow JS's 32-bit bitwise ops.
const TABLE = 'fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF'
const S = [11, 10, 3, 8, 4, 6, 2, 9, 5, 7]
const XOR = 177451812n
const ADD_105 = 8728348608n
const ADD_ALL = 8728348608n - (2n ** 31n - 1n) - 1n
export function bv2av (bvId) {
  const tr = {}
  for (let i = 0; i < 58; i++) tr[TABLE[i]] = BigInt(i)
  let r = 0n
  for (let i = 0; i < 6; i++) r += tr[bvId[S[i]]] * (58n ** BigInt(i))
  const add = r < ADD_105 ? ADD_ALL : ADD_105
  return Number((r - add) ^ XOR)
}
