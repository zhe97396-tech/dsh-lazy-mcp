// Browser half of the lazy MCP gateway: a sidebar entry plus the panel behind
// it.
//
// The shell owns the button. `sidebar.panellist` ids address the `main` panel
// key of the same name, so this module supplies only the icon — through the
// slot's SidebarPanelIconOwnerProps `{ size, active }` — and the panel body,
// and the shared id `lazy-mcp` wires the two together. There is no navigation
// code here on purpose.
//
// Host state arrives over the read-only JSON route the Host half registers at
// `/lazy-mcp/state`. No DSH Client package is imported: React comes from the
// browser module table, and every color is a theme token, so the panel follows
// light and dark without a second stylesheet.
window.__ModuleLoader__.load({
  id: 'dsh-lazy-mcp',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STATE_URL = '/lazy-mcp/state'
    const POLL_MS = 5_000
    // A connected server still counts as "in use" while its last call is fresh.
    // Beyond that it is connected but idle — a different state from dormant.
    const ACTIVE_WINDOW_MS = 120_000

    /** Presentation for each derived state: a label and one theme token. */
    const STATUS = {
      active: { label: '正在使用', token: '--dsw-alias-state-success-primary' },
      connected: { label: '已连接', token: '--dsw-alias-brand-primary' },
      connecting: { label: '连接中', token: '--dsw-alias-state-warn-primary' },
      dormant: { label: '休眠', token: '--dsw-alias-state-idle-primary' },
      failed: { label: '连接失败', token: '--dsw-alias-state-error-primary' },
    }

    /**
     * Derive the display state of one server.
     *
     * `failed` wins over the transport state because a server that is dormant
     * *because its last connect threw* is the case the user needs to see; the
     * Host keeps `status: 'dormant'` there and records `lastError` beside it.
     */
    function classify(server, now) {
      if (server.lastError) return 'failed'
      if (server.status === 'ready') {
        const usedAt = typeof server.lastUsedAt === 'number' ? server.lastUsedAt : 0
        return now - usedAt <= ACTIVE_WINDOW_MS ? 'active' : 'connected'
      }
      if (server.status === 'connecting') return 'connecting'
      return 'dormant'
    }

    /** Compact "how long ago", coarse on purpose: this is a glance, not a log. */
    function ago(at, now) {
      if (typeof at !== 'number' || at <= 0) return '从未'
      const seconds = Math.max(0, Math.round((now - at) / 1000))
      if (seconds < 60) return `${seconds} 秒前`
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return `${minutes} 分钟前`
      const hours = Math.round(minutes / 60)
      if (hours < 48) return `${hours} 小时前`
      return `${Math.round(hours / 24)} 天前`
    }

    // One poller for every consumer. The panel and the header chip ask the same
    // question, so they share one request and one timer instead of racing two
    // pollers against each other. Polling stops when the last consumer unmounts.
    const store = { snapshot: { phase: 'loading' }, listeners: new Set(), timer: undefined }

    function publish(next) {
      store.snapshot = next
      for (const listener of store.listeners) listener(next)
    }

    async function pollOnce() {
      try {
        const response = await fetch(STATE_URL, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        publish({ phase: 'ready', data: await response.json() })
      } catch (error) {
        // Keep the last good payload: a transient failure must not blank a
        // panel that was showing real state a second ago.
        publish({
          phase: 'error',
          message: String((error && error.message) || error),
          data: store.snapshot.data,
        })
      }
    }

    function schedule() {
      if (store.timer !== undefined) clearTimeout(store.timer)
      store.timer = setTimeout(() => {
        void pollOnce().then(schedule)
      }, POLL_MS)
    }

    function subscribe(listener) {
      store.listeners.add(listener)
      listener(store.snapshot)
      if (store.listeners.size === 1) void pollOnce().then(schedule)
      return () => {
        store.listeners.delete(listener)
        if (store.listeners.size === 0 && store.timer !== undefined) {
          clearTimeout(store.timer)
          store.timer = undefined
        }
      }
    }

    /** Subscribe to the shared snapshot; the second value forces a refresh. */
    function useMcpState() {
      const [snapshot, setSnapshot] = React.useState(store.snapshot)
      React.useEffect(() => subscribe(setSnapshot), [])
      return [snapshot, React.useCallback(() => void pollOnce(), [])]
    }

    /**
     * The idle-window control: the panel's only setting and its only write.
     *
     * Seconds, not milliseconds. The stored value is milliseconds and the Host
     * validates the range, but "600" is a window a person can picture and
     * "600000" is one they misread — as the request that produced this control
     * demonstrated.
     */
    function IdleControl({ settings, idleDisconnectMs, onApplied }) {
      const min = settings ? Math.ceil(settings.minIdleDisconnectMs / 1000) : 1
      const max = settings ? Math.floor(settings.maxIdleDisconnectMs / 1000) : 2147483
      const overridden = settings ? settings.overridden === true : false
      const configuredSeconds = settings ? Math.round(settings.configuredIdleDisconnectMs / 1000) : null

      const [draft, setDraft] = React.useState(String(Math.round(idleDisconnectMs / 1000)))
      const [dirty, setDirty] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(null)

      // Follow the Host while the field is untouched: a restart, another window,
      // or a rejected write can all change the effective value underneath us.
      React.useEffect(() => {
        if (!dirty) setDraft(String(Math.round(idleDisconnectMs / 1000)))
      }, [idleDisconnectMs, dirty])

      const send = async (method, body) => {
        setBusy(true)
        setNote(null)
        try {
          const response = await fetch(STATE_URL, {
            method,
            headers: body === undefined ? undefined : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
          setDirty(false)
          setNote(payload.persisted === false ? '已生效，但写入文件失败——重启后会恢复' : '已保存')
          if (onApplied) onApplied()
        } catch (error) {
          setNote(`失败：${String((error && error.message) || error)}`)
        } finally {
          setBusy(false)
        }
      }

      const apply = () => {
        const seconds = Number(draft)
        if (!Number.isFinite(seconds) || seconds < min || seconds > max) {
          setNote(`请输入 ${min} 到 ${max} 之间的秒数`)
          return
        }
        void send('POST', { idleDisconnectMs: Math.round(seconds) * 1000 })
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
            marginBottom: '16px',
            padding: '10px 12px',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '8px',
            background: 'var(--dsw-alias-bg-layer-1)',
            fontSize: '12px',
          },
        },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '空闲断开'),
        h('input', {
          type: 'number',
          min,
          max,
          value: draft,
          disabled: busy,
          'aria-label': '空闲断开秒数',
          onChange: (event) => {
            setDirty(true)
            setDraft(event.target.value)
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter') apply()
          },
          style: {
            width: '84px',
            padding: '3px 6px',
            borderRadius: '6px',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-base)',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: '12px',
          },
        }),
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '秒后断开'),
        h(
          'button',
          {
            type: 'button',
            disabled: busy || !dirty,
            onClick: apply,
            style: {
              padding: '3px 10px',
              borderRadius: '6px',
              border: '1px solid var(--dsw-alias-border-l2)',
              background: dirty ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
              color: dirty ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-secondary)',
              cursor: busy || !dirty ? 'default' : 'pointer',
              fontSize: '12px',
            },
          },
          busy ? '保存中…' : '应用',
        ),
        overridden
          ? h(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => void send('DELETE'),
                style: {
                  padding: '3px 10px',
                  borderRadius: '6px',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  cursor: busy ? 'default' : 'pointer',
                  fontSize: '12px',
                },
              },
              configuredSeconds === null ? '恢复默认' : `恢复默认（${configuredSeconds} 秒）`,
            )
          : null,
        note
          ? h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, note)
          : null,
        overridden
          ? h(
              'span',
              { style: { color: 'var(--dsw-alias-state-warn-primary)' } },
              '已被面板覆盖',
            )
          : null,
      )
    }

    /** One state dot plus its label. The dot carries the only saturated color. */
    function Badge({ state }) {
      const view = STATUS[state] || STATUS.dormant
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            whiteSpace: 'nowrap',
            fontSize: '12px',
            lineHeight: '18px',
            color: `var(${view.token})`,
          },
        },
        h('span', {
          'aria-hidden': true,
          style: {
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: `var(${view.token})`,
            flex: '0 0 auto',
          },
        }),
        view.label,
      )
    }

    /** A label/value pair on the detail line. */
    function Fact({ label, value }) {
      return h(
        'span',
        { style: { whiteSpace: 'nowrap' } },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, `${label} `),
        h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, value),
      )
    }

    function ServerCard({ server, now }) {
      const state = classify(server, now)
      const tools =
        typeof server.toolCount === 'number' && server.toolCount >= 0
          ? `${server.toolCount} 个（${server.metadataSource}）`
          : '未知'
      return h(
        'li',
        {
          style: {
            listStyle: 'none',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '8px',
            background: 'var(--dsw-alias-bg-layer-2)',
            padding: '12px 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
          h(
            'span',
            {
              style: {
                fontSize: '14px',
                fontWeight: 600,
                color: 'var(--dsw-alias-label-primary)',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              },
            },
            server.name,
          ),
          h(Badge, { state }),
          h(
            'span',
            { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
            server.lifecycle,
          ),
        ),
        server.description
          ? h(
              'div',
              { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
              server.description,
            )
          : null,
        h(
          'div',
          {
            style: {
              display: 'flex',
              gap: '14px',
              flexWrap: 'wrap',
              fontSize: '12px',
            },
          },
          h(Fact, { label: '工具', value: tools }),
          h(Fact, { label: '上次使用', value: ago(server.lastUsedAt, now) }),
          server.connects > 0 ? h(Fact, { label: '连接次数', value: String(server.connects) }) : null,
        ),
        server.lastError
          ? h(
              'div',
              {
                style: {
                  fontSize: '12px',
                  color: 'var(--dsw-alias-state-error-primary)',
                  overflowWrap: 'anywhere',
                },
              },
              server.lastError,
            )
          : null,
      )
    }

    function LazyMcpPanel() {
      const [state, refresh] = useMcpState()
      const data = state.data
      const now = Date.now()
      const servers = (data && Array.isArray(data.servers) ? data.servers : []).slice()

      const counts = { active: 0, connected: 0, connecting: 0, dormant: 0, failed: 0 }
      for (const server of servers) counts[classify(server, now)] += 1

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflowY: 'auto',
            padding: '20px 24px 32px',
            color: 'var(--dsw-alias-label-primary)',
            fontSize: '13px',
          },
        },
        h('h2', { style: { margin: '0 0 4px', fontSize: '16px', fontWeight: 600 } }, 'MCP 服务器'),
        h(
          'div',
          { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '14px' } },
          data
            ? `${servers.length} 台已配置 · 每 ${POLL_MS / 1000} 秒刷新`
            : '正在读取…',
        ),

        data
          ? h(IdleControl, {
              settings: data.settings,
              idleDisconnectMs: data.idleDisconnectMs,
              onApplied: refresh,
            })
          : null,


        state.phase === 'error'
          ? h(
              'div',
              {
                style: {
                  marginBottom: '14px',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: '1px solid var(--dsw-alias-state-error-primary)',
                  color: 'var(--dsw-alias-state-error-primary)',
                  fontSize: '12px',
                },
              },
              `无法读取状态：${state.message}`,
            )
          : null,

        state.phase === 'loading'
          ? h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '正在读取…')
          : null,

        state.phase !== 'loading' && servers.length === 0
          ? h(
              'div',
              { style: { color: 'var(--dsw-alias-label-secondary)' } },
              '没有配置任何 MCP 服务器。',
            )
          : null,

        servers.length > 0
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  gap: '14px',
                  flexWrap: 'wrap',
                  marginBottom: '14px',
                  fontSize: '12px',
                },
              },
              ...['active', 'connected', 'connecting', 'dormant', 'failed']
                .filter((key) => counts[key] > 0)
                .map((key) =>
                  h(
                    'span',
                    { key, style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                    h(Badge, { state: key }),
                    h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, counts[key]),
                  ),
                ),
            )
          : null,

        h(
          'ul',
          { style: { margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '10px' } },
          ...servers.map((server) => h(ServerCard, { key: server.name, server, now })),
        ),
      )
    }

    /**
     * The in-conversation indicator: which servers are connected right now.
     *
     * Renders **nothing** when every server is dormant. Absence is the signal,
     * and a chip on every session — including the many that never touch an MCP
     * server — would be permanent clutter carrying no information. When a
     * server is up, the dot is green while it is being used and accent-colored
     * once it is merely connected, matching the panel.
     */
    function McpHeaderChip() {
      const [state] = useMcpState()
      const data = state.data
      if (!data) return null

      const now = Date.now()
      const live = (data.servers || []).filter(
        (server) => server.status === 'ready' || server.status === 'connecting',
      )
      if (live.length === 0) return null

      const busy = live.some((server) => classify(server, now) === 'active')
      const token = busy ? '--dsw-alias-state-success-primary' : '--dsw-alias-brand-primary'
      const names = live.map((server) => server.name).join('、')
      const failed = (data.servers || []).filter((server) => server.lastError).length

      return h(
        'span',
        {
          title: [
            `${live.length} 台 MCP 已连接：${names}`,
            failed > 0 ? `${failed} 台连接失败` : null,
            `空闲 ${Math.round(data.idleDisconnectMs / 1000)} 秒后断开`,
          ]
            .filter(Boolean)
            .join('\n'),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '0 9px',
            height: '22px',
            borderRadius: '11px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: '11px',
            lineHeight: '20px',
            whiteSpace: 'nowrap',
            maxWidth: '240px',
          },
        },
        h('span', {
          'aria-hidden': true,
          style: {
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: `var(${token})`,
            flex: '0 0 auto',
          },
        }),
        h(
          'span',
          { style: { overflow: 'hidden', textOverflow: 'ellipsis' } },
          live.length === 1 ? names : `${names}（${live.length}）`,
        ),
      )
    }

    /** The sidebar cell: an icon only — the shell draws the button around it. */
    function LazyMcpIcon({ size = 20 }) {
      const px = typeof size === 'number' && size > 0 ? size : 20
      return h(
        'svg',
        {
          width: px,
          height: px,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
          style: { display: 'block' },
        },
        h('rect', { x: 3, y: 4, width: 18, height: 7, rx: 2 }),
        h('rect', { x: 3, y: 13, width: 18, height: 7, rx: 2 }),
        h('circle', { cx: 7, cy: 7.5, r: 1, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 7, cy: 16.5, r: 1, fill: 'currentColor', stroke: 'none' }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // One id, two seats: the sidebar resolves `lazy-mcp` to the main panel
        // of the same key, so clicking the icon selects the panel below.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'lazy-mcp', order: 40, label: 'MCP' },
            LazyMcpIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'lazy-mcp' }, LazyMcpPanel),
        )
        // Right-aligned Session utilities, between the session-log download
        // (order 0) and dsh-better-sidebar's bottom toggle (order 10).
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'lazy-mcp:header',
              order: 5,
              label: 'MCP',
            },
            McpHeaderChip,
          ),
        )
      },
    }
  },
})
