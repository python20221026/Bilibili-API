// Bilibili web crawler — port of crawlers/bilibili/web/web_crawler.py.
// view (POST_DETAIL) carries title/owner/stat/pic/cid; playurl (wbi) is
// DASH (separate video + audio) or a combined mp4 durl.
import { fetchGetJson, buildHeaders, setUpstreamProxy } from '../utils/base-crawler.js'
import { wbiQuery } from './wbi.js'
import { BiliEndpoints as EP, BILI_REFERER } from './endpoints.js'
import { getActivatedBuvidCookie } from './buvid.js'

async function biliHeaders (ctx) {
  // Route all upstream bilibili API calls through the configured forward
  // proxy (BILI_PROXY_URL) when present — escapes egress-IP risk control.
  setUpstreamProxy(ctx.config.upstreamProxy)
  let cookie = ctx.config.bili.cookie || ''
  // playurl risk control needs an *activated* buvid; a browser-issued one
  // is fingerprint-bound and gets 412'd. Replace it with our activated pair.
  try {
    const buvid = await getActivatedBuvidCookie(ctx)
    const rest = cookie.split(';').map(s => s.trim()).filter(Boolean).filter(s => !/^buvid[34]=/i.test(s))
    cookie = [...rest, buvid].join('; ')
  } catch { /* fall back to the configured cookie as-is */ }
  return buildHeaders({
    userAgent: ctx.config.bili.userAgent,
    referer: BILI_REFERER,
    cookie,
    extra: { Origin: 'https://www.bilibili.com' }
  })
}

// Video detail (no wbi). Returns the full {code,data} response; data has
// aid, bvid, cid, title, desc, pic, owner, stat, pages, ...
export async function fetchOneVideo (ctx, bvId) {
  const url = `${EP.POST_DETAIL}?bvid=${encodeURIComponent(bvId)}`
  return fetchGetJson(url, await biliHeaders(ctx))
}

// Play URL (wbi). fnval 4048 => DASH (data.dash.video/audio); fnval 1 =>
// combined mp4 (data.durl). fourk=1 enables 4K when the account allows.
// Accepts either a bvid or (when bvId is empty) an avid, so callers that
// only know the numeric aid can still fetch the playurl.
export async function fetchVideoPlayurl (ctx, bvId, cid, { fnval = '4048', qn = '80', avid = null } = {}) {
  const params = { cid: String(cid), qn: String(qn), fnval: String(fnval), fourk: '1', fnver: '0', otype: 'json', platform: 'pc' }
  if (avid && !bvId) params.avid = String(avid)
  else params.bvid = bvId
  const q = wbiQuery(params)
  return fetchGetJson(`${EP.VIDEO_PLAYURL}?${q}`, await biliHeaders(ctx))
}

export async function fetchVideoParts (ctx, bvId) {
  return fetchGetJson(`${EP.VIDEO_PARTS}?bvid=${encodeURIComponent(bvId)}`, await biliHeaders(ctx))
}

export async function fetchUserProfile (ctx, mid) {
  const q = wbiQuery({ mid: String(mid), platform: 'web', web_location: '1550101' })
  return fetchGetJson(`${EP.USER_DETAIL}?${q}`, await biliHeaders(ctx))
}

// Bangumi (番剧) — PGC endpoints. season carries the episode list
// (cid/aid/bvid/cover/title); playurl is region/VIP-gated.
export async function fetchBangumiSeason (ctx, kind, id) {
  const q = kind === 'ss' ? `season_id=${encodeURIComponent(id)}` : `ep_id=${encodeURIComponent(id)}`
  return fetchGetJson(`${EP.PGC_SEASON}?${q}`, await biliHeaders(ctx))
}

export async function fetchBangumiPlayurl (ctx, epId, cid, { fnval = '4048', qn = '80' } = {}) {
  return fetchGetJson(`${EP.PGC_PLAYURL}?ep_id=${encodeURIComponent(epId)}&cid=${encodeURIComponent(cid)}&qn=${qn}&fnval=${fnval}&fourk=1`, await biliHeaders(ctx))
}

export async function fetchDynamicDetail (ctx, dynId) {
  return fetchGetJson(`${EP.DYNAMIC_DETAIL}?id=${encodeURIComponent(dynId)}&features=itemOpusStyle`, await biliHeaders(ctx))
}

export async function fetchVideoTags (ctx, bvId) {
  return fetchGetJson(`${EP.VIDEO_TAGS}?bvid=${encodeURIComponent(bvId)}`, await biliHeaders(ctx))
}

export async function fetchUserStat (ctx, mid) {
  return fetchGetJson(`${EP.RELATION_STAT}?vmid=${encodeURIComponent(mid)}`, await biliHeaders(ctx))
}

export async function fetchUserPostVideos (ctx, mid, pn = 1) {
  const q = wbiQuery({ mid: String(mid), pn: String(pn), ps: '20', order: 'pubdate', platform: 'web', web_location: '1550101' })
  return fetchGetJson(`${EP.USER_POST}?${q}`, await biliHeaders(ctx))
}

export async function fetchComPopular (ctx, pn = 1) {
  const q = wbiQuery({ ps: '20', pn: String(pn), web_location: '333.934' })
  return fetchGetJson(`${EP.COM_POPULAR}?${q}`, await biliHeaders(ctx))
}

// 排行榜 — the per-region ranking (rid=0 全站). Returns ~100 real videos
// with bvid/title/owner/stat/pic. No wbi needed.
export async function fetchRanking (ctx, rid = 0) {
  const params = new URLSearchParams({ rid: String(rid), type: 'all' })
  return fetchGetJson(`${EP.RANKING}?${params.toString()}`, await biliHeaders(ctx))
}

export async function fetchVideoComments (ctx, aid, pn = 1) {
  return fetchGetJson(`${EP.VIDEO_COMMENTS}?type=1&oid=${encodeURIComponent(aid)}&pn=${pn}&sort=2`, await biliHeaders(ctx))
}

export async function fetchCommentReply (ctx, aid, rpid, pn = 1) {
  return fetchGetJson(`${EP.COMMENT_REPLY}?type=1&oid=${encodeURIComponent(aid)}&root=${encodeURIComponent(rpid)}&pn=${pn}`, await biliHeaders(ctx))
}

export async function fetchLiveRoomDetail (ctx, roomId) {
  return fetchGetJson(`${EP.LIVEROOM_DETAIL}?room_id=${encodeURIComponent(roomId)}`, await biliHeaders(ctx))
}
