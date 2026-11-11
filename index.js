/**
 * dsh-bilibili-weekly — DeepSeek Harness plugin.
 *
 * Reads Bilibili's "每周必看" (weekly must-watch) list from the Web page
 * https://www.bilibili.com/v/popular/weekly and turns it into a weekly report.
 *
 * The Web page itself is a Vue SPA whose list endpoint
 * (`api.bilibili.com/x/web-interface/popular/series/one`) is behind risk control:
 * anonymous non-browser clients get `-352`. The mobile/app endpoint that the page's
 * H5 twin uses — `app.bilibili.com/x/v2/show/popular/selected` — answers anonymously,
 * so it is the primary source. A wbi-signed call to the web endpoint is kept as a
 * fallback for networks where the app endpoint is unavailable.
 *
 * What the plugin adds:
 *  - `bilibili_weekly`: one agent tool (list / latest / week / report),
 *  - a persisted cache plus per-video enrichment (play, like, coin, favorite, ...),
 *  - a deterministic Markdown weekly report that is also written to disk,
 *  - a right-edge panel in the Harness Web UI that renders the same report.
 */

import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'bilibili-weekly'
export const inject = ['tools']

const WEEK_PAGE = 'https://www.bilibili.com/v/popular/weekly'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
const APP_SERIES = 'https://app.bilibili.com/x/v2/show/popular/selected/series?type=weekly_selected'
const APP_WEEK = 'https://app.bilibili.com/x/v2/show/popular/selected?type=weekly_selected&number='
const WEB_SERIES = 'https://api.bilibili.com/x/web-interface/popular/series/list'
const WEB_WEEK = 'https://api.bilibili.com/x/web-interface/popular/series/one'
const VIDEO_DETAIL = 'https://api.bilibili.com/x/web-interface/view?bvid='
const NAV = 'https://api.bilibili.com/x/web-interface/nav'

const DEFAULTS = {
  dataDir: '',
  reportDir: '',
  topN: 10,
  enrich: true,
  maxEnrich: 60,
  enrichConcurrency: 4,
  cacheMinutes: 30,
  timeoutMs: 12000,
  enablePanel: true,
  registerSkill: true,
  enableWallpaper: true,
  wallSpeed: 60,
  wallVeil: 0.78,
}

/* ------------------------------------------------------------------ config */

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : path.join(os.homedir(), '.dsh')
}

function normalizeConfig(raw) {
  const config = { ...DEFAULTS }
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined || value === null) continue
      config[key] = value
    }
  }
  config.dataDir = String(config.dataDir || '').trim() || path.join(dshHome(), 'bilibili-weekly')
  config.reportDir = String(config.reportDir || '').trim() || path.join(config.dataDir, 'reports')
  config.topN = clampInt(config.topN, 1, 60, DEFAULTS.topN)
  config.maxEnrich = clampInt(config.maxEnrich, 0, 200, DEFAULTS.maxEnrich)
  config.enrichConcurrency = clampInt(config.enrichConcurrency, 1, 8, DEFAULTS.enrichConcurrency)
  config.cacheMinutes = clampInt(config.cacheMinutes, 0, 24 * 60, DEFAULTS.cacheMinutes)
  config.timeoutMs = clampInt(config.timeoutMs, 2000, 60000, DEFAULTS.timeoutMs)
  config.enrich = config.enrich !== false
  config.enablePanel = config.enablePanel !== false
  config.registerSkill = config.registerSkill !== false
  config.enableWallpaper = config.enableWallpaper !== false
  config.wallSpeed = clampInt(config.wallSpeed, 15, 900, DEFAULTS.wallSpeed)
  config.wallVeil = clampNumber(config.wallVeil, 0.1, 0.92, DEFAULTS.wallVeil)
  return config
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/* ------------------------------------------------------------------- http */

function withTimeout(externalSignal, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms)
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason)
    else externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), { once: true })
  }
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

async function httpJson(url, { timeoutMs = 12000, signal, headers } = {}) {
  const guard = withTimeout(signal, timeoutMs)
  try {
    const response = await fetch(url, {
      signal: guard.signal,
      headers: {
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        referer: 'https://www.bilibili.com/h5/weekly-recommend',
        ...(headers || {}),
      },
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${hostOf(url)}`)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`non-JSON reply from ${hostOf(url)}: ${text.slice(0, 120)}`)
    }
  } finally {
    guard.done()
  }
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return 'bilibili'
  }
}

/* ------------------------------------------------------------------ wbi */

// The public mixin-key permutation table used by the web client's wbi signing.
const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

async function webWeekSigned(number, options) {
  const nav = await httpJson(NAV, options)
  const img = nav?.data?.wbi_img?.img_url ?? ''
  const sub = nav?.data?.wbi_img?.sub_url ?? ''
  const key = (name) => name.split('/').pop().split('.')[0]
  const origin = key(img) + key(sub)
  if (origin.length !== 64) throw new Error('wbi keys unavailable from nav')
  const mixin = MIXIN_TABLE.map((index) => origin[index]).join('')
  const params = { number: String(number), web_location: '333.934', wts: String(Math.floor(Date.now() / 1000)) }
  const query = Object.keys(params)
    .sort()
    .map((item) => `${encodeURIComponent(item)}=${encodeURIComponent(params[item])}`)
    .join('&')
  const wRid = createHash('md5').update(query + mixin).digest('hex')
  return httpJson(`${WEB_WEEK}?${query}&w_rid=${wRid}`, options)
}

/* -------------------------------------------------------------- bilibili */

async function fetchSeries(options) {
  let error = null
  try {
    const reply = await httpJson(APP_SERIES, options)
    if (reply?.code === 0 && Array.isArray(reply.data) && reply.data.length > 0) {
      return reply.data.map((row) => ({
        number: Number(row.number),
        subject: String(row.subject ?? '').trim(),
        status: Number(row.status ?? 0),
        name: String(row.name ?? '').trim(),
      }))
    }
    error = new Error(`app series list returned code ${reply?.code ?? '?'}`)
  } catch (cause) {
    error = cause
  }
  const fallback = await httpJson(WEB_SERIES, { ...options, headers: { referer: WEEK_PAGE } })
  if (fallback?.code === 0 && Array.isArray(fallback.data?.list)) {
    return fallback.data.list.map((row) => ({
      number: Number(row.number),
      subject: String(row.subject ?? '').trim(),
      status: Number(row.status ?? 0),
      name: String(row.name ?? '').trim(),
    }))
  }
  throw error instanceof Error ? error : new Error('weekly series list unavailable')
}

async function fetchWeekRaw(number, options) {
  let error = null
  try {
    const reply = await httpJson(APP_WEEK + number, {
      ...options,
      headers: { referer: `https://www.bilibili.com/h5/weekly-recommend?num=${number}&navhide=1` },
    })
    if (reply?.code === 0 && Array.isArray(reply.data?.list)) return normalizeWeek(reply.data, number)
    error = new Error(`app weekly list returned code ${reply?.code ?? '?'}`)
  } catch (cause) {
    error = cause
  }
  try {
    const reply = await webWeekSigned(number, options)
    if (reply?.code === 0 && Array.isArray(reply.data?.list)) return normalizeWeek(reply.data, number)
  } catch {
    /* keep the app-endpoint error, it is the more informative one */
  }
  throw error instanceof Error ? error : new Error(`weekly list ${number} unavailable`)
}

function normalizeWeek(payload, number) {
  const config = payload?.config ?? {}
  const list = Array.isArray(payload?.list) ? payload.list : []
  return {
    number: Number(config.number ?? number),
    subject: String(config.subject ?? '').trim(),
    label: String(config.label ?? '').trim(),
    shareTitle: String(config.share_title ?? '').trim(),
    shareSubtitle: String(config.share_subtitle ?? '').trim(),
    reminder: String(payload?.reminder ?? '').trim(),
    mediaId: Number(config.media_id ?? 0),
    fetchedAt: Date.now(),
    videos: list.map(normalizeVideo).filter(Boolean),
  }
}

function normalizeVideo(item, index) {
  if (!item || typeof item !== 'object') return null
  const bvid = String(item.bvid ?? '').trim()
  const aid = String(item.param ?? '').trim()
  if (!bvid && !aid) return null
  const desc = String(item.right_desc_2 ?? '')
  return {
    rank: index + 1,
    bvid,
    aid,
    title: String(item.title ?? '').trim(),
    uploader: String(item.right_desc_1 ?? '').trim(),
    uploaderId: Number(item.author_id ?? 0),
    cover: normalizeCover(item.cover),
    duration: parseDuration(item.cover_right_text_1),
    durationText: String(item.cover_right_text_1 ?? '').trim(),
    views: parseCount(desc),
    viewText: desc.split('·')[0]?.trim() ?? '',
    publishedText: desc.split('·')[1]?.trim() ?? '',
    reason: String(item.rcmd_reason ?? '').trim(),
    shortLink: String(item.short_link ?? '').trim(),
    url: bvid ? `https://www.bilibili.com/video/${bvid}` : `https://www.bilibili.com/video/av${aid}`,
    detail: null,
  }
}

function normalizeCover(url) {
  const value = String(url ?? '').trim()
  if (value === '') return ''
  if (value.startsWith('//')) return `https:${value}`
  return value.replace(/^http:\/\//, 'https://')
}

function parseCount(text) {
  const value = String(text ?? '')
  const match = value.match(/([\d.]+)\s*(亿|万)?/)
  if (!match) return 0
  const number = Number(match[1])
  if (!Number.isFinite(number)) return 0
  if (match[2] === '亿') return Math.round(number * 1e8)
  if (match[2] === '万') return Math.round(number * 1e4)
  return Math.round(number)
}

function parseDuration(text) {
  const parts = String(text ?? '')
    .split(':')
    .map((item) => Number(item))
  if (parts.length === 0 || parts.some((item) => !Number.isFinite(item))) return 0
  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] * 3600 + parts[1] * 60 + parts[2]
}

async function fetchVideoDetail(bvid, options) {
  const reply = await httpJson(VIDEO_DETAIL + encodeURIComponent(bvid), {
    ...options,
    headers: { referer: `https://www.bilibili.com/video/${bvid}` },
  })
  if (reply?.code !== 0 || !reply.data) throw new Error(`detail code ${reply?.code ?? '?'}`)
  const data = reply.data
  const stat = data.stat ?? {}
  return {
    tid: Number(data.tid ?? 0),
    tname: String(data.tname ?? '').trim(),
    duration: Number(data.duration ?? 0),
    pubdate: Number(data.pubdate ?? 0),
    view: Number(stat.view ?? 0),
    like: Number(stat.like ?? 0),
    coin: Number(stat.coin ?? 0),
    favorite: Number(stat.favorite ?? 0),
    reply: Number(stat.reply ?? 0),
    danmaku: Number(stat.danmaku ?? 0),
    share: Number(stat.share ?? 0),
    ownerName: String(data.owner?.name ?? '').trim(),
  }
}

async function enrichWeek(week, config, signal) {
  const targets = week.videos.filter((video) => video.bvid && !video.detail).slice(0, config.maxEnrich)
  if (targets.length === 0) return week
  const queue = [...targets]
  const workers = Array.from({ length: Math.min(config.enrichConcurrency, queue.length) }, async () => {
    for (;;) {
      const video = queue.shift()
      if (!video) return
      try {
        video.detail = await fetchVideoDetail(video.bvid, { timeoutMs: config.timeoutMs, signal })
      } catch {
        video.detail = null
      }
    }
  })
  await Promise.all(workers)
  return week
}

/* ------------------------------------------------------------------ store */

function createStore(config) {
  let series = []
  let seriesAt = 0
  const weeks = new Map()
  let loaded = false
  let saveChain = Promise.resolve()

  const cachePath = path.join(config.dataDir, 'cache.json')

  async function load() {
    if (loaded) return
    loaded = true
    try {
      const raw = await fs.readFile(cachePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed.series)) series = parsed.series
      seriesAt = Number(parsed.seriesAt ?? 0) || 0
      if (parsed.weeks && typeof parsed.weeks === 'object') {
        for (const [key, value] of Object.entries(parsed.weeks)) {
          if (value && Array.isArray(value.videos)) weeks.set(Number(key), value)
        }
      }
    } catch {
      /* first run or unreadable cache: start empty */
    }
  }

  function snapshot() {
    const payload = { version: 1, seriesAt, series, weeks: {} }
    for (const [number, week] of weeks) {
      // Keep cached weeks small: detail objects are the bulk, and they are what we keep.
      payload.weeks[number] = week
    }
    return payload
  }

  function save() {
    const payload = JSON.stringify(snapshot())
    saveChain = saveChain
      .then(async () => {
        await fs.mkdir(config.dataDir, { recursive: true })
        const tmp = `${cachePath}.${process.pid}.tmp`
        await fs.writeFile(tmp, payload, 'utf8')
        await fs.rename(tmp, cachePath)
      })
      .catch(() => {})
    return saveChain
  }

  function fresh(at) {
    if (config.cacheMinutes === 0) return false
    return Date.now() - at < config.cacheMinutes * 60000
  }

  async function ensureSeries({ refresh = false, signal } = {}) {
    await load()
    if (!refresh && series.length > 0 && fresh(seriesAt)) return series
    try {
      series = await fetchSeries({ timeoutMs: config.timeoutMs, signal })
      seriesAt = Date.now()
      void save()
    } catch (error) {
      if (series.length === 0) throw error
    }
    return series
  }

  async function ensureWeek(number, { refresh = false, enrich = config.enrich, signal } = {}) {
    await load()
    let week = weeks.get(number)
    const needsEnrich = enrich && week ? week.videos.some((video) => video.bvid && !video.detail) : false
    if (!refresh && week && fresh(week.fetchedAt) && !needsEnrich) return week
    if (refresh || !week) {
      week = await fetchWeekRaw(number, { timeoutMs: config.timeoutMs, signal })
      weeks.set(number, week)
    }
    if (enrich) {
      await enrichWeek(week, config, signal)
      week.enrichedAt = Date.now()
    }
    week.fetchedAt = week.fetchedAt || Date.now()
    void save()
    return week
  }

  function peekSeries() {
    return series
  }

  function peekWeek(number) {
    return weeks.get(number)
  }

  return { load, ensureSeries, ensureWeek, peekSeries, peekWeek, save, get cachePath() { return cachePath } }
}

/* ------------------------------------------------------------------ stats */

// B站二级分区 tid → 名称。只收确定的分区，未命中的再走关键词兜底。
const TID_NAMES = {
  1: '动画', 3: '音乐', 4: '游戏', 5: '娱乐', 13: '番剧', 17: '单机游戏', 21: '日常', 22: '鬼畜调教',
  24: 'MAD·AMV', 26: '音MAD', 28: 'VOCALOID·UTAU', 30: '原创音乐', 31: '翻唱', 59: '演奏',
  65: '网络游戏', 71: '综艺', 76: '美食制作', 85: '影视杂谈', 86: '特摄', 95: '数码', 119: '鬼畜',
  121: 'GMV', 124: '社科·法律·心理', 126: '人力VOCALOID', 127: '鬼畜剧场', 129: '舞蹈', 130: '音乐现场',
  136: '音游', 138: '搞笑', 155: '时尚', 160: '生活', 161: '手工', 167: '国创', 168: '国创',
  171: '电子竞技', 172: '手机游戏', 173: '桌游棋牌', 176: '汽车', 177: '纪录片', 181: '影视',
  182: '影视杂谈', 183: '影视剪辑', 188: '科技', 201: '科学科普', 207: '财经商业',
  215: '美食记录', 216: '鬼畜剧场', 217: '动物圈', 218: '喵星人', 219: '汪星人', 220: '动物二创',
  221: '野生动物', 222: '动物综合', 228: '人文历史', 229: '设计·创意', 232: '科工机械',
  238: '运动文化', 241: '娱乐杂谈', 242: '娱乐粉丝创作', 250: '出行', 251: '三农',
}

// 二级分区名 → 一级分组，用于周报里的「分区分布」。
const GROUP_BY_NAME = {
  动画: '动画', 'MAD·AMV': '动画', '短片·手书·配音': '动画', 综合: '动画', '同人·手书': '动画',
  特摄: '动画', '手办·模玩': '动画', 番剧: '动画', 国创: '动画', 动漫杂谈: '动画',
  游戏: '游戏', 单机游戏: '游戏', 网络游戏: '游戏', 手机游戏: '游戏', 电子竞技: '游戏',
  音游: '游戏', 桌游棋牌: '游戏', GMV: '游戏',
  音乐: '音乐', 'VOCALOID·UTAU': '音乐', 原创音乐: '音乐', 翻唱: '音乐', 演奏: '音乐',
  音乐现场: '音乐', 音乐综合: '音乐', 三次元音乐: '音乐', 乐评盘点: '音乐',
  舞蹈: '舞蹈', 宅舞: '舞蹈', 舞蹈教程: '舞蹈', 舞蹈综合: '舞蹈', 街舞: '舞蹈',
  知识: '知识', 科学科普: '知识', '社科·法律·心理': '知识', 人文历史: '知识', 财经商业: '知识',
  校园学习: '知识', 职业职场: '知识', '设计·创意': '知识', 野生技能: '知识',
  科技: '科技', 数码: '科技', 软件应用: '科技', 计算机技术: '科技', 科工机械: '科技',
  生活: '生活', 日常: '生活', 搞笑: '生活', 手工: '生活', 出行: '生活', 三农: '生活', 家居房产: '生活',
  美食: '美食', 美食制作: '美食', 美食侦探: '美食', 美食测评: '美食', 美食记录: '美食', 田园美食: '美食',
  动物: '动物', 动物圈: '动物', 喵星人: '动物', 汪星人: '动物', 动物二创: '动物', 野生动物: '动物', 动物综合: '动物',
  鬼畜: '鬼畜', 鬼畜调教: '鬼畜', 音MAD: '鬼畜', '人力VOCALOID': '鬼畜', 鬼畜剧场: '鬼畜',
  娱乐: '娱乐', 综艺: '娱乐', 娱乐杂谈: '娱乐', 娱乐粉丝创作: '娱乐', 明星综合: '娱乐',
  影视: '影视', 影视杂谈: '影视', 影视剪辑: '影视', 纪录片: '纪录片',
  体育: '体育', 篮球: '体育', 足球: '体育', 体育赛事: '体育', 运动文化: '体育', 健身: '体育',
  时尚: '时尚', 美妆护肤: '时尚', 穿搭: '时尚', 潮流: '时尚',
  汽车: '汽车', 汽车生活: '汽车', 资讯: '资讯', 热点: '资讯',
}

const KEYWORD_GROUPS = [
  ['游戏', /游戏|绝区零|原神|星穹|方舟|英雄联盟|LOL|王者荣耀|我的世界|实况|攻略|赛事|电竞|速通|版本更新/],
  ['动画', /动画|番剧|手书|新番|PV|OP|ED|鬼灭|咒术|进击|手办/],
  ['音乐', /音乐|MV|翻唱|演奏|钢琴|吉他|歌曲|BGM|混音|交响/],
  ['鬼畜', /鬼畜|音MAD|整活|抽象|沙雕/],
  ['影视', /电影|剧集|预告|片段|名场面|影视|解说/],
  ['知识', /科普|知识|讲解|原理|历史|数学|物理|化学|考研|学习|揭秘/],
  ['科技', /数码|手机|电脑|AI|芯片|评测|科技|装机|机器人/],
  ['美食', /美食|做饭|厨|探店|料理|吃播/],
  ['生活', /生活|vlog|日常|旅行|露营|搞笑|哈哈|笑死/],
  ['舞蹈', /舞蹈|宅舞|翻跳|编舞/],
  ['汽车', /汽车|车评|试驾|自驾/],
  ['体育', /体育|篮球|足球|健身|比赛集锦/],
]

function categoryOf(video) {
  const tid = Number(video.detail?.tid ?? 0)
  const detailName = String(video.detail?.tname ?? '').trim()
  const name = detailName !== '' ? detailName : (TID_NAMES[tid] ?? '')
  if (name !== '') return { name, group: GROUP_BY_NAME[name] ?? fallbackGroup(video) }
  return { name: '', group: fallbackGroup(video) }
}

function fallbackGroup(video) {
  const text = `${video.title ?? ''} ${video.reason ?? ''}`
  for (const [group, pattern] of KEYWORD_GROUPS) if (pattern.test(text)) return group
  return '其他'
}

function buildStats(week) {
  const videos = week.videos ?? []
  const enriched = videos.filter((video) => video.detail)
  const views = videos.map((video) => video.detail?.view ?? video.views ?? 0).filter((value) => value > 0)
  const totalViews = views.reduce((sum, value) => sum + value, 0)
  const sortedViews = [...views].sort((a, b) => a - b)
  const medianViews = sortedViews.length === 0
    ? 0
    : (sortedViews.length % 2 === 1
      ? sortedViews[(sortedViews.length - 1) / 2]
      : Math.round((sortedViews[sortedViews.length / 2 - 1] + sortedViews[sortedViews.length / 2]) / 2))

  const durations = videos.map((video) => video.detail?.duration ?? video.duration ?? 0)
  const totalDuration = durations.reduce((sum, value) => sum + value, 0)

  const engagement = { like: 0, coin: 0, favorite: 0, reply: 0, danmaku: 0, share: 0 }
  for (const video of enriched) {
    for (const key of Object.keys(engagement)) engagement[key] += video.detail[key] ?? 0
  }

  const uploaders = new Map()
  for (const video of videos) {
    const owner = video.detail?.ownerName || video.uploader || '未知UP主'
    const row = uploaders.get(owner) ?? { name: owner, count: 0, bestRank: video.rank, views: 0, videos: [] }
    row.count += 1
    row.bestRank = Math.min(row.bestRank, video.rank)
    row.views += video.detail?.view ?? video.views ?? 0
    row.videos.push(video)
    uploaders.set(owner, row)
  }

  const categories = new Map()
  for (const video of videos) {
    const { name, group } = categoryOf(video)
    const row = categories.get(group) ?? { label: group, names: new Map(), count: 0, views: 0, videos: [] }
    row.count += 1
    row.views += video.detail?.view ?? video.views ?? 0
    row.videos.push(video)
    if (name !== '') row.names.set(name, (row.names.get(name) ?? 0) + 1)
    categories.set(group, row)
  }

  const byViews = [...videos].sort((a, b) => (b.detail?.view ?? b.views) - (a.detail?.view ?? a.views))
  const byEngagement = [...enriched].sort((a, b) => {
    const rateA = (a.detail.like + a.detail.coin * 2 + a.detail.favorite * 2) / Math.max(1, a.detail.view)
    const rateB = (b.detail.like + b.detail.coin * 2 + b.detail.favorite * 2) / Math.max(1, b.detail.view)
    return rateB - rateA
  })
  const byLike = [...enriched].sort((a, b) => b.detail.like - a.detail.like)
  const byDanmaku = [...enriched].sort((a, b) => b.detail.danmaku - a.detail.danmaku)
  const byDuration = [...videos].sort((a, b) => (b.detail?.duration ?? b.duration) - (a.detail?.duration ?? a.duration))

  return {
    count: videos.length,
    enrichedCount: enriched.length,
    totalViews,
    averageViews: videos.length === 0 ? 0 : Math.round(totalViews / videos.length),
    medianViews,
    topViews: byViews[0] ? (byViews[0].detail?.view ?? byViews[0].views) : 0,
    totalDuration,
    averageDuration: videos.length === 0 ? 0 : Math.round(totalDuration / videos.length),
    engagement,
    uploaders: [...uploaders.values()].sort((a, b) => b.count - a.count || a.bestRank - b.bestRank),
    categories: [...categories.values()].sort((a, b) => b.count - a.count || b.views - a.views),
    byViews,
    byEngagement,
    byLike,
    byDanmaku,
    byDuration,
  }
}

/* ----------------------------------------------------------------- report */

function two(value) {
  return String(value).padStart(2, '0')
}

function fmtDate(timestampMs, { timeZone = 'Asia/Shanghai' } = {}) {
  const date = new Date(timestampMs)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '00'
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}

function fmtDateTime(timestampMs) {
  const date = new Date(timestampMs)
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date)
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '00'
  return `${fmtDate(timestampMs)} ${pick('hour')}:${pick('minute')}`
}

function fmtCount(value) {
  const number = Number(value) || 0
  if (number >= 1e8) return `${(number / 1e8).toFixed(2)} 亿`
  if (number >= 1e4) return `${(number / 1e4).toFixed(number >= 1e6 ? 0 : 1)} 万`
  return String(number)
}

function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${two(rest)} 秒`
  return `${rest} 秒`
}

function fmtClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  return hours > 0 ? `${hours}:${two(minutes)}:${two(rest)}` : `${minutes}:${two(rest)}`
}

function weekPeriod(seriesRow) {
  if (!seriesRow?.name) return ''
  const match = seriesRow.name.match(/(\d{4})\s*第\s*(\d+)\s*期\s*([\d.]+)\s*[-–]\s*([\d.]+)/)
  if (!match) return seriesRow.name
  return `${match[1]}.${match[3]} – ${match[4]}`
}

function escapeCell(text) {
  return String(text ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ').trim()
}

function buildReport(week, seriesRow, options = {}) {
  const topN = clampInt(options.topN ?? 10, 1, 60, 10)
  const stats = buildStats(week)
  const lines = []
  const period = weekPeriod(seriesRow)
  const number = week.number
  const generatedAt = Date.now()
  const detail = (video) => video.detail ?? {}
  const viewOf = (video) => detail(video).view ?? video.views ?? 0
  const clockOf = (video) => fmtClock(detail(video).duration ?? video.duration)
  const likeOf = (video) => detail(video).like
  const catOf = (video) => {
    const category = categoryOf(video)
    return category.name !== '' ? category.name : category.group
  }

  lines.push(`# B站每周必看 · 第 ${number} 期周报`)
  lines.push('')
  lines.push(`> **本期主题**：${week.subject || seriesRow?.subject || '—'}`)
  lines.push('>')
  if (period) lines.push(`> **周期**：${period}（${seriesRow?.name || week.label || `第${number}期`}）`)
  lines.push('>')
  lines.push(`> **生成时间**：${fmtDateTime(generatedAt)}（Asia/Shanghai）`)
  lines.push('>')
  lines.push(`> **数据来源**：[bilibili 每周必看](${WEEK_PAGE}?num=${number}) · ${stats.enrichedCount > 0 ? '榜单接口 + 视频详情接口' : '榜单接口'}`)
  lines.push('')

  lines.push('## 一、本周概览')
  lines.push('')
  lines.push('| 指标 | 数值 |')
  lines.push('| --- | --- |')
  lines.push(`| 上榜视频 | ${stats.count} 条 |`)
  lines.push(`| 累计播放 | ${fmtCount(stats.totalViews)} |`)
  lines.push(`| 平均播放 | ${fmtCount(stats.averageViews)} |`)
  lines.push(`| 中位播放 | ${fmtCount(stats.medianViews)} |`)
  lines.push(`| 榜首播放 | ${fmtCount(stats.topViews)} |`)
  lines.push(`| 累计时长 | ${fmtDuration(stats.totalDuration)}（平均 ${fmtDuration(stats.averageDuration)}/条） |`)
  if (stats.enrichedCount > 0) {
    const e = stats.engagement
    lines.push(`| 互动总量 | 赞 ${fmtCount(e.like)} · 币 ${fmtCount(e.coin)} · 藏 ${fmtCount(e.favorite)} |`)
    lines.push(`| 弹幕 / 评论 | ${fmtCount(e.danmaku)} 条 / ${fmtCount(e.reply)} 条 |`)
  }
  const repeatUploaders = stats.uploaders.filter((row) => row.count > 1)
  lines.push(`| 上榜 UP 主 | ${stats.uploaders.length} 位${repeatUploaders.length > 0 ? `（${repeatUploaders.length} 位多次上榜）` : ''} |`)
  lines.push(`| 分区分布 | ${stats.categories.slice(0, 5).map((row) => `${row.label} ${row.count}`).join(' · ') || '—'} |`)
  lines.push('')

  lines.push(`## 二、榜单 TOP ${Math.min(topN, Math.max(1, stats.count))}（官方排序）`)
  lines.push('')
  lines.push('| # | 视频 | UP主 | 分区 | 播放 | 点赞 | 时长 | 上榜理由 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const video of week.videos.slice(0, topN)) {
    lines.push(
      `| ${video.rank} | [${escapeCell(video.title)}](${video.url}) | ${escapeCell(video.uploader)} | ${escapeCell(catOf(video))} | ${fmtCount(viewOf(video))} | ${likeOf(video) ? fmtCount(likeOf(video)) : '—'} | ${clockOf(video)} | ${escapeCell(video.reason) || '—'} |`,
    )
  }
  lines.push('')

  lines.push('## 三、播放量 TOP 10（按播放重排）')
  lines.push('')
  lines.push('| # | 视频 | UP主 | 播放 | 点赞 | 收藏 | 弹幕 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  stats.byViews.slice(0, 10).forEach((video, index) => {
    const cell = (value) => (video.detail && typeof value === 'number' ? fmtCount(value) : '—')
    lines.push(`| ${index + 1} | [${escapeCell(video.title)}](${video.url}) | ${escapeCell(video.uploader)} | ${fmtCount(viewOf(video))} | ${cell(detail(video).like)} | ${cell(detail(video).favorite)} | ${cell(detail(video).danmaku)} |`)
  })
  lines.push('')

  lines.push('## 四、分区分布')
  lines.push('')
  lines.push('| 分区 | 数量 | 占比 | 细分 | 代表作品 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const row of stats.categories) {
    const share = stats.count === 0 ? 0 : Math.round((row.count / stats.count) * 100)
    const best = [...row.videos].sort((a, b) => viewOf(b) - viewOf(a))[0]
    const names = [...row.names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => (count > 1 ? `${name}×${count}` : name)).join('、')
    lines.push(`| ${row.label} | ${row.count} | ${share}% | ${names || '—'} | ${best ? escapeCell(best.title) : '—'} |`)
  }
  lines.push('')

  lines.push('## 五、UP 主上榜统计')
  lines.push('')
  lines.push('| UP主 | 上榜数 | 最高排名 | 代表作品 |')
  lines.push('| --- | --- | --- | --- |')
  for (const row of stats.uploaders.slice(0, 12)) {
    const best = [...row.videos].sort((a, b) => a.rank - b.rank)[0]
    lines.push(`| ${escapeCell(row.name)} | ${row.count} | NO.${row.bestRank} | ${best ? escapeCell(best.title) : '—'} |`)
  }
  if (stats.uploaders.length > 12) lines.push(`| … | 其余 ${stats.uploaders.length - 12} 位各上榜 1 条 | | |`)
  lines.push('')

  lines.push('## 六、数据亮点')
  lines.push('')
  const pick = (video) => `[${escapeCell(video.title)}](${video.url}) · ${escapeCell(video.uploader)}`
  if (stats.byViews[0]) lines.push(`- **播放最高**：${pick(stats.byViews[0])} — ${fmtCount(viewOf(stats.byViews[0]))} 播放（榜单 NO.${stats.byViews[0].rank}）`)
  if (stats.byLike[0]) lines.push(`- **点赞最高**：${pick(stats.byLike[0])} — ${fmtCount(stats.byLike[0].detail.like)} 赞`)
  if (stats.byDanmaku[0]) lines.push(`- **弹幕最密**：${pick(stats.byDanmaku[0])} — ${fmtCount(stats.byDanmaku[0].detail.danmaku)} 条弹幕`)
  if (stats.byEngagement[0] && stats.byEngagement[0].detail) {
    const video = stats.byEngagement[0]
    const rate = ((video.detail.like + video.detail.coin * 2 + video.detail.favorite * 2) / Math.max(1, video.detail.view)) * 100
    lines.push(`- **互动率最高**：${pick(video)} — ${rate.toFixed(1)}%（赞 + 2×币 + 2×藏，除以播放）`)
  }
  if (stats.byDuration[0]) lines.push(`- **最长视频**：${pick(stats.byDuration[0])} — ${fmtDuration(stats.byDuration[0].detail?.duration ?? stats.byDuration[0].duration)}`)
  const shortest = [...stats.byDuration].reverse()[0]
  if (shortest) lines.push(`- **最短视频**：${pick(shortest)} — ${fmtDuration(shortest.detail?.duration ?? shortest.duration)}`)
  lines.push('')

  lines.push('## 七、观看建议')
  lines.push('')
  const quick = [...stats.byViews].filter((video) => (video.detail?.duration ?? video.duration) <= 180).slice(0, 3)
  const longform = [...stats.byDuration].filter((video) => (video.detail?.duration ?? video.duration) >= 600).slice(0, 3)
  const hidden = stats.byEngagement.filter((video) => video.rank > Math.min(topN, stats.count)).slice(0, 3)
  if (stats.byViews[0]) {
    const rank = stats.byViews[0].rank
    const placement = rank <= Math.min(topN, stats.count) ? `，同时位列榜单 NO.${rank}` : `，但官方排序只有 NO.${rank}，属于"后段高播放"`
    lines.push(`1. **先看门面**：${pick(stats.byViews[0])}，本期播放第一${placement}。`)
  }
  if (quick.length > 0) lines.push(`2. **碎片时间**：${quick.map((video) => escapeCell(video.title)).join('、')}，都在 3 分钟内。`)
  if (longform.length > 0) lines.push(`3. **留出整块时间**：${longform.map((video) => escapeCell(video.title)).join('、')}，单条超过 10 分钟。`)
  if (hidden.length > 0) lines.push(`4. **排名之外的黑马**：${hidden.map((video) => `${escapeCell(video.title)}（NO.${video.rank}）`).join('、')}，互动率高于其排名。`)
  lines.push('')

  lines.push(`## 附：完整榜单（${stats.count} 条）`)
  lines.push('')
  lines.push('| # | 视频 | UP主 | 播放 | 时长 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const video of week.videos) {
    lines.push(`| ${video.rank} | [${escapeCell(video.title)}](${video.url}) | ${escapeCell(video.uploader)} | ${fmtCount(viewOf(video))} | ${video.durationText || clockOf(video)} |`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(`报告由 DeepSeek Harness 插件 \`dsh-bilibili-weekly\` 自动生成 · 数据抓取时间 ${fmtDateTime(week.fetchedAt)}`)

  return { markdown: lines.join('\n'), stats }
}

/* ------------------------------------------------------------------ tools */

function renderJson(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function renderText(text) {
  return [{ type: 'text', text }]
}

function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: { schema: options.output.schema, render: options.output.render },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.isConcurrencySafe ? { isConcurrencySafe: options.isConcurrencySafe } : {}),
    async execute(args, exec) {
      return options.execute(args ?? {}, exec)
    },
  }
}

function summariseWeek(week, stats, seriesRow) {
  return {
    number: week.number,
    subject: week.subject,
    label: week.label,
    series: seriesRow?.name ?? '',
    period: weekPeriod(seriesRow),
    page: `${WEEK_PAGE}?num=${week.number}`,
    fetchedAt: new Date(week.fetchedAt).toISOString(),
    enriched: stats.enrichedCount,
    count: stats.count,
    totalViews: stats.totalViews,
    averageViews: stats.averageViews,
    totalDuration: stats.totalDuration,
    uploaders: stats.uploaders.length,
    categories: stats.categories.map((row) => ({ label: row.label, count: row.count, views: row.views })),
    top: stats.byViews.slice(0, 10).map((video) => ({
      rank: video.rank,
      title: video.title,
      uploader: video.uploader,
      views: video.detail?.view ?? video.views,
      like: video.detail?.like ?? null,
      duration: video.detail?.duration ?? video.duration,
      reason: video.reason,
      bvid: video.bvid,
      url: video.url,
    })),
  }
}

function createTools({ config, store }) {
  return [
    defineTool({
      name: 'bilibili_weekly',
      description: '读取 B 站「每周必看」榜单（https://www.bilibili.com/v/popular/weekly）并生成周报。action=list 列出所有期数；latest 取最新一期榜单概览；week 取指定期数（number）；report 生成 Markdown 周报并写入文件（outputPath 可指定路径）。默认会补抓每条视频的播放/点赞/投币等详情。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['latest', 'week', 'report', 'list'],
            description: 'latest=最新一期概览（默认）；week=指定期数概览；report=生成 Markdown 周报并落盘；list=列出可用期数。',
          },
          number: { type: 'number', description: '期数，例如 397。缺省为最新一期。' },
          top: { type: 'number', description: '榜单展示条数（默认取配置 topN，通常 10）。' },
          outputPath: { type: 'string', description: 'report 动作的输出文件路径。绝对路径按原样写入；相对路径写入插件的 reports 目录。缺省为 reports/B站每周必看-第N期.md。返回里同时带 markdown 正文。' },
          enrich: { type: 'boolean', description: '是否补抓每条视频的详情数据（默认 true）。' },
          refresh: { type: 'boolean', description: '跳过缓存强制重新抓取（默认 false）。' },
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => renderJson(value) },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const action = String(args.action ?? 'latest')
        const signal = exec?.signal
        if (action === 'list') {
          const series = await store.ensureSeries({ refresh: args.refresh === true, signal })
          return {
            action,
            page: WEEK_PAGE,
            count: series.length,
            weeks: series.slice(0, 60).map((row) => ({ number: row.number, subject: row.subject, name: row.name })),
          }
        }
        const series = await store.ensureSeries({ refresh: args.refresh === true, signal })
        if (series.length === 0) throw new Error('每周必看期数列表为空：请检查网络后重试')
        const number = Number(args.number) > 0 ? Math.round(Number(args.number)) : series[0].number
        const seriesRow = series.find((row) => row.number === number) ?? series[0]
        const week = await store.ensureWeek(number, {
          refresh: args.refresh === true,
          enrich: args.enrich !== false && config.enrich,
          signal,
        })
        const { markdown, stats } = buildReport(week, seriesRow, { topN: args.top ?? config.topN })
        if (action === 'report') {
          const requested = typeof args.outputPath === 'string' ? args.outputPath.trim() : ''
          const target = requested === ''
            ? path.join(config.reportDir, `B站每周必看-第${number}期.md`)
            : (path.isAbsolute(requested) ? requested : path.join(config.reportDir, requested))
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, markdown, 'utf8')
          return {
            action,
            ok: true,
            number,
            subject: week.subject,
            file: target,
            bytes: Buffer.byteLength(markdown, 'utf8'),
            summary: summariseWeek(week, stats, seriesRow),
            markdown,
          }
        }
        return { action, ok: true, ...summariseWeek(week, stats, seriesRow) }
      },
    }),
  ]
}

/* ------------------------------------------------------------------ panel */

function jsonResponse(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function textResponse(res, status, text, contentType) {
  res.statusCode = status
  res.setHeader('content-type', contentType)
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function panelStatePayload(week, seriesRow, series, stats) {
  return {
    ok: true,
    at: Date.now(),
    page: `${WEEK_PAGE}?num=${week.number}`,
    series: series.slice(0, 60).map((row) => ({ number: row.number, subject: row.subject, name: row.name })),
    week: {
      number: week.number,
      subject: week.subject,
      label: week.label,
      name: seriesRow?.name ?? '',
      period: weekPeriod(seriesRow),
      reminder: week.reminder,
      fetchedAt: week.fetchedAt,
      enriched: stats.enrichedCount,
      count: stats.count,
    },
    stats: {
      totalViews: stats.totalViews,
      averageViews: stats.averageViews,
      medianViews: stats.medianViews,
      totalDuration: stats.totalDuration,
      uploaders: stats.uploaders.length,
      engagement: stats.engagement,
      categories: stats.categories.map((row) => ({ label: row.label, count: row.count })),
    },
    videos: week.videos.map((video) => ({
      rank: video.rank,
      bvid: video.bvid,
      title: video.title,
      uploader: video.uploader,
      cover: video.cover,
      url: video.url,
      durationText: video.durationText || fmtClock(video.detail?.duration ?? video.duration),
      views: video.detail?.view ?? video.views,
      like: video.detail?.like ?? 0,
      coins: video.detail?.coin ?? 0,
      favorite: video.detail?.favorite ?? 0,
      danmaku: video.detail?.danmaku ?? 0,
      reason: video.reason,
      category: categoryOf(video).group,
      publishedText: video.publishedText,
    })),
  }
}

function registerPanel(ctx, config, store, runtime) {
  if (ctx.get('webServer')) {
    mountPanel(ctx, config, store, runtime)
    return
  }
  ctx.effect(() => ctx.inject(['webServer'], (scope) => { mountPanel(scope, config, store, runtime) }))
}

function mountPanel(ctx, config, store, runtime) {
  const webServer = ctx.get('webServer') ?? ctx.webServer
  if (!webServer) return
  const token = randomUUID()
  const coverCache = new Map()

  /**
   * 面板鉴权。Web 端把每次 fetch 都送进共享的 /api handler，浏览器请求到这里时
   * Sec-Fetch-Site 可能是 'cross-site'（实际是同源的 /bilibili-weekly → /api）。
   *
   * 只放行两种情况，其余一律 401：
   *  - Cookie 会话或 Authorization 头存在 → 说明请求来自已登录的 Harness 页面；
   *  - 带索引注入的 x-bilibili-weekly-token。
   * 仅凭 Sec-Fetch-Site 判断不足以证明身份（curl 也能伪造），因此不再单独作为放行依据。
   */
  function authorized(req) {
    if (req.headers['x-bilibili-weekly-token'] === token) return true
    const cookie = String(req.headers.cookie ?? '')
    if (cookie.trim() !== '') return true
    const auth = String(req.headers.authorization ?? '')
    if (auth.trim() !== '') return true
    return false
  }

  /**
   * 面板数据。`light` 只取榜单原始数据（含封面），不补抓每条视频详情——
   * 封面背景只需要封面地址，避免为了壁纸打满一次 enrich。
   */
  async function stateFor(number, refresh, signal, light) {
    const series = await store.ensureSeries({ refresh, signal })
    if (series.length === 0) throw new Error('期数列表为空')
    const picked = Number(number) > 0 ? Math.round(Number(number)) : series[0].number
    const seriesRow = series.find((row) => row.number === picked) ?? series[0]
    const week = await store.ensureWeek(picked, {
      refresh,
      enrich: config.enrich && !light,
      signal,
    })
    return panelStatePayload(week, seriesRow, series, buildStats(week))
  }

  async function imageFor(url) {
    const cached = coverCache.get(url)
    if (cached) return cached
    const parsed = new URL(url)
    if (!/(^|\.)hdslb\.com$|(^|\.)biliimg\.com$/.test(parsed.hostname)) throw new Error('cover host not allowed')
    const response = await fetch(parsed.toString(), { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' } })
    if (!response.ok) throw new Error(`cover HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const entry = { body: buffer, type: response.headers.get('content-type') || 'image/jpeg' }
    if (coverCache.size > 300) coverCache.clear()
    coverCache.set(url, entry)
    return entry
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/bilibili-weekly/state',
    handler: async (req, res) => {
      if (!authorized(req)) return jsonResponse(res, 401, { ok: false, error: 'unauthorized' })
      const url = new URL(req.url ?? '/bilibili-weekly/state', 'http://localhost')
      try {
        const number = Number(url.searchParams.get('number') ?? 0)
        const payload = await stateFor(
          number,
          url.searchParams.get('refresh') === '1',
          undefined,
          url.searchParams.get('light') === '1',
        )
        jsonResponse(res, 200, payload)
      } catch (error) {
        jsonResponse(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/bilibili-weekly/report',
    handler: async (req, res) => {
      if (!authorized(req)) return textResponse(res, 401, 'unauthorized', 'text/plain; charset=utf-8')
      const url = new URL(req.url ?? '/bilibili-weekly/report', 'http://localhost')
      try {
        const series = await store.ensureSeries({})
        if (series.length === 0) throw new Error('期数列表为空')
        const number = Number(url.searchParams.get('number') ?? 0) > 0
          ? Math.round(Number(url.searchParams.get('number')))
          : series[0].number
        const seriesRow = series.find((row) => row.number === number) ?? series[0]
        const week = await store.ensureWeek(number, { enrich: config.enrich })
        const { markdown } = buildReport(week, seriesRow, { topN: config.topN })
        runtime.lastReport = { number, at: Date.now() }
        textResponse(res, 200, markdown, 'text/markdown; charset=utf-8')
      } catch (error) {
        textResponse(res, 500, `# 生成失败\n\n${error instanceof Error ? error.message : String(error)}\n`, 'text/markdown; charset=utf-8')
      }
    },
  }))

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/bilibili-weekly/cover',
    handler: async (req, res) => {
      if (!authorized(req)) return jsonResponse(res, 401, { ok: false, error: 'unauthorized' })
      const url = new URL(req.url ?? '/bilibili-weekly/cover', 'http://localhost')
      const target = url.searchParams.get('u') ?? ''
      if (!target) return jsonResponse(res, 400, { ok: false, error: 'missing u' })
      try {
        const image = await imageFor(target)
        res.statusCode = 200
        res.setHeader('content-type', image.type)
        res.setHeader('cache-control', 'public, max-age=86400')
        res.end(image.body)
      } catch (error) {
        jsonResponse(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  ctx.effect(() => webServer.tapIndex((html) => html.replace(
    '</head>',
    `<script>window.__BILI_WEEKLY__=${JSON.stringify({
      api: '/bilibili-weekly',
      token,
      wall: config.enableWallpaper ? 1 : 0,
      wallSpeed: config.wallSpeed,
      wallVeil: config.wallVeil,
    })}</script></head>`,
  )))
}

/* ------------------------------------------------------------------ skill */

function registerSkill(ctx, config) {
  if (!config.registerSkill) return
  const skills = ctx.get('skills')
  if (!skills) return
  const content = [
    '# B站每周必看 · 周报',
    '',
    '这个插件把「哔哩哔哩每周必看」榜单抓成本地数据，并生成可读周报。',
    '',
    '## 用法',
    '1. `bilibili_weekly` `{ "action": "latest" }` —— 最新一期：主题、周期、播放/分区/UP 主概览 + TOP10。',
    '2. `bilibili_weekly` `{ "action": "week", "number": 396 }` —— 指定期数。',
    '3. `bilibili_weekly` `{ "action": "report", "number": 397, "outputPath": "reports/xxx.md" }` ——',
    '   生成 Markdown 周报并落盘，返回 `file` 路径与正文。',
    '4. `bilibili_weekly` `{ "action": "list" }` —— 可选期数。',
    '',
    '## 说明',
    '- Web 端右侧周报面板可切换期数、生成周报；面板标题栏的九宫格按钮开关「封面背景」。',
    '- 封面背景：当期榜单封面铺满客户端背景并缓慢向上滚动，薄纱浓度与速度由 `wallVeil` / `wallSpeed` 配置。',
    '- 数据来自 `app.bilibili.com/x/v2/show/popular/selected`（页面 Web 接口对匿名客户端返回 -352 风控）。',
    '- 每条视频会再补抓 `x/web-interface/view` 得到播放/点赞/投币/收藏/弹幕/时长。',
    '- 结果缓存在 `~/.dsh/bilibili-weekly/cache.json`；`refresh: true` 跳过缓存。',
    '- Web 端右侧面板与工具共用同一份数据。',
  ].join('\n')

  ctx.effect(() => skills.register({
    name: 'bilibili-weekly',
    description: '抓取 B站「每周必看」榜单并生成周报：期数列表、榜单概览、Markdown 周报（含分区分布与 UP 主统计）。',
    whenToUse: '用户提到「B站每周必看」「哔哩哔哩周榜」「出一份 B站周报」，或需要某期每周必看榜单数据时。',
    source: 'bundled',
    provider: 'dsh-bilibili-weekly',
    content,
  }))
}

/* ------------------------------------------------------------------ apply */

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const store = createStore(config)
  const runtime = { lastReport: null, startedAt: Date.now() }
  for (const tool of createTools({ config, store })) {
    ctx.effect(() => ctx.tools.register(tool))
  }
  registerSkill(ctx, config)
  if (config.enablePanel) registerPanel(ctx, config, store, runtime)
}
