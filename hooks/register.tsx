import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Stats } from '../types'

const PANE = 'session-meter'
const empty: Stats = {
  steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  lastAt: 0, ttl: '1h', usd: 0, now: 0, frame: 0, busy: false, hist: [], effort: 'medium', ultra: false, limitResetAt: 0, limitPct: 0, limit7ResetAt: 0, limit7Pct: 0,
  ctxTokens: 0, ctxWindow: 0, ctxLimit: 0, goals: 0, goalAt: 0, fx: null, longTool: false, intent: '',
}
const stats = atom({ plugin: 'session-meter', key: 'stats' } as const, empty, {
  shape: 'stats-4',
})
// the lo-fi stream is playing (the Play button shows a stop square)
const lofi = atom({ plugin: 'session-meter', key: 'lofi' } as const, false)
const LOFI_URL = 'https://youtu.be/tRsQsTMvPNg'
const LOFI_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
const BTN_W = 34 // room the Play button takes at the right of the strip
const T_PLAY = 'Play lo-fi'
const T_STOP = 'Stop lo-fi'
const T_NEED = 'Lo-fi needs mpv and yt-dlp: brew install mpv yt-dlp'
const T_FAIL = 'Lo-fi did not start: the stream is unavailable'

const n = (v: number) => v.toLocaleString('en-US')
const ttlSec = (s: Stats) => (s.ttl === '1h' ? 3600 : 300)
// seconds of cache life left at `nowMs`; null before the first answer
const remaining = (s: Stats, nowMs: number) =>
  s.lastAt === 0 ? null : s.lastAt / 1000 + ttlSec(s) - nowMs / 1000

const BLUE = '#60a5fa'
const PINK = '#f472b6'
const GREEN = '#4ade80'
const ORANGE = '#fb923c'
const ACCENT = '#d97757'
const WARN = '#e5534b'
const COLD = '#6b6a65'
const TEXT = '#faf9f5'
const DIM = '#9b9a94'
const LINE = '#3d3d3a'

const FONT = `font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif"`
const NUM = `style="font-variant-numeric: tabular-nums"`
const MONO = `font-family="ui-monospace, 'SF Mono', Menlo, Consolas, monospace"`
const CW = 7.2 // width of one monospace character at 12px

// 1234 -> 1.2K, 3_400_000 -> 3.4M, 2_100_000_000 -> 2.1B
const short = (v: number) => {
  const f = (x: number, u: string) => `${x >= 100 ? Math.round(x) : Math.round(x * 10) / 10}${u}`
  if (v >= 1e9) return f(v / 1e9, 'B')
  if (v >= 1e6) return f(v / 1e6, 'M')
  if (v >= 1e3) return f(v / 1e3, 'K')
  return String(v)
}

// ---------------------------------------------------------------------------
// A countdown that runs by itself inside the picture (SMIL), so the mod never
// has to redraw it every second: each digit is a stack of numerals shown one at
// a time on a loop, set to the right place when the picture is drawn.
// ---------------------------------------------------------------------------
const digitsSvg = (R0: number, xEnd: number, y: number, size: number, fmt: 'ms' | 'hm' | 'dh' = 'ms') => {
  const cw = size * 0.6
  const chars = fmt === 'hm' ? 4 : 5
  const x0 = xEnd - chars * cw
  const cols = fmt === 'hm'
    ? [
        { N: 6, unit: 3600, pos: 0 }, // hours
        { N: 6, unit: 600, pos: 2 }, // tens of minutes
        { N: 10, unit: 60, pos: 3 }, // minutes
      ]
    : fmt === 'dh'
      ? [
          { N: 8, unit: 86400, pos: 0 }, // days
          { N: 24, unit: 3600, pos: 2, label: (v: number) => String(v).padStart(2, '0') }, // hours of the day
        ]
      : [
        { N: 7, unit: 600, pos: 0 }, // tens of minutes
        { N: 10, unit: 60, pos: 1 }, // minutes
        { N: 6, unit: 10, pos: 3 }, // tens of seconds
        { N: 10, unit: 1, pos: 4 }, // seconds
      ]
  let out = ''
  const lh = Math.round(size * 1.4) // distance between numerals on a strip
  const top = size * 0.85 // baseline inside the window
  for (const { N, unit, pos, label } of cols as { N: number; unit: number; pos: number; label?: (v: number) => string }[]) {
    const P = N * unit
    const begin = -(P - (R0 % P))
    const width = (label ? 2 : 1) * cw + 1
    // the strip: 0 .. N-1 stacked downwards; the window shows one numeral, and
    // the strip steps up as the time runs down (N-1 first, 0 last)
    const rows = Array.from({ length: N }, (_, v) => `<tspan x="0" y="${(top + v * lh).toFixed(1)}">${label ? label(v) : v}</tspan>`).join('')
    const values = Array.from({ length: N }, (_, j) => `0 ${-(N - 1 - j) * lh}`).join(';')
    const keyTimes = Array.from({ length: N }, (_, j) => (j / N).toFixed(5)).join(';')
    out += `<svg x="${(x0 + pos * cw).toFixed(1)}" y="${(y - top).toFixed(1)}" width="${width.toFixed(1)}" height="${(size * 1.25).toFixed(1)}"><g><animateTransform attributeName="transform" type="translate" calcMode="discrete" values="${values}" keyTimes="${keyTimes}" dur="${P}s" begin="${begin.toFixed(2)}s" repeatCount="indefinite"/><text font-size="${size}">${rows}</text></g></svg>`
  }
  const lit = (ch: string, pos: number) => `<text x="${(x0 + pos * cw).toFixed(1)}" y="${y}" font-size="${size}">${ch}</text>`
  out += fmt === 'dh' ? lit('d', 1) + lit('h', 4) : lit(':', fmt === 'hm' ? 1 : 2)
  return out
}

// The time left, drawn in `fill`, or "cold" once it has run out.
const timeSvg = (R0: number | null, xEnd: number, y: number, size: number, fill: string, weight: number, fmt: 'ms' | 'hm' | 'dh' = 'ms', cold = 'cold') => {
  const head = `<g fill="${fill}" font-weight="${weight}" text-anchor="start" ${NUM}>`
  if (R0 === null) return `<text x="${xEnd}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${DIM}" text-anchor="end">—:——</text>`
  if (R0 <= 0)
    return `<text x="${xEnd}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${DIM}" text-anchor="end">${cold}</text>`
  return `${head}${digitsSvg(R0, xEnd, y, size, fmt)}<set attributeName="opacity" to="0" begin="${R0.toFixed(2)}s" fill="freeze"/></g>
<text x="${xEnd}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${DIM}" text-anchor="end" opacity="0">${cold}<set attributeName="opacity" to="1" begin="${R0.toFixed(2)}s" fill="freeze"/></text>`
}

const hexRgb = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))
const mix = (a: string, b: string, t: number) => {
  const x = hexRgb(a)
  const y = hexRgb(b)
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')
}
const pctColor = (p: number) =>
  p < 50 ? mix('#4ade80', '#facc15', Math.max(0, p) / 50) : mix('#facc15', '#f87171', Math.min(1, (p - 50) / 50))

// Colour of the bar and marker: accent, red for the last fifth, grey when cold.
const stateColor = (R0: number | null, ttl: number) =>
  R0 === null || R0 <= 0 ? COLD : R0 / ttl > 0.2 ? ACCENT : WARN
const stateSets = (R0: number | null, ttl: number) => {
  if (R0 === null || R0 <= 0) return ''
  const tRed = R0 - 0.2 * ttl
  return `${tRed > 0 ? `<set attributeName="fill" to="${WARN}" begin="${tRed.toFixed(2)}s" fill="freeze"/>` : ''}<set attributeName="fill" to="${COLD}" begin="${R0.toFixed(2)}s" fill="freeze"/>`
}
// A bar that drains smoothly to nothing over the time left.
const drainBar = (x: number, y: number, w: number, h: number, rx: number, R0: number | null, ttl: number) => {
  const track = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${LINE}"/>`
  if (R0 === null || R0 <= 0) return track
  const f = Math.min(1, R0 / ttl)
  return `${track}<rect x="${x}" y="${y}" width="${(w * f).toFixed(1)}" height="${h}" rx="${rx}" fill="${stateColor(R0, ttl)}"><animate attributeName="width" from="${(w * f).toFixed(1)}" to="0" dur="${R0.toFixed(2)}s" fill="freeze"/>${stateSets(R0, ttl)}</rect>`
}

// The strip in the band: IN, OUT and CACHE-read counts, then cost, cache bar
// and time left. Flat rectangles in one row of fixed widths.
const LEVEL_LABEL: Record<string, string> = { low: 'LOW', medium: 'MED', high: 'HIGH', xhigh: 'XHIGH', max: 'MAX' }
const LEVEL_COLOR: Record<string, string> = {
  low: '#a1a1aa', medium: BLUE, high: GREEN, xhigh: '#facc15', max: PINK,
}
// "Extra high", "XHigh", "medium" ... -> low | medium | high | xhigh | max
const normLevel = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const t = v.toLowerCase().replace(/[^a-z]/g, '')
  if (t.includes('xhigh') || t.includes('extra')) return 'xhigh'
  if (t.includes('max')) return 'max'
  if (t.includes('medium') || t === 'med') return 'medium'
  if (t.includes('high')) return 'high'
  if (t.includes('low')) return 'low'
  return undefined
}
const pillSvg = (s: Stats, nowMs: number, tail = false) => {
  const ttl = ttlSec(s)
  const R0 = remaining(s, nowMs)
  const H = 30
  // context fill as "used/windowk" in thousands, e.g. 120/1000k
  const kk = (v: number) => String(Math.round(v / 1000))
  // the denominator is where auto-compact kicks in (the /autocompact setting), else the whole window
  const ctxMax = (s.ctxLimit ?? 0) > 0 ? s.ctxLimit : (s.ctxWindow ?? 0)
  const hasCtx = ctxMax > 0
  const ctxPct = hasCtx ? ((s.ctxTokens ?? 0) / ctxMax) * 100 : 0
  const ctxColor = ctxPct < 60 ? GREEN : ctxPct < 85 ? '#facc15' : WARN
  const chips: [string, string, string, number][] = [
    ['IN', short(s.input + s.cacheRead + s.cacheWrite), BLUE, 5], // everything that went in, as the system counts it (new + cached)
    ['OUT', short(s.output), PINK, 5],
    ['CACHE', short(s.cacheRead), GREEN, 5],
  ]
  if (hasCtx) chips.push(['CTX', `${kk(s.ctxTokens ?? 0)}/${kk(ctxMax)}k`, ctxColor, 9])
  let body = ''
  let x = 0
  for (const [label, value, c, room] of chips) {
    const w = Math.round(19 + (label.length + 1 + room) * CW + 8)
    body += `<rect x="${x + 8}" y="12" width="6" height="6" rx="1.5" fill="${c}"/>
<text x="${x + 19}" y="19.5" font-size="12" fill="${DIM}">${label}</text>
<text x="${x + w - 8}" y="19.5" font-size="12" font-weight="600" fill="${TEXT}" text-anchor="end">${value}</text>
<line x1="${x + w}" y1="6" x2="${x + w}" y2="${H - 6}" stroke="${LINE}"/>`
    x += w
  }
  const dot = s.busy
    ? `<rect x="${x + 8}" y="12" width="6" height="6" rx="1.5" fill="${ACCENT}"><animate attributeName="opacity" values="1;0.3;1" dur="1.4s" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1" repeatCount="indefinite"/></rect>`
    : `<rect x="${x + 8}" y="12" width="6" height="6" rx="1.5" fill="${stateColor(R0, ttl)}">${stateSets(R0, ttl)}</rect>`
  const bx = x + 19 + 6 * CW + 6
  const tEnd = bx + 48 + 10 + 5 * CW
  body += `${dot}
<text x="${x + 19}" y="19.5" font-size="12" font-weight="600" fill="${TEXT}">$${s.usd.toFixed(2)}</text>
${drainBar(Math.round(bx), 12, 48, 6, 1.5, R0, ttl)}
${timeSvg(R0, Math.round(tEnd), 19.5, 12, TEXT, 400)}`
  // The usage limits: time until the window resets, and how much of it is used.
  // With both the 5-hour and the 7-day window the readout is a wheel: every two
  // minutes it turns upwards, 5H -> 7D -> 5H ..., the next face rising from below.
  // The marker's colour runs green -> yellow -> red with how much is used.
  const wins: { label: string; R: number; pct: number; fmt: 'hm' | 'dh'; cold: string }[] = []
  if ((s.limitResetAt ?? 0) > 0)
    wins.push({ label: '5H', R: (s.limitResetAt - nowMs) / 1000, pct: s.limitPct ?? 0, fmt: 'hm', cold: '0:00' })
  if ((s.limit7ResetAt ?? 0) > 0)
    wins.push({ label: '7D', R: (s.limit7ResetAt - nowMs) / 1000, pct: s.limit7Pct ?? 0, fmt: 'dh', cold: '0d00h' })
  let W = Math.round(tEnd + 10)
  if (wins.length > 0) {
    const xd = Math.round(tEnd + 10)
    const lEnd = Math.round(xd + 19 + 2 * CW + 8 + 5 * CW)
    const face = (w: (typeof wins)[number], oy: number) =>
      `<g transform="translate(0,${oy})"><rect x="${xd + 8}" y="12" width="6" height="6" rx="1.5" fill="${pctColor(w.pct)}"/>
<text x="${xd + 19}" y="19.5" font-size="12" fill="${DIM}">${w.label}</text>
${timeSvg(w.R, lEnd, 19.5, 12, TEXT, 400, w.fmt, w.cold)}</g>`
    let readout: string
    if (wins.length === 1) {
      readout = face(wins[0], 0)
    } else {
      // faces, from the window upwards: 5H, 7D, 5H again (so the last turn lands on an
      // identical face and the loop is seamless). The whole plate - marker, label and
      // time - turns as one: the shown face leaves downwards, the next arrives from above.
      // 5H holds for 2:30, then 7D for 30 s, three minutes in all
      const PERIOD = 180
      const SHOW_5H = 150
      const TURN_S = 0.9
      const t1 = (SHOW_5H - TURN_S) / PERIOD
      const t2 = SHOW_5H / PERIOD
      const t3 = (PERIOD - TURN_S) / PERIOD
      const phase = (nowMs / 1000) % PERIOD // wall-clock phase: redraws never restart the wheel
      const spin = `<animateTransform attributeName="transform" type="translate" values="0 0;0 0;0 ${H};0 ${H};0 ${2 * H}" keyTimes="0;${t1.toFixed(5)};${t2.toFixed(5)};${t3.toFixed(5)};1" calcMode="spline" keySplines="0 0 1 1;0.45 0 0.55 1;0 0 1 1;0.45 0 0.55 1" dur="${PERIOD}s" begin="${(-phase).toFixed(2)}s" repeatCount="indefinite"/>`
      readout = `<clipPath id="wheel"><rect x="${xd + 1}" y="0" width="${lEnd - xd + 8}" height="${H}"/></clipPath>
<g clip-path="url(#wheel)"><g>${spin}${face(wins[0], 0)}${face(wins[1], -H)}${face(wins[0], -2 * H)}</g></g>`
    }
    body += `<line x1="${xd}" y1="6" x2="${xd}" y2="${H - 6}" stroke="${LINE}"/>
${readout}`
    W = Math.round(lEnd + 10)
  }
  // a closing divider: the Play button sits right after it
  if (tail) body += `\n<line x1="${W - 0.5}" y1="6" x2="${W - 0.5}" y2="${H - 6}" stroke="${LINE}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${MONO}>
${body}
</svg>`
}

// The card shown on hover: cost, cache countdown and the four token counts.
const cardSvg = (s: Stats, nowMs: number) => {
  const ttl = ttlSec(s)
  const R0 = remaining(s, nowMs)
  const total = s.input + s.cacheRead + s.cacheWrite
  const hit = total > 0 ? Math.round((s.cacheRead / total) * 100) : 0
  const parts: [string, number, string][] = [
    ['Input (uncached)', s.input, BLUE],
    ['Output', s.output, PINK],
    ['Cache read', s.cacheRead, GREEN],
    ['Cache write', s.cacheWrite, ORANGE],
  ]
  const sum = Math.max(1, parts.reduce((a, p) => a + p[1], 0))
  const BAR = 228
  const limitRows: string[] = []
  if ((s.limitResetAt ?? 0) > 0) limitRows.push(`5-hour limit: ${Math.round(s.limitPct ?? 0)}% used`)
  if ((s.limit7ResetAt ?? 0) > 0) limitRows.push(`7-day limit: ${Math.round(s.limit7Pct ?? 0)}% used`)
  const CH = 292 + 18 * limitRows.length
  const limitLine = limitRows
    .map((t, k) => `<text x="18" y="${299 + 18 * k}" font-size="11" fill="${DIM}">${t}</text>`)
    .join('')
  const rows = parts
    .map(([label, v, c], i) => {
      const y = 112 + i * 38
      return `<text x="18" y="${y}" font-size="12" fill="#d4d4d8">${label}</text>
<text x="246" y="${y}" font-size="13" font-weight="600" fill="${TEXT}" text-anchor="end" ${NUM}>${n(v)}</text>
<rect x="18" y="${y + 8}" width="${BAR}" height="4" rx="1.5" fill="${LINE}"/>
<rect x="18" y="${y + 8}" width="${Math.max(v > 0 ? 4 : 0, (BAR * v) / sum).toFixed(1)}" height="4" rx="1.5" fill="${c}"/>`
    })
    .join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="264" height="${CH}" viewBox="0 0 264 ${CH}" ${FONT}>
<rect x="0.5" y="0.5" width="263" height="${CH - 1}" rx="6" fill="#262624" stroke="${LINE}"/>
<text x="18" y="30" font-size="12" fill="${DIM}">This session</text>
<text x="246" y="32" font-size="18" font-weight="700" fill="${TEXT}" text-anchor="end" ${NUM}>$${s.usd.toFixed(4)}</text>
<line x1="18" y1="46" x2="246" y2="46" stroke="${LINE}"/>
<text x="18" y="70" font-size="12" fill="${DIM}">Cache · TTL ${s.ttl === '1h' ? '1 h' : '5 min'}</text>
<g ${MONO}>${timeSvg(R0, 246, 71, 15, TEXT, 700)}</g>
${drainBar(18, 80, BAR, 8, 2, R0, ttl)}
<line x1="18" y1="98" x2="246" y2="98" stroke="${LINE}"/>
${rows}
<line x1="18" y1="262" x2="246" y2="262" stroke="${LINE}"/>
<text x="18" y="281" font-size="11" fill="${DIM}">Cache hit ${hit}% · ${n(s.steps)} requests</text>
${limitLine}
</svg>`
}

// ---------------------------------------------------------------------------
// Five small pixel-art Clodies on an oval track in the strip's own row, from
// the left edge to the first divider (a fixed-size SVG, so it never widens the
// strip). They run to the right along the front lane, turn round at the post,
// run back along the far lane (smaller, a little higher) and turn again. They
// are spaced evenly round the oval, so they are spread evenly along the track.
//  run   while the model answers
//  idle  standing where they stopped, each with its own routine
//  sleep when the cache has gone cold
// SMIL with eased curves, looping seamlessly. A Clodie's place is a phase on
// the loop, so the stop position is that phase and the next run resumes there.
// ---------------------------------------------------------------------------
type Mode = 'run' | 'idle' | 'sleep'
const LANE_H = 30
const SPEED = 110 // px per second
const COUNT = 7
const COLORS = ['#d97757', '#e08a6a', '#c9684a', '#d97757', '#e59a7a', '#d97757', '#d97757']
// the sixth Clodie's body tint by reasoning level
const LEVEL_BODY: Record<string, string> = { low: '#b88f7e', medium: '#d97757', high: '#d97757', xhigh: '#ea6a45', max: '#f0b35a' }

const IO = '0.45 0 0.55 1' // ease in-out
const LIN = '0 0 1 1'

const laneGeometry = (width: number) => {
  const SW = 26
  // one lap: from fully outside the left edge to fully outside the right edge
  const L = width + 2 * SW
  return { SW, L, T: L / SPEED }
}

// Where each Clodie stands before the first run: in an even row, centred.
// The row keeps a margin from the posts at both ends so nobody touches an edge.
const ROW_MARGIN = 12
const ROW_STEP = 46
const STOP_MIN = 110 // the shortest walk (px) a Clodie takes to come to rest
const rowPlace = (j: number, width: number) => {
  const { SW } = laneGeometry(width)
  // close together (a Clodie and a Clodie-sized gap), centred in the track
  const step = Math.min(ROW_STEP, (width - SW - 2 * ROW_MARGIN) / (COUNT - 1))
  return width / 2 + (j - (COUNT - 1) / 2) * step + SW // lap position of place j
}
const initPhase = (i: number, width: number) => rowPlace(i, width) / SPEED

// A stop in progress: where each Clodie was (lap position), where it is going,
// and how many seconds ago it began.
type Settle = { s: number[]; h: number[]; age: number }

// What the Clodies are reacting to: a mood after the last answer (error / tests
// passed / a round sum spent), a goal for the footballer, a long tool call (an
// umbrella), what you asked for (a magnifier or a hammer) and the time of day.
type Fx = {
  mood: { kind: 'sad' | 'cheer' | 'party'; age: number } | null
  goal: { age: number } | null
  goals: number
  umbrella: boolean
  intent: string
  outfit: string
}

const clodLane = (mode: Mode, width: number, bases: number[] | null, elapsed: number, effort: string, ultra: boolean, settle: Settle | null = null, bored: number | null = null, fx: Fx | null = null) => {
  const U = 2
  const G = LANE_H - 2
  const DARK = '#1f1f1e'
  const { SW, L, T } = laneGeometry(width)
  const run = mode === 'run'
  const sleep = mode === 'sleep'
  const r = (c: number, y: number, w: number, h: number, f: string) =>
    `<rect x="${(c - 6.5) * U}" y="${(y - 8) * U}" width="${w * U}" height="${h * U}" fill="${f}"/>`
  // an eased transform animation: one spline per interval, or one for all
  const tf = (type: string, vals: string, dur: number, begin: number, kt = '', ease: string | string[] = IO) => {
    const k = vals.split(';').length - 1
    const sp = Array.isArray(ease) ? ease : Array(k).fill(ease)
    return `<animateTransform attributeName="transform" type="${type}" values="${vals}" calcMode="spline" ${kt ? `keyTimes="${kt}"` : ''} keySplines="${sp.join(';')}" dur="${dur.toFixed(3)}s" begin="${(-begin).toFixed(3)}s" repeatCount="indefinite"/>`
  }
  const wrap = (inner: string, anim = '') => `<g>${anim}${inner}</g>`
  // the same, but it plays `count` times and is over: it ends by itself, so a
  // picture that is never redrawn still returns to rest
  const once = (type: string, vals: string, dur: number, age: number, count: number, kt = '', ease: string | string[] = IO) => {
    const k = vals.split(';').length - 1
    const sp = Array.isArray(ease) ? ease : Array(k).fill(ease)
    return `<animateTransform attributeName="transform" type="${type}" values="${vals}" calcMode="spline" ${kt ? `keyTimes="${kt}"` : ''} keySplines="${sp.join(';')}" dur="${dur.toFixed(3)}s" begin="${(-age).toFixed(3)}s" repeatCount="${count}"/>`
  }
  const mood = !run && !sleep && fx ? fx.mood : null
  const goalFx = !run && !sleep && fx ? fx.goal : null
  // After BORED_AFTER seconds of standing around they start passing a wave along
  // the row (left to right) and, once a minute, shimmer in turn. The animations
  // carry their own start times, so no redraw is needed when the mark is reached.
  const BORED_AFTER = 300
  const waveOn = bored !== null && !run && !sleep
  const xsAll = Array.from({ length: COUNT }, (_, k) =>
    ((((bases ? bases[k] : initPhase(k, width)) + elapsed) % T + T) % T) * SPEED)
  const rankOf = (k: number) => xsAll.filter(v => v < xsAll[k]).length
  const SHIM_KT = '0;0.0111;0.0222;0.0333;0.0444;0.0556;0.0667;1'

  const one = (i: number) => {
    const c = i === 5 ? (LEVEL_BODY[effort] ?? COLORS[5]) : COLORS[i]
    const ph = i * 0.31
    const p0 = ((((bases ? bases[i] : initPhase(i, width)) + elapsed) % T) + T) % T

    // The sixth Clodie shows the reasoning level (low .. max) and ultracode.
    const star = i === 5
    const shimmer = star && ultra
    const RAINBOW = '#d97757;#f472b6;#a78bfa;#60a5fa;#4ade80;#facc15;#d97757'
    const wb = waveOn ? BORED_AFTER - (bored as number) + rankOf(i) * 0.22 : 0
    const paint = (col: number, y: number, w: number, h: number) =>
      shimmer
        ? `<rect x="${(col - 6.5) * U}" y="${(y - 8) * U}" width="${w * U}" height="${h * U}" fill="#d97757"><animate attributeName="fill" values="${RAINBOW}" dur="3s" begin="0s" repeatCount="indefinite"/></rect>`
        : waveOn
          ? `<rect x="${(col - 6.5) * U}" y="${(y - 8) * U}" width="${w * U}" height="${h * U}" fill="${c}"><animate attributeName="fill" values="${c};#f472b6;#a78bfa;#60a5fa;#4ade80;#facc15;${c};${c}" keyTimes="${SHIM_KT}" dur="60s" begin="${wb.toFixed(2)}s" repeatCount="indefinite"/></rect>`
          : r(col, y, w, h, c)
    const twinkle = (cx: number, cy: number, begin: number, f = '#ffffff') =>
      `<g>${r(cx, cy - 1, 1, 3, f)}${r(cx - 1, cy, 3, 1, f)}<animate attributeName="opacity" values="0;1;0" keyTimes="0;0.5;1" dur="1.4s" begin="${-begin}s" repeatCount="indefinite"/></g>`
    let special = ''
    if (star && ultra) {
      special = `${twinkle(-1, 1, 0)}${twinkle(12.5, 3, 0.5)}${twinkle(6, -3, 1)}`
    } else if (star && effort === 'low') {
      // resting on a little cloud
      special = `${r(1, 7, 11, 1, '#d4d4d8')}${r(3, 6, 3, 1, '#e4e4e7')}${r(8, 6, 2, 1, '#e4e4e7')}`
    } else if (star && effort === 'medium') {
      // a thinking bubble with three blinking dots
      const dot = (cx: number, b: number) =>
        `<g>${r(cx, -3, 1, 1, '#52525b')}<animate attributeName="opacity" values="0.2;1;0.2" dur="1.5s" begin="${-b}s" repeatCount="indefinite"/></g>`
      special = `${r(9, -4, 5, 3, '#e4e4e7')}${r(9, -1, 1, 1, '#e4e4e7')}${dot(10, 0)}${dot(11.5, 0.5)}${dot(13, 1)}`
    } else if (star && effort === 'high') {
      // headphones: focused
      special = `${r(3, -1, 7, 1, '#60a5fa')}${r(2, 0, 1, 2, '#60a5fa')}${r(10, 0, 1, 2, '#60a5fa')}${r(1, 1, 2, 3, '#3b82f6')}${r(10, 1, 2, 3, '#3b82f6')}`
    } else if (star && effort === 'xhigh') {
      // electrified: a flickering bolt
      special = `<g>${r(7, -4, 2, 1, '#facc15')}${r(6, -3, 2, 1, '#facc15')}${r(5, -2, 3, 1, '#facc15')}${r(6, -1, 1, 1, '#facc15')}<animate attributeName="opacity" values="1;0.4;1;1;0.6;1" dur="0.9s" repeatCount="indefinite"/></g>${twinkle(11, -1, 0.3, '#facc15')}`
    } else if (star && effort === 'max') {
      // a crown, and a glint
      special = `${r(3, -1, 7, 1, '#facc15')}${r(3, -2, 1, 1, '#facc15')}${r(6, -2, 1, 1, '#facc15')}${r(9, -2, 1, 1, '#facc15')}${r(6, -1, 1, 1, '#f472b6')}${twinkle(12, -2, 0.6, '#fde68a')}`
    }
    const arm = (col: number, side: number) => {
      let a = ''
      if (goalFx && i === 6) a = once('translate', '0 -5;0 -2;0 -5', 0.35, goalFx.age, 8)
      else if (mood && mood.kind !== 'sad') a = once('translate', '0 -5;0 -2;0 -5', 0.3, mood.age, 9)
      else if (mood) a = once('translate', '0 1;0 2;0 1', 0.6, mood.age, 5)
      else if (run) a = tf('translate', '0 0;0 -4;0 0', 0.4, ph + side * 0.2)
      else if (!sleep) {
        a =
          i === 0
            ? tf('translate', '0 -5;0 -2;0 -5', 0.5, ph + side * 0.25) // cheering
            : i === 1
              ? tf('translate', '0 0;0 -4;0 0;0 0', 1.8, ph + side * 0.9, '0;0.25;0.5;1', [IO, IO, LIN]) // waving in turns
              : tf('translate', '0 0;0 -4;0 0', 1 + i * 0.15, ph + side * 0.3)
      }
      const arm = wrap(paint(col, 3, 2, 2), a)
      return waveOn ? wrap(arm, tf('translate', '0 0;0 -5;0 0;0 0', 4.4, -wb, '0;0.06;0.12;1', [IO, IO, LIN])) : arm
    }
    // The footballer (the seventh): a kit, and a ball he dribbles when running and
    // kicks out and back while standing (the right leg swings with the kick).
    const ball = i === 6
    const KICK = 4.8
    const kickLeg = ball && !run && !sleep
    const leg = (col: number, alt: boolean) =>
      wrap(
        `${paint(col, 6, 1, 2)}${ball ? r(col, 6, 1, 1, '#f4f4f5') : ''}`, // the footballer's socks
        run
          ? tf('translate', alt ? '0 -2;0 0;0 -2' : '0 0;0 -2;0 0', 0.4, ph)
          : kickLeg && col === 9
            ? tf('translate', '0 0;0 0;-3 0;4 -2;0 0;0 0', KICK, ph, '0;0.5;0.56;0.6;0.66;1')
            : '',
      )
    const eyes = sleep || (star && effort === 'low' && !ultra)
      ? `${r(4, 2.5, 1, 0.5, DARK)}${r(8, 2.5, 1, 0.5, DARK)}`
      : `<g>${r(4, 2, 1, 1, DARK)}${r(8, 2, 1, 1, DARK)}<animate attributeName="opacity" values="1;1;0;1" keyTimes="0;0.92;0.96;1" dur="${3 + i * 0.5}s" begin="${-ph}s" repeatCount="indefinite"/></g>`
    // Everyone has a costume of their own (rows above the body are negative):
    // a wizard with a star, a detective, a punk with a mohawk, a builder, someone in a bow
    // and the footballer's socks (see leg()).
    const HATS = [
      `${r(3, -1, 7, 1, '#2563eb')}${r(4, -2, 5, 1, '#3b82f6')}${r(5, -3, 3, 1, '#3b82f6')}${r(6, -2, 1, 1, '#facc15')}`, // wizard
      `${r(2, -1, 9, 1, '#78350f')}${r(4, -2, 5, 1, '#1c1917')}${r(4, -3, 5, 1, '#92400e')}${r(6, -3, 1, 1, '#78350f')}`, // fedora
      `${r(5, -1, 1, 1, '#4ade80')}${r(6, -2, 1, 2, '#4ade80')}${r(7, -1, 1, 1, '#4ade80')}${r(6, -3, 1, 1, '#86efac')}`, // mohawk
      `${r(2, -1, 9, 1, '#facc15')}${r(3, -2, 7, 1, '#facc15')}${r(5, -3, 3, 1, '#eab308')}${r(6, -2, 1, 1, '#fff7ed')}`, // hard hat
      `${r(6, -2, 2, 2, PINK)}${r(8, -1, 1, 1, '#be185d')}${r(9, -2, 2, 2, PINK)}`, // bow
    ]
    const FACES = [
      '',
      r(5, 3, 3, 1, '#78350f'), // moustache
      `${r(3, 1.5, 3, 1.5, '#0b0b0c')}${r(7, 1.5, 3, 1.5, '#0b0b0c')}${r(6, 1.5, 1, 0.5, '#0b0b0c')}`, // shades
      '',
      `${r(3, 3, 1, 1, '#fda4af')}${r(9, 3, 1, 1, '#fda4af')}`, // cheeks
    ]
    const heart =
      i === 4 && mode === 'idle'
        ? `<g>${r(5, -3, 1, 1, PINK)}${r(7, -3, 1, 1, PINK)}${r(5, -2, 3, 1, PINK)}${r(6, -1, 1, 1, PINK)}${tf('translate', '0 3;0 -5', 3.2, ph)}<animate attributeName="opacity" values="0;1;0" keyTimes="0;0.25;1" dur="3.2s" begin="${-ph}s" repeatCount="indefinite"/></g>`
        : ''
    const zz = sleep
      ? `<text x="${4 * U}" y="${-9 * U}" font-size="8" font-weight="700" fill="${DIM}" font-family="ui-monospace, monospace">z<animate attributeName="opacity" values="0;1;0" dur="2.4s" begin="${-ph * 3}s" repeatCount="indefinite"/>${tf('translate', '0 3;0 -3;0 3', 2.4, ph * 3)}</text>`
      : ''
    const lines = run
      ? `<g>${shimmer ? `${r(-3, 2, 2, 0.5, PINK)}${r(-5, 3.5, 3, 0.5, BLUE)}${r(-4, 5, 2, 0.5, GREEN)}` : `${r(-3, 2, 2, 0.5, DIM)}${r(-5, 4, 3, 0.5, DIM)}`}<animate attributeName="opacity" values="1;0.3;1" dur="0.5s" begin="${-ph}s" repeatCount="indefinite"/></g>`
      : ''
    // Time of day: nightcaps at night, party hats on Friday evening, coffee in the morning.
    const outfit = fx?.outfit ?? ''
    const CAPS = ['#818cf8', '#a78bfa', '#60a5fa', '#818cf8', '#a78bfa']
    const PARTY = ['#f472b6', '#60a5fa', '#facc15', '#4ade80', '#a78bfa']
    const cap =
      i < 5 && outfit === 'night'
        ? run
          ? `<polygon points="${3 * U},${-8 * U} ${-3 * U},${-8 * U} ${-5 * U},${-10 * U} ${-3.5 * U},${-11 * U}" fill="${CAPS[i]}"/><rect x="${-6.5 * U}" y="${-11.5 * U}" width="${2 * U}" height="${2 * U}" fill="#f4f4f5"/>` // running: the tail trails behind (left)
          : `<polygon points="${3 * U},${-8 * U} ${-3 * U},${-8 * U} 0,${-10.5 * U}" fill="${CAPS[i]}"/><rect x="${-U}" y="${-12 * U}" width="${2 * U}" height="${2 * U}" fill="#f4f4f5"/>` // standing: upright
        : i < 5 && outfit === 'party'
          ? `<polygon points="${-2.5 * U},${-8 * U} ${2.5 * U},${-8 * U} 0,${-11.5 * U}" fill="${PARTY[i]}"/><rect x="${-1 * U}" y="${-9.5 * U}" width="${2 * U}" height="${U / 2}" fill="#f4f4f5"/>`
          : ''
    const headgear = `${cap || (HATS[i] ?? '')}${FACES[i] ?? ''}`
    const moon = outfit === 'night' && i === 1 ? `${r(11, -3, 2, 1, '#fde68a')}${r(11, -2, 1, 1, '#fde68a')}${r(11, -1, 2, 1, '#fde68a')}` : ''
    const mug =
      outfit === 'morning' && (i === 1 || i === 3)
        ? `<g>${r(13, 2, 2, 3, '#f4f4f5')}${r(15, 3, 1, 1, '#f4f4f5')}${r(13, 2, 2, 1, '#92400e')}</g><g>${r(13, 0, 1, 1, '#d4d4d8')}<animate attributeName="opacity" values="0;0.9;0" dur="1.6s" begin="${-ph}s" repeatCount="indefinite"/>${tf('translate', '0 3;0 -4', 1.6, ph)}</g>`
        : ''
    // What you asked for: a magnifier (find / search) or a hammer (fix) for the length of the turn.
    const magnifier =
      fx?.intent === 'search' && i === 1
        ? wrap(
            `${r(12, 0, 3, 1, '#e4e4e7')}${r(12, 3, 3, 1, '#e4e4e7')}${r(12, 1, 1, 2, '#e4e4e7')}${r(14, 1, 1, 2, '#e4e4e7')}${r(13, 1, 1, 2, '#7dd3fc')}${r(11, 4, 1, 1, '#a16207')}`,
            tf('translate', '0 0;3 -1;0 0;-2 1;0 0', 1.6, ph),
          )
        : ''
    const hammer =
      fx?.intent === 'fix' && i === 3
        ? wrap(`${r(12, 1, 1, 4, '#a16207')}${r(11, 0, 4, 2, '#9ca3af')}`, tf('rotate', '0 12 -6;-38 12 -6;0 12 -6', 0.5, ph))
        : ''
    // a long tool call: one of them holds an umbrella
    const umbrella =
      fx?.umbrella && i === 4
        ? wrap(`${r(0, -1, 13, 1, '#ef4444')}${r(2, -2, 9, 1, '#f4f4f5')}${r(4, -3, 5, 1, '#ef4444')}${r(6, 0, 1, 1, '#a16207')}`, tf('translate', '0 0;0 -1;0 0', 1.2, ph))
        : ''
    // an error: a tear
    const tear =
      mood?.kind === 'sad' && i % 2 === 0
        ? `<g>${r(4, 3, 1, 1, '#60a5fa')}${once('translate', '0 0;0 9', 1.3, mood.age, 2, '', '0.4 0 1 1')}<animate attributeName="opacity" values="1;1;0" dur="1.3s" begin="${-mood.age}s" repeatCount="2"/></g>`
        : ''
    // a round sum, or passing tests: confetti
    const confetti =
      mood && (mood.kind === 'party' || mood.kind === 'cheer') && i % 2 === 0
        ? [0, 1, 2]
            .map(
              q =>
                `<g>${r(2 + q * 4, -2 - q, 1, 1, [PINK, GREEN, '#facc15'][(i + q) % 3])}${once('translate', '0 -8;0 12', 1.2, mood.age + q * 0.3, 4, '', LIN)}<animate attributeName="opacity" values="1;1;0" dur="1.2s" begin="${-(mood.age + q * 0.3)}s" repeatCount="4"/></g>`,
            )
            .join('')
        : ''
    const score = ball && (fx?.goals ?? 0) > 0 ? `<text x="${14}" y="${-17}" font-size="7" font-weight="700" fill="${DIM}" font-family="ui-monospace, monospace">×${fx!.goals}</text>` : ''
    const kit = ball ? `${r(2, 3, 9, 3, '#2563eb')}${r(6, 4, 1, 1, '#f4f4f5')}` : ''
    const ballSvg = (() => {
      if (!ball) return ''
      const body = `${r(12, 5, 3, 3, '#f4f4f5')}${r(13, 6, 1, 1, '#27272a')}`
      if (sleep) return `<g>${body}</g>`
      if (run) {
        const dribble = wrap(wrap(body, tf('translate', '0 0;0 -4;0 0', 0.4, ph)), tf('translate', '0 0;3 0;0 0', 0.8, ph))
        return dribble
      }
      if (goalFx) {
        // a shot into a little goal: the ball goes in, the goal and a flash show
        const sx = once('translate', '0 0;0 0;22 0;22 0', 2.4, goalFx.age, 1, '0;0.15;0.4;1', [LIN, '0.1 0.6 0.35 1', LIN])
        const sy = once('translate', '0 0;0 0;0 -8;0 0;0 0', 2.4, goalFx.age, 1, '0;0.15;0.27;0.4;1', [LIN, '0.1 0.6 0.35 1', '0.65 0 0.9 0.4', LIN])
        const frame = `<g opacity="0">${r(24, 3, 1, 5, '#e4e4e7')}${r(28, 3, 1, 5, '#e4e4e7')}${r(24, 3, 5, 1, '#e4e4e7')}${r(25, 4, 3, 4, '#3f3f46')}<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.08;0.9;1" dur="3.6s" begin="${-goalFx.age}s" repeatCount="1"/></g>`
        const flash = `<g opacity="0">${r(26, 0, 1, 3, '#fde68a')}${r(25, 1, 3, 1, '#fde68a')}<animate attributeName="opacity" values="0;0;1;0" keyTimes="0;0.38;0.45;0.75" dur="2.4s" begin="${-goalFx.age}s" repeatCount="1"/></g>`
        return `${frame}${flash}${wrap(wrap(body, sy), sx)}`
      }
      // kick out to a neighbour and let it roll back
      const x = tf('translate', '0 0;0 0;26 0;26 0;0 0', KICK, ph, '0;0.58;0.78;0.84;1', [LIN, '0.1 0.6 0.35 1', LIN, IO])
      const y = tf('translate', '0 0;0 0;0 -9;0 0;0 0', KICK, ph, '0;0.58;0.68;0.78;1', [LIN, '0.1 0.6 0.35 1', '0.65 0 0.9 0.4', LIN])
      return wrap(wrap(body, y), x)
    })()
    let core = `${arm(0, 0)}${arm(11, 1)}${paint(2, 0, 9, 6)}${kit}${eyes}${headgear}${leg(3, false)}${leg(7, false)}${leg(5, true)}${leg(9, true)}${ballSvg}${heart}${zz}${lines}${special}${score}${moon}${mug}${magnifier}${hammer}${umbrella}${tear}${confetti}`

    // layers, inside out: hop, squash, sway, turn-round
    const hop = run
      ? tf('translate', '0 0;0 -2;0 0', 0.4, ph)
      : sleep
        ? tf('translate', '0 0;0 1;0 0', 2.8, ph)
        : i === 0
          ? tf('translate', '0 0;0 -5;0 0;0 -5;0 0;0 0', 3.2, ph, '0;0.14;0.28;0.42;0.56;1', [IO, IO, IO, IO, LIN]) // double jump
          : tf('translate', '0 0;0 -4;0 0;0 0', 2 + i * 0.35, ph * 2, '0;0.2;0.4;1', [IO, IO, LIN])
    core = wrap(core, hop)
    if (mood) {
      const delay = rankOf(i) * 0.06
      core =
        mood.kind === 'sad'
          ? wrap(core, once('scale', '1 1;1 0.86;1 0.86;1 1', 3.2, mood.age - delay, 1, '0;0.2;0.8;1'))
          : wrap(core, once('translate', '0 0;0 -7;0 0', 0.55, mood.age - delay, 5))
    }
    if (waveOn) core = wrap(core, tf('translate', '0 0;0 -6;0 0;0 0', 4.4, -wb, '0;0.06;0.12;1', [IO, IO, LIN])) // the wave
    if (!run && (i === 3 || sleep))
      core = wrap(core, tf('scale', '1 1;1.1 0.9;1 1', sleep ? 2.8 : 2, ph)) // stretch / breathe
    if (!run && !sleep && (i === 2 || i === 1))
      core = wrap(core, tf('rotate', i === 2 ? '-8 0 0;8 0 0;-8 0 0' : '-3 0 0;3 0 0;-3 0 0', i === 2 ? 1.4 : 2.4, ph)) // sway
    if (run) core = `<g transform="rotate(5)">${core}</g>` // lean into the run
    if (!run && !sleep && i === 4)
      core = wrap(core, tf('scale', '1 1;-1 1;-1 1;1 1;1 1', 6, ph, '0;0.1;0.5;0.6;1', [IO, LIN, IO, LIN])) // turns round, and back

    // All run to the right in a line. Whoever leaves on the right comes back in
    // from the left: the picture's own edges hide the way round.
    if (run) {
      const move = wrap(core, tf('translate', `${-SW} 0;${L - SW} 0`, T, p0, '', LIN))
      return `<g transform="translate(0,${G})">${move}</g>`
    }
    // Just stopped: keep walking right, slowing down smoothly, to the spot in the
    // even row (the quadratic ease-out starts at running speed and ends at rest).
    if (settle) {
      const s0 = settle.s[i]
      const s1 = settle.h[i]
      const D = (((s1 - s0) % L) + L) % L
      if (D > 1) {
        const total = (3 * D) / SPEED // cubic ease-out: it starts at running speed (3D / total)
        const xa = (v: number) => v - SW // lap position -> x of the Clodie's centre
        const xh = xa(s1) // where it ends up: the static position, so a player that ignores the animation still shows the final row
        const move = (from: number, to: number, dur: number, begin: number, spline: string, freeze: boolean) =>
          `<animateTransform attributeName="transform" type="translate" values="${from.toFixed(1)} 0;${to.toFixed(1)} 0" calcMode="spline" keySplines="${spline}" dur="${dur.toFixed(3)}s" begin="${begin.toFixed(3)}s" ${freeze ? 'fill="freeze"' : ''}/>`
        const END = '0.3333 1 0.6667 1' // cubic ease-out
        let anim: string
        if (s0 + D <= L) {
          anim = move(xa(s0) - xh, 0, total, -settle.age, END, true)
        } else {
          // runs off the right edge and comes back in from the left, still slowing
          const q = (L - s0) / D
          const ts = 1 - Math.pow(1 - q, 1 / 3)
          const d1 = total * ts
          const y1 = ts / q
          const y2 = 1 - (ts * (1 - ts) * (1 - ts)) / q
          anim =
            move(xa(s0) - xh, xa(L) - xh, d1, -settle.age, `0.3333 ${y1.toFixed(4)} 0.6667 ${y2.toFixed(4)}`, false) +
            move(xa(0) - xh, 0, total - d1, d1 - settle.age, END, true)
        }
        return `<g transform="translate(${xh.toFixed(1)},${G})"><g>${anim}${core}</g></g>`
      }
    }
    // standing: where the phase left it (a Clodie caught outside the picture
    // stands just inside its edge)
    const x = p0 * SPEED - SW
    return `<g transform="translate(${x.toFixed(1)},${G})">${core}</g>`
  }
  const W = Math.round(width)
  const post = `<line x1="0.5" y1="6" x2="0.5" y2="${LANE_H - 6}" stroke="${LINE}"/><line x1="${W - 0.5}" y1="6" x2="${W - 0.5}" y2="${LANE_H - 6}" stroke="${LINE}"/>`
  // far-lane Clodies are drawn first so the near ones cover them
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${LANE_H}" viewBox="0 0 ${W} ${LANE_H}">
${post}
${Array.from({ length: COUNT }, (_, i) => one(i)).join('\n')}
</svg>`
}

// The token counters live in the session's state, which a full restart of Claude
// loses (the cost does not: the engine totals it). So they are also kept in the
// plugin's store under the session's id, and read back when the same session is
// resumed. Only the newest sessions are kept.
type Saved = Pick<Stats, 'steps' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'hist' | 'lastAt' | 'goals' | 'ttl'> & { at: number }
const TOTALS = 'totals'
const KEEP = 40
const saveTotals = async ($: any, s: Stats) => {
  try {
    const id = await $.session.id()
    const all = (((await $.store.get(TOTALS)) ?? {}) as Record<string, Saved>)
    all[id] = {
      steps: s.steps, input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite,
      hist: s.hist, lastAt: s.lastAt, goals: s.goals ?? 0, ttl: s.ttl, at: await $.clock.now(),
    }
    const ids = Object.keys(all)
    if (ids.length > KEEP) for (const k of ids.sort((a, b) => all[b].at - all[a].at).slice(KEEP)) delete all[k]
    await $.store.set(TOTALS, all)
  } catch {}
}
const loadTotals = async ($: any): Promise<Saved | null> => {
  try {
    const id = await $.session.id()
    return ((((await $.store.get(TOTALS)) ?? {}) as Record<string, Saved>)[id]) ?? null
  } catch {
    return null
  }
}

// The lo-fi player: mpv playing the stream's sound only, no window. The child
// lives as long as the loop reading it; ending the loop (Stop), the stream
// ending, or the module unloading (Claude closed, the mod reloaded) kills it.
let player: { return?: (v?: unknown) => unknown } | null = null
const find = async ($: any, bin: string) => {
  try {
    const r = await $.process.run(['/usr/bin/which', bin], { env: { PATH: LOFI_PATH }, timeoutMs: 5000 })
    return r.exitCode === 0 ? String(r.stdout).trim() : ''
  } catch {
    return ''
  }
}
const stopLofi = async ($: any) => {
  const p = player
  player = null
  await update($, lofi, () => false)
  try { await p?.return?.() } catch {}
}
const startLofi = async ($: any) => {
  const mpv = await find($, 'mpv')
  const ytdl = await find($, 'yt-dlp')
  if (!mpv || !ytdl) {
    await $.ui.toast(T_NEED)
    return
  }
  const stream = $.process.spawn({
    argv: [
      mpv, '--no-config', '--no-video', '--no-terminal', '--force-window=no', '--idle=no',
      '--ytdl-format=bestaudio/best', `--script-opts=ytdl_hook-ytdl_path=${ytdl}`, LOFI_URL,
    ],
    env: { PATH: LOFI_PATH },
  })
  player = stream
  await update($, lofi, () => true)
  void (async () => {
    let failed = false
    try {
      for await (const _ of stream) if (player !== stream) break
    } catch {
      failed = true
    }
    // it ended by itself (the stream dropped, mpv failed): show Play again
    if (player === stream) {
      player = null
      await update($, lofi, () => false)
      if (failed) await $.ui.toast(T_FAIL)
    }
  })()
}
const toggleLofi = async ($: any) => {
  if (player) await stopLofi($)
  else await startLofi($)
}

export const register: Register = on => {
  // Each Clodie's phase on the loop, in seconds (null: evenly spaced round it).
  // A run advances every phase by the same time, so the spacing is kept.
  let bases: number[] | null = null
  let runStart = 0
  let isRun = false
  let lastW = 400
  let turnErr = false // a tool failed during this turn
  let testsPassed = false // a test command succeeded during this turn
  let partyPending = false // a round sum was spent during this turn
  let settle: { s: number[]; h: number[]; start: number } | null = null
  let idleSince: number | null = null // when it last went quiet (ms); null while working
  let ultraSetting = false // ultracode as the settings hold it


  on('session.start', async ($, e, next) => {
    // a reload killed any player the module had: the button starts at Play
    await update($, lofi, () => false)
    await $.command.register({
      name: 'meter',
      description: 'Session cost, cache timer and token stats. Args: 1h | 5m | reset',
    })
    // A resumed session starts with empty counters: read them back from the store.
    const saved = await loadTotals($)
    if (saved) {
      await update($, stats, s =>
        s.steps > 0 ? s : {
          ...s, steps: saved.steps, input: saved.input, output: saved.output, cacheRead: saved.cacheRead,
          cacheWrite: saved.cacheWrite, hist: saved.hist, lastAt: saved.lastAt, goals: saved.goals, ttl: saved.ttl,
        })
    }
    // Keep the reasoning level, ultracode and the cost current while idle too.
    let lastPolled: string | undefined
    let seenSettingLevel = false
    let lastUltraSetting: boolean | undefined
    const sync = async () => {
      try {
        let level: string | undefined
        try {
          level = normLevel(await $.env.get('CLAUDE_EFFORT'))
        } catch {}
        try {
          const rows = await $.config.list()
          const row = rows.find(r => /effort/i.test(r.key))
          level = normLevel(row?.value) ?? level
        } catch {}
        let isUltra = false
        let modelCfg: Record<string, { autoCompactWindow?: number }> | undefined
        try {
          const st = (await $.settings.read()) as Record<string, unknown>
          // max is session-only: picking it removes effortLevel from the settings
          const fromSettings = normLevel(st.effortLevel)
          if (fromSettings) seenSettingLevel = true
          level = level ?? fromSettings ?? (seenSettingLevel ? "max" : undefined)
          isUltra = st.ultracode === true
          modelCfg = st.modelSettings as typeof modelCfg
        } catch {}
        // a polled level only counts when it CHANGES: the level the last request
        // went out with (turn.step) is otherwise the truth
        if (level === lastPolled) level = undefined
        else lastPolled = level
        ultraSetting = isUltra
        let usd: number | undefined
        let limitAt = 0
        let limitPct = 0
        let limit7At = 0
        let limit7Pct = 0
        let ctxTokens = -1
        let ctxWindow = 0
        let ctxLimit = 0
        try {
          const u = await $.session.usage()
          usd = u.cost?.usd
          ctxTokens = u.context.tokens ?? 0
          ctxWindow = u.context.window
          // /autocompact N is stored per model under modelSettings.<model>.autoCompactWindow
          let model = ''
          try {
            model = await $.session.model()
          } catch {}
          const cfg = modelCfg?.[model] ?? Object.entries(modelCfg ?? {}).find(([k]) => model !== '' && (model.startsWith(k) || k.startsWith(model)))?.[1]
          const at = cfg?.autoCompactWindow
          ctxLimit = typeof at === 'number' && at > 0 ? Math.min(at, ctxWindow) : 0
          const w = u.rateLimits.find(r => r.kind === 'five_hour')
          if (w?.resetsAt) {
            limitAt = Math.round(Date.parse(w.resetsAt) / 1000) * 1000
            limitPct = w.percentUsed
          }
          const w7 = u.rateLimits.find(r => r.kind === 'seven_day')
          if (w7?.resetsAt) {
            limit7At = Math.round(Date.parse(w7.resetsAt) / 1000) * 1000
            limit7Pct = w7.percentUsed
          }
        } catch {}
        const cur = await read($, stats)
        const changeLevel = level !== undefined && level !== cur.effort
        const changeUsd = usd !== undefined && Math.abs(usd - cur.usd) > 0.00005
        // ultracode as the setting holds it: follow it both ways, when it flips
        const flipped = lastUltraSetting === undefined ? isUltra : isUltra !== lastUltraSetting
        lastUltraSetting = isUltra
        const changeUltra = flipped && cur.ultra !== isUltra
        const changeCtx =
          ctxTokens >= 0 &&
          ctxWindow > 0 &&
          (Math.round(ctxTokens / 1000) !== Math.round((cur.ctxTokens ?? 0) / 1000) ||
            ctxWindow !== (cur.ctxWindow ?? 0) ||
            ctxLimit !== (cur.ctxLimit ?? 0))
        // a round sum ($10, $20 ...) was just passed
        const crossed = changeUsd && usd! > cur.usd && Math.floor(usd! / 10) > Math.floor(cur.usd / 10)
        if (crossed && isRun) partyPending = true
        const partyNow = crossed && !isRun
        const tNow = await $.clock.now()
        const changeLimit =
          limitAt > 0 && (limitAt !== (cur.limitResetAt ?? 0) || Math.abs(limitPct - (cur.limitPct ?? 0)) >= 1)
        const changeLimit7 =
          limit7At > 0 && (limit7At !== (cur.limit7ResetAt ?? 0) || Math.abs(limit7Pct - (cur.limit7Pct ?? 0)) >= 1)
        if (changeLevel || changeUsd || changeUltra || changeLimit || changeLimit7 || changeCtx)
          await update($, stats, s => ({
            ...s,
            ctxTokens: changeCtx ? ctxTokens : s.ctxTokens,
            ctxWindow: changeCtx ? ctxWindow : s.ctxWindow,
            ctxLimit: changeCtx ? ctxLimit : s.ctxLimit,
            fx: partyNow ? { kind: 'party', at: tNow } : s.fx,
            limitResetAt: changeLimit ? limitAt : s.limitResetAt,
            limitPct: changeLimit ? limitPct : s.limitPct,
            limit7ResetAt: changeLimit7 ? limit7At : s.limit7ResetAt,
            limit7Pct: changeLimit7 ? limit7Pct : s.limit7Pct,
            effort: changeLevel ? level! : s.effort,
            usd: changeUsd ? usd! : s.usd,
            ultra: changeUltra ? isUltra : s.ultra,
          }))
      } catch {}
    }
    void sync()
    $.clock.every(1500, sync)
    return next(e)
  })

  on('command.run', { command: 'meter' }, async ($, e) => {
    const arg = String((e as { args?: string }).args ?? '').trim()
    if (arg === '1h' || arg === '5m') {
      await update($, stats, s => ({ ...s, ttl: arg }))
    } else if (arg === 'reset') {
      await update($, stats, s => ({ ...empty, ttl: s.ttl, usd: s.usd, lastAt: s.lastAt }))
      await saveTotals($, await read($, stats))
    }
    await $.ui.open({ id: PANE })
    return { text: 'Session meter opened.' }
  })

  on('turn.start', async ($, e, next) => {
    if (!(e as { agentId?: string }).agentId && !isRun) {
      isRun = true
      idleSince = null
      settle = null
      runStart = await $.clock.now()
      await update($, stats, s => ({ ...s, busy: true }))
    }
    return next(e)
  })

  // Tool calls: a failure makes them sad, passing tests make them cheer, and a call
  // that runs long (8 s+) gets one of them an umbrella.
  const TEST_RE = /\b(test|tests|pytest|jest|vitest|mocha|rspec|phpunit)\b|cargo test|go test|npm (run )?t\b/i
  on('tool.call', async ($, e, next) => {
    if ((e as { agentId?: string }).agentId) return next(e)
    const timer = $.clock.after(8000, async () => {
      await update($, stats, s => (s.longTool ? s : { ...s, longTool: true }))
    })
    const ran = (await next(e)) as { isError?: boolean; deny?: string }
    timer.cancel()
    if (ran?.deny !== undefined) return ran
    if (ran?.isError === true) turnErr = true
    else if ((e as { tool?: string }).tool === 'Bash' && TEST_RE.test(String((e as { command?: string }).command ?? ''))) testsPassed = true
    await update($, stats, s => (s.longTool ? { ...s, longTool: false } : s))
    return ran
  })

  // "ultracode" in a prompt turns the sixth Clodie iridescent for that turn
  on('prompt.submit', async ($, e, next) => {
    const text = String((e as { text?: string }).text ?? '')
    const isUltra = /ultracode/i.test(text)
    const intent = /найд|найти|поиск|искать|\b(find|search|grep|locate|where is)\b/i.test(text)
      ? 'search'
      : /почин|исправ|баг|ошибк|\b(fix|bug|repair|broken)\b/i.test(text)
        ? 'fix'
        : ''
    turnErr = false
    testsPassed = false
    await update($, stats, s => ({ ...s, ultra: isUltra ? true : s.ultra, intent }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!(e as { agentId?: string }).agentId && isRun) {
      // Stop smoothly: each Clodie keeps walking, slowing down, to a place in the
      // even row. The clodies are spaced evenly round the lap, and so are the
      // row's places, so shifting the assignment by whole places leaves them all
      // with the same short walk: take the shift with the shortest one.
      const nowMs = await $.clock.now()
      const elapsed = (nowMs - runStart) / 1000
      const { L, SW } = laneGeometry(lastW)
      const lap = L / SPEED
      const base = bases ?? Array.from({ length: COUNT }, (_, i) => initPhase(i, lastW))
      const cur = base.map(b => ((((b + elapsed) % lap) + lap) % lap) * SPEED)
      const dist = (a: number, b: number) => (((b - a) % L) + L) % L
      const placeAt = (j: number) => rowPlace(j, lastW)
      // Take the shift whose shortest walk is still at least STOP_MIN px (a stop
      // that is too short looks like a snap); among those the shortest on average.
      let bestK = 0
      let bestScore = Infinity
      for (let k = 0; k < COUNT; k++) {
        const ds = cur.map((c, i) => dist(c, placeAt((i + k) % COUNT)))
        const shortest = Math.min(...ds)
        const avg = ds.reduce((a, d) => a + d, 0) / COUNT
        const score = shortest >= STOP_MIN ? avg : 1e6 - shortest
        if (score < bestScore) { bestScore = score; bestK = k }
      }
      const home = cur.map((_, i) => placeAt((i + bestK) % COUNT))
      bases = home.map(h => h / SPEED)
      settle = { s: cur, h: home, start: nowMs }
      idleSince = nowMs
      isRun = false
      // how the turn went: an error (sad), a round sum spent (party) or passing tests (cheer);
      // and a goal for the footballer unless a tool failed
      const kind = turnErr ? 'sad' : partyPending ? 'party' : testsPassed ? 'cheer' : ''
      const scored = !turnErr
      turnErr = false
      testsPassed = false
      partyPending = false
      await update($, stats, s => ({
        ...s,
        busy: false,
        ultra: ultraSetting,
        intent: '',
        longTool: false,
        fx: kind ? { kind, at: nowMs } : s.fx,
        goalAt: scored ? nowMs : s.goalAt,
        goals: (s.goals ?? 0) + (scored ? 1 : 0),
      }))
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const usd = e.cost?.usd
    if (usd !== undefined) await update($, stats, s => ({ ...s, usd }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // the reasoning level this request goes out with, for the sixth Clodie
    if (!e.agentId) {
      const level = normLevel(e.effort) ?? (typeof e.effort === 'number' ? 'max' : undefined)
      if (level) await update($, stats, s => (s.effort === level ? s : { ...s, effort: level }))
    }
    const r = yield* next(e)
    const u = r?.usage
    if (u) {
      const now = await $.clock.now()
      await update($, stats, s => ({
        ...s,
        steps: s.steps + 1,
        hist: [
          ...s.hist,
          u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
        ].slice(-24),
        input: s.input + u.input_tokens,
        output: s.output + u.output_tokens,
        cacheRead: s.cacheRead + u.cache_read_input_tokens,
        cacheWrite: s.cacheWrite + u.cache_creation_input_tokens,
        // the cache countdown follows the main thread only
        lastAt: e.agentId ? s.lastAt : now,
      }))
      await saveTotals($, await read($, stats))
    }
    return r
  })

  // The band above the prompt: the Clodies and the strip in one row, and the
  // stats card above it, revealed while the pointer is over the strip. The card
  // grows upward, so the strip never moves under the pointer. Nothing here is
  // redrawn on a timer: the countdown and the Clodies animate inside the pictures.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const t = $.ui.resolve(e) as any
    const { Box, Text } = t
    const s = await read($, stats)
    const nowMs = await $.clock.now()
    const reveal = { scope: 'session-meter', display: 'flex' as const }
    const R0 = remaining(s, nowMs)
    const mode: Mode = s.busy ? 'run' : R0 !== null && R0 <= 0 ? 'sleep' : 'idle'
    const cols = (e.props as { bodyColumns?: number }).bodyColumns ?? 120
    const playing = await read($, lofi)
    const hasBtn = !!t.Button
    const pill = pillSvg(s, nowMs, hasBtn)
    const pillW = Number(pill.match(/ width="(\d+)"/)?.[1] ?? 520)
    const trackW = Math.max(120, Math.min(1200, Math.round(cols * 8.8 - pillW - 16 - (hasBtn ? BTN_W : 0))))
    // Play / Stop for the lo-fi stream, at the right end of the strip
    const play = hasBtn ? (
      <Box width={t.Svg ? BTN_W : undefined} justifyContent="center" alignItems="center" flexShrink={0}>
        <t.Button
          key="lofi"
          plain
          label={playing ? T_STOP : T_PLAY}
          onPress={() => { void toggleLofi($) }}
        >
          <Text color={playing ? ACCENT : DIM}>{playing ? '\u25A0' : '\u25B6\uFE0E'}</Text>
        </t.Button>
      </Box>
    ) : null
    lastW = trackW
    const elapsed = isRun ? (nowMs - runStart) / 1000 : 0
    const age = settle ? (nowMs - settle.start) / 1000 : 0
    if (settle && age > 12) settle = null // the stop is long over
    if (!isRun && idleSince === null) idleSince = nowMs
    const bored = !isRun && idleSince !== null ? (nowMs - idleSince) / 1000 : null
    const stopping: Settle | null = settle && !isRun ? { s: settle.s, h: settle.h, age } : null

    // what the Clodies are reacting to right now
    const ago = (at: number) => (nowMs - at) / 1000
    const hour = new Date(nowMs).getHours()
    const weekday = new Date(nowMs).getDay()
    const fx: Fx = {
      mood: s.fx && ago(s.fx.at) < 6 ? { kind: s.fx.kind as 'sad' | 'cheer' | 'party', age: ago(s.fx.at) } : null,
      goal: (s.goalAt ?? 0) > 0 && ago(s.goalAt) < 3.6 ? { age: ago(s.goalAt) } : null,
      goals: s.goals ?? 0,
      umbrella: !!s.longTool,
      intent: s.intent ?? '',
      outfit: hour >= 22 || hour < 6 ? 'night' : weekday === 5 && hour >= 18 ? 'party' : hour >= 6 && hour < 10 ? 'morning' : '',
    }

    if (t.Svg) {
      const Svg = t.Svg
      return (
        <Box flexDirection="column" alignItems="flex-end" width="100%">
          <Box display="none" hover={reveal}>
            <Svg source={cardSvg(s, nowMs)} alt="Session statistics" />
          </Box>
          <Box justifyContent="space-between" alignItems="center" width="100%">
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Svg source={clodLane(mode, trackW, bases, elapsed, s.effort, s.ultra, stopping, bored, fx)} alt="Clodies" />
            </Box>
            <Box key="meter" hover={{ scope: 'session-meter' }} flexShrink={0}>
              <Svg source={pill} alt={`Session cost $${s.usd.toFixed(2)}`} />
            </Box>
            {play}
          </Box>
        </Box>
      )
    }
    const parts: [string, number][] = [
      ['Input (total)', s.input + s.cacheRead + s.cacheWrite],
      ['Input (uncached)', s.input],
      ['Output', s.output],
      ['Cache read', s.cacheRead],
      ['Cache write', s.cacheWrite],
    ]
    return (
      <Box flexDirection="column" alignItems="flex-end" width="100%">
        <Box display="none" hover={reveal} flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>Session ${s.usd.toFixed(4)}</Text>
          {parts.map(p => (
            <Box justifyContent="space-between" gap={2}>
              <Text>{p[0]}</Text>
              <Text>{n(p[1])}</Text>
            </Box>
          ))}
        </Box>
        <Box alignItems="center" gap={1}>
          <Box key="meter" hover={{ scope: 'session-meter' }}>
            <Text>
              ${s.usd.toFixed(2)} <Text dimColor>· IN {short(s.input + s.cacheRead + s.cacheWrite)} OUT {short(s.output)} CACHE {short(s.cacheRead)}</Text>
            </Text>
          </Box>
          {play}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e) as any
    const { Box, Text } = t
    const s = await read($, stats)
    const nowMs = await $.clock.now()
    if (t.Svg) {
      const Svg = t.Svg
      return <Svg source={cardSvg(s, nowMs)} alt="Session statistics" />
    }
    return (
      <Box flexDirection="column">
        <Text bold>Session ${s.usd.toFixed(4)}</Text>
        <Text>Input: {n(s.input + s.cacheRead + s.cacheWrite)} (uncached {n(s.input)})</Text>
        <Text>Output: {n(s.output)}</Text>
        <Text>Cache read: {n(s.cacheRead)}</Text>
        <Text>Cache write: {n(s.cacheWrite)}</Text>
      </Box>
    )
  })
}
