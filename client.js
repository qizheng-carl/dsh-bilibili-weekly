window.__ModuleLoader__.load({
  id: 'dsh-bilibili-weekly',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const DICT = {
      en: {
        title: 'Bilibili Weekly',
        subtitle: 'Weekly must-watch digest',
        refresh: 'Refresh',
        report: 'Report',
        list: 'List',
        collapse: 'Collapse',
        expand: 'Expand',
        week: 'Week',
        loading: 'Loading the weekly list…',
        error: 'Failed to load',
        retry: 'Retry',
        videos: 'videos',
        views: 'views',
        avg: 'avg',
        uploaders: 'uploaders',
        duration: 'total',
        openOnBilibili: 'Open on Bilibili',
        copy: 'Copy',
        copied: 'Copied',
        closeReport: 'Back to list',
        empty: 'No entries for this week yet.',
        rank: 'Rank',
        noReport: 'Generating report…',
        wallOn: 'Cover wallpaper: on',
        wallOff: 'Cover wallpaper: off',
      },
      zh: {
        title: 'B站每周必看',
        subtitle: '每期榜单 · 一页周报',
        refresh: '刷新',
        report: '周报',
        list: '榜单',
        collapse: '收起',
        expand: '展开',
        week: '期数',
        loading: '正在读取每周必看榜单…',
        error: '加载失败',
        retry: '重试',
        videos: '条',
        views: '播放',
        avg: '平均',
        uploaders: 'UP主',
        duration: '时长',
        openOnBilibili: '在 B站 打开',
        copy: '复制',
        copied: '已复制',
        closeReport: '看榜单',
        empty: '本期暂无数据。',
        rank: '排名',
        noReport: '正在生成周报…',
        wallOn: '封面背景：开（点按关闭）',
        wallOff: '封面背景：关（点按开启）',
      },
    }

    const TOKENS = {
      bg: 'var(--dsw-alias-bg-layer-1, #fff)',
      bgSoft: 'var(--dsw-alias-bg-layer-2, #f7f7f8)',
      text: 'var(--dsw-alias-label-primary, #111)',
      textSoft: 'var(--dsw-alias-label-secondary, #6b7280)',
      border: 'var(--dsw-alias-border-l1, rgba(0,0,0,.1))',
      brand: 'var(--dsw-alias-brand-primary, #fb7299)',
      danger: 'var(--dsw-alias-state-error-primary, #d33)',
    }

    function fmtCount(value) {
      const number = Number(value) || 0
      if (number >= 1e8) return `${(number / 1e8).toFixed(2)}亿`
      if (number >= 1e4) return `${(number / 1e4).toFixed(number >= 1e6 ? 0 : 1)}万`
      return String(number)
    }

    function fmtDuration(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
      if (minutes > 0) return `${minutes}m`
      return `${total}s`
    }

    /* ------------------------------------------------------------ markdown */

    function inline(text, keyPrefix) {
      const nodes = []
      const pattern = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|`[^`]+`)/g
      let last = 0
      let match
      let index = 0
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index))
        const token = match[0]
        const key = `${keyPrefix}-i${index++}`
        if (token.startsWith('**')) {
          nodes.push(h('strong', { key }, token.slice(2, -2)))
        } else if (token.startsWith('`')) {
          nodes.push(h('code', {
            key,
            style: {
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '0.92em',
              background: TOKENS.bgSoft,
              padding: '1px 4px',
              borderRadius: 4,
            },
          }, token.slice(1, -1)))
        } else {
          const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
          nodes.push(h('a', {
            key,
            href: link[2],
            target: '_blank',
            rel: 'noreferrer',
            style: { color: TOKENS.brand, textDecoration: 'none' },
          }, link[1]))
        }
        last = match.index + token.length
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    function splitRow(line) {
      return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
    }

    function renderMarkdown(markdown, keyPrefix) {
      const lines = String(markdown ?? '').split('\n')
      const blocks = []
      let index = 0
      let listBuffer = []
      let tableBuffer = []

      const flushList = () => {
        if (listBuffer.length === 0) return
        blocks.push(h('ul', { key: `${keyPrefix}-ul-${blocks.length}`, style: { margin: '4px 0', paddingLeft: 18 } },
          listBuffer.map((item, itemIndex) => h('li', { key: itemIndex, style: { margin: '2px 0' } }, inline(item, `${keyPrefix}-li-${itemIndex}`)))))
        listBuffer = []
      }
      const flushTable = () => {
        if (tableBuffer.length === 0) return
        const rows = tableBuffer.filter((row) => !/^\|?\s*:?-{2,}/.test(row))
        if (rows.length === 0) {
          tableBuffer = []
          return
        }
        const header = splitRow(rows[0])
        const body = rows.slice(1).map(splitRow)
        blocks.push(h('table', {
          key: `${keyPrefix}-tb-${blocks.length}`,
          style: { borderCollapse: 'collapse', width: '100%', margin: '6px 0', fontSize: 11.5 },
        },
          h('thead', null, h('tr', null, header.map((cell, cellIndex) => h('th', {
            key: cellIndex,
            style: {
              textAlign: 'left', padding: '4px 6px', borderBottom: `1px solid ${TOKENS.border}`,
              color: TOKENS.textSoft, fontWeight: 600, whiteSpace: 'nowrap',
            },
          }, inline(cell, `${keyPrefix}-th-${cellIndex}`))))),
          h('tbody', null, body.map((cells, rowIndex) => h('tr', { key: rowIndex },
            cells.map((cell, cellIndex) => h('td', {
              key: cellIndex,
              style: {
                padding: '4px 6px', borderBottom: `1px solid ${TOKENS.border}`,
                verticalAlign: 'top', wordBreak: 'break-word',
              },
            }, inline(cell, `${keyPrefix}-td-${rowIndex}-${cellIndex}`))))))))
        tableBuffer = []
      }
      const flushAll = () => {
        flushList()
        flushTable()
      }

      while (index < lines.length) {
        const line = lines[index]
        const trimmed = line.trim()
        if (trimmed === '') {
          flushAll()
          index += 1
          continue
        }
        if (trimmed.startsWith('|')) {
          flushList()
          tableBuffer.push(trimmed)
          index += 1
          continue
        }
        flushTable()
        if (/^#{1,4}\s/.test(trimmed)) {
          flushList()
          const depth = trimmed.match(/^#+/)[0].length
          const text = trimmed.replace(/^#+\s*/, '')
          blocks.push(h(`h${Math.min(4, depth + 1)}`, {
            key: `${keyPrefix}-h-${blocks.length}`,
            style: {
              margin: depth <= 2 ? '12px 0 6px' : '8px 0 4px',
              fontSize: depth <= 2 ? 15 : 13,
              fontWeight: 650,
              color: TOKENS.text,
            },
          }, inline(text, `${keyPrefix}-h-${blocks.length}`)))
        } else if (trimmed.startsWith('>')) {
          flushList()
          blocks.push(h('blockquote', {
            key: `${keyPrefix}-q-${blocks.length}`,
            style: {
              margin: '6px 0', padding: '2px 0 2px 10px',
              borderLeft: `3px solid ${TOKENS.border}`, color: TOKENS.textSoft,
            },
          }, inline(trimmed.replace(/^>\s?/, ''), `${keyPrefix}-q-${blocks.length}`)))
        } else if (/^[-*]\s/.test(trimmed)) {
          listBuffer.push(trimmed.replace(/^[-*]\s+/, ''))
        } else if (/^\d+\.\s/.test(trimmed)) {
          listBuffer.push(trimmed.replace(/^\d+\.\s+/, ''))
        } else if (/^-{3,}$/.test(trimmed)) {
          flushList()
          blocks.push(h('hr', { key: `${keyPrefix}-hr-${blocks.length}`, style: { border: 'none', borderTop: `1px solid ${TOKENS.border}`, margin: '10px 0' } }))
        } else {
          flushList()
          blocks.push(h('p', {
            key: `${keyPrefix}-p-${blocks.length}`,
            style: { margin: '4px 0', lineHeight: 1.65 },
          }, inline(trimmed, `${keyPrefix}-p-${blocks.length}`)))
        }
        index += 1
      }
      flushAll()
      return blocks
    }

    /* --------------------------------------------------------------- panel */

    function apiBase() {
      const cfg = window.__BILI_WEEKLY__ || {}
      return { base: typeof cfg.api === 'string' && cfg.api ? cfg.api : '/bilibili-weekly', token: cfg.token || '' }
    }

    /* ----------------------------------------------------------- wallpaper */

    // 封面墙网格：4 列 × 3 行作为一份，垂直复制一份做无缝循环，整体向上平移一份的高度。
    const WALL_COLS = 4
    const WALL_ROWS = 3
    const WALL_ROW_VH = 34
    const WALL_GAP = 0.9
    const WALL_UNIQUE = WALL_COLS * WALL_ROWS
    const WALL_KEY = 'dsh.bilibili-weekly.wall'

    function wallOptions() {
      const cfg = window.__BILI_WEEKLY__ || {}
      const speed = Number(cfg.wallSpeed)
      const veil = Number(cfg.wallVeil)
      return {
        enabled: cfg.wall !== 0,
        speed: Number.isFinite(speed) && speed >= 10 ? speed : 60,
        veil: Number.isFinite(veil) ? Math.min(0.92, Math.max(0.1, veil)) : 0.78,
      }
    }

    const wallPref = {
      value: (() => {
        try { return window.localStorage.getItem(WALL_KEY) !== '0' } catch { return true }
      })(),
      listeners: new Set(),
    }

    function setWallPref(next) {
      wallPref.value = next
      try { window.localStorage.setItem(WALL_KEY, next ? '1' : '0') } catch { /* ignore */ }
      for (const listener of wallPref.listeners) listener(next)
    }

    function useWallPref() {
      const [on, setOn] = React.useState(wallPref.value)
      React.useEffect(() => {
        const listener = (next) => setOn(next)
        wallPref.listeners.add(listener)
        setOn(wallPref.value)
        return () => { wallPref.listeners.delete(listener) }
      }, [])
      return [on, setWallPref]
    }

    const wallCache = { promise: null, covers: [], at: 0 }

    /**
     * 取本周封面的代理地址（不走直连，避免 B站 CDN 的 referer 限制）。
     * 与面板共用同一份 Host 缓存，30 分钟内不重复请求。
     */
    function loadWallCovers() {
      if (wallCache.covers.length > 0 && Date.now() - wallCache.at < 30 * 60 * 1000) {
        return Promise.resolve(wallCache.covers)
      }
      if (wallCache.promise) return wallCache.promise
      const { base, token } = apiBase()
      wallCache.promise = fetch(`${base}/state?light=1`, {
        headers: token ? { 'x-bilibili-weekly-token': token } : {},
        cache: 'no-store',
      })
        .then((response) => (response.ok ? response.json().catch(() => null) : null))
        .then((body) => {
          const videos = body && Array.isArray(body.videos) ? body.videos : []
          const seen = new Set()
          const covers = []
          for (const video of videos) {
            const raw = video && typeof video.cover === 'string' ? video.cover : ''
            if (raw === '' || seen.has(raw)) continue
            seen.add(raw)
            covers.push(`${base}/cover?u=${encodeURIComponent(raw)}`)
          }
          wallCache.covers = covers
          wallCache.at = Date.now()
          return covers
        })
        .catch(() => wallCache.covers)
        .then((covers) => {
          wallCache.promise = null
          return covers
        })
      return wallCache.promise
    }

    function shuffle(list, seed) {
      const out = list.slice()
      let state = seed || 1
      for (let index = out.length - 1; index > 0; index -= 1) {
        state = (state * 1103515245 + 12345) & 0x7fffffff
        const swap = state % (index + 1)
        const value = out[index]
        out[index] = out[swap]
        out[swap] = value
      }
      return out
    }

    /**
     * 生成封面墙的 CSS：`html::before` 承载封面（GPU 平移），`html::after` 压一层
     * 与主题匹配的薄纱保证正文可读；同时把 `--dsw-alias-bg-base` 换成透明，
     * 让会话区透出封面。背景层排在负 z-index，位于所有内容之下。
     */
    function buildWallCss(covers, options) {
      const unique = shuffle(covers.slice(0, WALL_UNIQUE), covers.length)
      if (unique.length === 0) return ''
      const cellW = 100 / WALL_COLS
      const imageW = cellW - WALL_GAP
      const imageH = WALL_ROW_VH - WALL_GAP
      const images = []
      const sizes = []
      const positions = []
      for (let row = 0; row < WALL_ROWS * 2; row += 1) {
        for (let col = 0; col < WALL_COLS; col += 1) {
          const slot = (row % WALL_ROWS) * WALL_COLS + col
          const cover = unique[slot % unique.length]
          images.push(`url("${cover}")`)
          sizes.push(`${imageW.toFixed(3)}vw ${imageH.toFixed(3)}vh`)
          positions.push(`${(col * cellW + WALL_GAP / 2).toFixed(3)}vw ${(row * WALL_ROW_VH + WALL_GAP / 2).toFixed(3)}vh`)
        }
      }
      const period = (WALL_ROWS * WALL_ROW_VH).toFixed(2)
      const height = (WALL_ROWS * 2 * WALL_ROW_VH).toFixed(2)
      const veil = options.veil
      const lightTop = Math.max(0.12, veil - 0.08).toFixed(3)
      const lightBottom = Math.min(0.95, veil + 0.08).toFixed(3)
      const darkTop = Math.max(0.12, veil - 0.06).toFixed(3)
      const darkBottom = Math.min(0.96, veil + 0.1).toFixed(3)
      return `
html { background-color: #eef0f4; }
html::before {
  content: "";
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: ${height}vh;
  z-index: -2;
  pointer-events: none;
  background-image: ${images.join(', ')};
  background-size: ${sizes.join(', ')};
  background-position: ${positions.join(', ')};
  background-repeat: no-repeat;
  transform: translate3d(0, 0, 0);
  animation: bilibili-weekly-wall ${options.speed}s linear infinite;
  will-change: transform;
}
html::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background: linear-gradient(180deg, rgba(255,255,255,${lightTop}), rgba(255,255,255,${lightBottom}));
}
html:has(body[data-ds-dark-theme]) { background-color: #16171b; }
html:has(body[data-ds-dark-theme])::after {
  background: linear-gradient(180deg, rgba(9,10,14,${darkTop}), rgba(9,10,14,${darkBottom}));
}
@keyframes bilibili-weekly-wall {
  from { transform: translate3d(0, 0, 0); }
  to { transform: translate3d(0, -${period}vh, 0); }
}
@media (prefers-reduced-motion: reduce) {
  html::before { animation: none; }
}
`
    }

    function Wallpaper(props) {
      const ctx = props.ctx
      const options = wallOptions()
      const [enabled] = useWallPref()
      const [covers, setCovers] = React.useState(wallCache.covers)
      const active = options.enabled && enabled

      React.useEffect(() => {
        if (!active) return undefined
        let alive = true
        loadWallCovers().then((next) => {
          if (alive && Array.isArray(next) && next.length > 0) setCovers(next)
        })
        return () => { alive = false }
      }, [active])

      const ready = active && covers.length > 0

      // 只有封面就绪后才把会话区背景变透明，避免加载期间露出空窗。
      React.useEffect(() => {
        if (!ready) return undefined
        const theme = ctx && typeof ctx.get === 'function' ? ctx.get('theme') : null
        if (!theme || typeof theme.overrideTokens !== 'function') return undefined
        return theme.overrideTokens('dsh-bilibili-weekly', {
          '--dsw-alias-bg-base': { light: 'transparent', dark: 'transparent' },
        })
      }, [ready, ctx])

      if (!ready) return null
      return h('style', { 'data-bilibili-weekly-wall': '' }, buildWallCss(covers, options))
    }

    function chip(label, value) {
      return h('div', {
        key: `${label}-${value}`,
        style: {
          display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0,
          padding: '5px 8px', borderRadius: 8, background: TOKENS.bgSoft,
          flex: '1 1 0',
        },
      },
        h('span', { style: { fontSize: 10, color: TOKENS.textSoft, letterSpacing: '.02em' } }, label),
        h('span', { style: { fontSize: 13, fontWeight: 650, color: TOKENS.text, fontVariantNumeric: 'tabular-nums' } }, value))
    }

    function panelStyle(collapsed) {
      return {
        position: 'fixed',
        right: 12,
        // 让开右上角的状态胶囊（其他插件也会用 shell.overlay 的同一角）。
        top: 128,
        width: collapsed ? 'auto' : 392,
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: 'calc(100vh - 152px)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 58,
        borderRadius: 12,
        background: TOKENS.bg,
        border: `1px solid ${TOKENS.border}`,
        boxShadow: '0 10px 30px rgba(0,0,0,.14)',
        color: TOKENS.text,
        fontSize: 12,
        lineHeight: 1.5,
        pointerEvents: 'auto',
      }
    }

    function buttonStyle(active) {
      return {
        border: 'none',
        borderRadius: 7,
        padding: '4px 9px',
        fontSize: 11.5,
        cursor: 'pointer',
        background: active ? TOKENS.brand : TOKENS.bgSoft,
        color: active ? '#fff' : TOKENS.text,
        fontFamily: 'inherit',
      }
    }

    function VideoRow({ video, onOpen }) {
      const cover = video.cover
        ? `${apiBase().base}/cover?u=${encodeURIComponent(video.cover)}`
        : ''
      return h('div', {
        style: {
          display: 'flex', gap: 8, padding: '6px 4px', alignItems: 'flex-start',
          borderBottom: `1px solid ${TOKENS.border}`, minWidth: 0,
        },
      },
        h('div', {
          style: {
            width: 18, flex: '0 0 auto', textAlign: 'center', fontSize: 11,
            fontWeight: 700, color: video.rank <= 3 ? TOKENS.brand : TOKENS.textSoft,
            fontVariantNumeric: 'tabular-nums', paddingTop: 2,
          },
        }, video.rank),
        h('a', {
          href: video.url,
          target: '_blank',
          rel: 'noreferrer',
          style: {
            width: 74, height: 46, flex: '0 0 auto', borderRadius: 6, overflow: 'hidden',
            background: TOKENS.bgSoft, display: 'block', border: `1px solid ${TOKENS.border}`,
          },
        },
          cover
            ? h('img', {
              src: cover,
              alt: '',
              loading: 'lazy',
              style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
            })
            : null),
        h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
          h('a', {
            href: video.url,
            target: '_blank',
            rel: 'noreferrer',
            title: video.title,
            style: {
              display: 'block', color: TOKENS.text, textDecoration: 'none',
              fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap', fontSize: 12,
            },
          }, video.title),
          h('div', {
            style: {
              display: 'flex', gap: 6, color: TOKENS.textSoft, fontSize: 10.5,
              overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', marginTop: 1,
            },
          },
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, video.uploader),
            h('span', null, '·'),
            h('span', null, `${fmtCount(video.views)} 播放`),
            h('span', null, '·'),
            h('span', null, video.durationText)),
          video.reason
            ? h('div', {
              title: video.reason,
              style: {
                color: TOKENS.textSoft, fontSize: 10.5, marginTop: 1,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, `💡 ${video.reason}`)
            : null),
      )
    }

    function Panel(props) {
      const t = props.t
      const [collapsed, setCollapsed] = React.useState(() => {
        try { return window.localStorage.getItem('dsh.bilibili-weekly.collapsed') === '1' } catch { return false }
      })
      const [state, setState] = React.useState({ loading: true, data: null, error: '' })
      const [number, setNumber] = React.useState(0)
      const [mode, setMode] = React.useState('list')
      const [report, setReport] = React.useState({ loading: false, markdown: '', error: '' })
      const [copied, setCopied] = React.useState(false)
      const [wallOn, setWallOn] = useWallPref()
      const wallFeature = wallOptions().enabled
      const alive = React.useRef(true)

      React.useEffect(() => () => { alive.current = false }, [])

      const load = React.useCallback(async (targetNumber, refresh) => {
        const { base, token } = apiBase()
        const query = []
        if (targetNumber > 0) query.push(`number=${targetNumber}`)
        if (refresh) query.push('refresh=1')
        const url = `${base}/state${query.length > 0 ? `?${query.join('&')}` : ''}`
        try {
          const response = await fetch(url, {
            headers: token ? { 'x-bilibili-weekly-token': token } : {},
            cache: 'no-store',
          })
          const body = await response.json().catch(() => null)
          if (!alive.current) return
          if (!response.ok || !body || body.ok === false) {
            setState({ loading: false, data: null, error: (body && body.error) || `HTTP ${response.status}` })
            return
          }
          setState({ loading: false, data: body, error: '' })
          setNumber(body.week?.number ?? 0)
        } catch (error) {
          if (alive.current) setState({ loading: false, data: null, error: error && error.message ? error.message : String(error) })
        }
      }, [])

      React.useEffect(() => { load(0, false) }, [load])

      const loadReport = React.useCallback(async (targetNumber) => {
        const { base, token } = apiBase()
        setReport({ loading: true, markdown: '', error: '' })
        try {
          const response = await fetch(`${base}/report${targetNumber > 0 ? `?number=${targetNumber}` : ''}`, {
            headers: token ? { 'x-bilibili-weekly-token': token } : {},
            cache: 'no-store',
          })
          const text = await response.text()
          if (!alive.current) return
          if (!response.ok) {
            setReport({ loading: false, markdown: '', error: `HTTP ${response.status}` })
            return
          }
          setReport({ loading: false, markdown: text, error: '' })
        } catch (error) {
          if (alive.current) setReport({ loading: false, markdown: '', error: error && error.message ? error.message : String(error) })
        }
      }, [])

      const toggle = () => {
        const next = !collapsed
        setCollapsed(next)
        try { window.localStorage.setItem('dsh.bilibili-weekly.collapsed', next ? '1' : '0') } catch { /* ignore */ }
      }

      const data = state.data
      const week = data?.week
      const stats = data?.stats
      const videos = data?.videos ?? []
      const series = data?.series ?? []
      const header = h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
          borderBottom: collapsed ? 'none' : `1px solid ${TOKENS.border}`,
          cursor: 'pointer',
        },
        onClick: toggle,
        role: 'button',
        'aria-expanded': !collapsed,
        title: collapsed ? t('expand') : t('collapse'),
      },
        h('span', {
          style: {
            width: 22, height: 22, borderRadius: 6, flex: '0 0 auto',
            background: 'linear-gradient(135deg, #ff9db8, #fb7299)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700,
          },
        }, '周'),
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { fontWeight: 650, fontSize: 12.5, whiteSpace: 'nowrap' } }, t('title')),
          h('div', { style: { color: TOKENS.textSoft, fontSize: 10.5, whiteSpace: 'nowrap' } },
            week ? `第 ${week.number} 期 · ${week.subject || '—'}` : t('subtitle'))),
        wallFeature
          ? h('button', {
            type: 'button',
            title: wallOn ? t('wallOn') : t('wallOff'),
            'aria-pressed': wallOn,
            onClick: (event) => {
              event.stopPropagation()
              setWallOn(!wallOn)
            },
            style: {
              marginLeft: 'auto', flex: '0 0 auto', width: 22, height: 22, padding: 0,
              border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11,
              background: wallOn ? TOKENS.brand : TOKENS.bgSoft,
              color: wallOn ? '#fff' : TOKENS.textSoft,
            },
          }, h('svg', {
            width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true', focusable: 'false',
          }, [0, 6].map((y) => [0, 6].map((x) => h('rect', {
            key: `${x}-${y}`, x, y, width: 5, height: 5, rx: 1.2, fill: 'currentColor',
          })))))
          : null,
        h('span', {
          style: { marginLeft: wallFeature ? 6 : 'auto', color: TOKENS.textSoft, fontSize: 11 },
        }, collapsed ? '▸' : '▾'))

      if (collapsed) return h('div', { style: panelStyle(true) }, header)

      const toolbar = h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: `1px solid ${TOKENS.border}`, flexWrap: 'wrap' },
      },
        series.length > 0
          ? h('select', {
            value: String(number || (week ? week.number : '')),
            onChange: (event) => {
              const picked = Number(event.target.value) || 0
              setNumber(picked)
              setMode('list')
              load(picked, false)
            },
            style: {
              flex: '1 1 140px', minWidth: 0, fontSize: 11.5, padding: '3px 4px',
              borderRadius: 7, border: `1px solid ${TOKENS.border}`, background: TOKENS.bg, color: TOKENS.text,
            },
          }, series.map((row) => h('option', { key: row.number, value: String(row.number) },
            `第${row.number}期 · ${row.subject || ''}`)))
          : null,
        h('button', {
          style: buttonStyle(mode === 'list'),
          onClick: () => { setMode('list'); load(number, false) },
          title: t('refresh'),
        }, t('list')),
        h('button', {
          style: buttonStyle(mode === 'report'),
          onClick: () => { setMode('report'); loadReport(number) },
        }, t('report')),
        h('button', {
          style: buttonStyle(false),
          onClick: () => load(number, true),
          title: t('refresh'),
        }, '↻'))

      let body = null
      if (state.loading) {
        body = h('div', { style: { padding: 14, color: TOKENS.textSoft } }, t('loading'))
      } else if (state.error) {
        body = h('div', { style: { padding: 14 } },
          h('div', { style: { color: TOKENS.danger, marginBottom: 6 } }, `${t('error')}: ${state.error}`),
          h('button', { style: buttonStyle(false), onClick: () => load(number, true) }, t('retry')))
      } else if (mode === 'report') {
        body = h('div', { style: { overflow: 'auto', padding: '8px 10px 14px', minHeight: 0, flex: '1 1 auto' } },
          report.loading
            ? h('div', { style: { color: TOKENS.textSoft } }, t('noReport'))
            : report.error
              ? h('div', { style: { color: TOKENS.danger } }, report.error)
              : h('div', null,
                h('div', { style: { display: 'flex', gap: 6, marginBottom: 6 } },
                  h('button', {
                    style: buttonStyle(false),
                    onClick: async () => {
                      try {
                        await navigator.clipboard.writeText(report.markdown)
                        setCopied(true)
                        window.setTimeout(() => setCopied(false), 1500)
                      } catch { /* clipboard unavailable */ }
                    },
                  }, copied ? t('copied') : t('copy'))),
                ...renderMarkdown(report.markdown, `r${week ? week.number : 0}`)))
      } else if (!data) {
        body = h('div', { style: { padding: 14, color: TOKENS.textSoft } }, t('empty'))
      } else {
        const chips = h('div', { style: { display: 'flex', gap: 6, padding: '8px 10px 4px' } },
          chip(`${week.count} ${t('videos')}`, fmtCount(stats.totalViews)),
          chip(t('avg'), fmtCount(stats.averageViews)),
          chip(t('uploaders'), String(stats.uploaders)),
          chip(t('duration'), fmtDuration(stats.totalDuration)))
        const categoryLine = stats.categories.length > 0
          ? h('div', {
            style: {
              display: 'flex', gap: 4, padding: '2px 10px 6px', flexWrap: 'wrap',
              color: TOKENS.textSoft, fontSize: 10.5,
            },
          }, stats.categories.slice(0, 6).map((row) => h('span', {
            key: row.label,
            style: {
              padding: '1px 6px', borderRadius: 999, background: TOKENS.bgSoft,
              border: `1px solid ${TOKENS.border}`,
            },
          }, `${row.label} ${row.count}`)))
          : null
        body = h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' } },
          chips,
          categoryLine,
          h('div', { style: { overflow: 'auto', padding: '0 6px 10px', minHeight: 0, flex: '1 1 auto' } },
            videos.length === 0
              ? h('div', { style: { padding: 10, color: TOKENS.textSoft } }, t('empty'))
              : videos.map((video) => h(VideoRow, { key: `${video.bvid}-${video.rank}`, video }))))
      }

      const footer = h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
          borderTop: `1px solid ${TOKENS.border}`, color: TOKENS.textSoft, fontSize: 10.5,
        },
      },
        h('span', null, `${t('week')} ${week ? week.number : '—'}${week && week.period ? ` · ${week.period}` : ''}`),
        week
          ? h('a', {
            href: `${data.page}`,
            target: '_blank',
            rel: 'noreferrer',
            style: { marginLeft: 'auto', color: TOKENS.brand, textDecoration: 'none' },
          }, t('openOnBilibili'))
          : null)

      return h('div', { style: panelStyle(false) }, header, toolbar, body, footer)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        let t = (key, fallback) => fallback || key
        try {
          ctx.locale.register('bilibili-weekly', 'en', DICT.en)
          ctx.locale.register('bilibili-weekly', 'zh', DICT.zh)
          const bound = ctx.locale.bind('bilibili-weekly')
          t = (key, fallback) => bound(key) || fallback || key
        } catch (error) {
          console.error('bilibili-weekly: locale registration failed', error)
          t = (key, fallback) => DICT.zh[key] || fallback || key
        }

        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'bilibili-weekly', order: 78, label: 'B站每周必看' },
          (props) => h(Panel, { ...props, t }),
        ))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'bilibili-weekly-wall', order: 77, label: 'B站每周必看 · 封面背景' },
          (props) => h(Wallpaper, { ...props, ctx, t }),
        ))
      },
    }
  },
})
