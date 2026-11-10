// The dino game, as in Chrome's offline page: a surface module (`Client`) that
// runs in the band above the strip, at 60 frames a second.
//
// Pixels are drawn with quadrant blocks (▘ ▝ ▖ ▗ ▚ ▞ ▀ ▄ ▌ ▐ ▛ ▜ ▙ ▟ █): every
// text cell holds 2×2 pixels in up to two colours, the glyph's and the cell's
// background. A cell is about 1.5 times taller than wide, so a pixel of the
// world is 1.5 fine columns wide: the art keeps its proportions.
//
// Space / ↑ / a click: jump; ↓: duck (in the air: drop). Click the game first so it has the keys.
import type { ClientModule } from 'claude-code'

type Props = { best: number; lang: string }
type Ob = { x: number; kind: number; y: number }
type State = {
  mode: 'ready' | 'run' | 'over'
  y: number // the dino's feet above the ground, world pixels
  vy: number
  duck: number // seconds of ducking left
  obs: Ob[]
  speed: number
  dist: number
  score: number
  best: number
  next: number // world pixels until the next obstacle
  t: number // seconds since the start (animation)
  last: number // ms of the last frame
  flash: number // seconds left of the "every 100" flash
}

const ASPECT = 1.5 // fine columns per world pixel
const G = 150 // gravity, world px / s²
const V0 = 44 // jump speed: a peak of about 6.5 px
const V_START = 42
const V_MAX = 80

// colours (0 is the sky)
const C = { dino: 1, eye: 2, cactus: 3, shade: 4, ground: 5, pebble: 6, cloud: 7, hill: 8, bird: 9, moon: 10, hurt: 11, star: 12 }
const PAL = ['', '#ecebe4', '#1f1f1e', '#7fb069', '#4f7a42', '#7a7973', '#4a4945', '#3b3b38', '#2c2c2a', '#d97757', '#d8d4c4', '#e5534b', '#5a5955']

// sprites, in world pixels: '#' body, 'o' eye, 's' shade, 'x' a hurt eye
const art = (rows: string[], body: number) =>
  rows.map(r => [...r].map(ch => (ch === '#' ? body : ch === 'o' ? C.eye : ch === 's' ? C.shade : ch === 'x' ? C.hurt : 0)))
const DINO_RUN = [
  art(['      #####', '      #o###', '      #####', '#     ###  ', '##   ##### ', '########## ', ' #######   ', '  ##  #    ', '  #   ##   '], C.dino),
  art(['      #####', '      #o###', '      #####', '#     ###  ', '##   ##### ', '########## ', ' #######   ', '  ##  #    ', '  ##   #   '], C.dino),
]
const DINO_STAND = art(['      #####', '      #o###', '      #####', '#     ###  ', '##   ##### ', '########## ', ' #######   ', '  ##  #    ', '  ##  ##   '], C.dino)
const DINO_HURT = art(['      #####', '      #x###', '      #####', '#     #####', '##   ##### ', '########## ', ' #######   ', '  ##  #    ', '  ##  ##   '], C.dino)
const DINO_DUCK = [
  art(['#       ######', '##########o###', ' ######## ### ', '  ##  #       ', '  #   ##      '], C.dino),
  art(['#       ######', '##########o###', ' ######## ### ', '  ##  #       ', '  ##   #      '], C.dino),
]
const CACTI = [
  art([' # ', ' #s', '##s', ' #s', ' #s'], C.cactus),
  art(['# #s ', '# #s#', '###s#', '  #s#', '  #s '], C.cactus),
  art([' #   # ', ' #s # #', '##s ##s', ' #s  #s', ' #s  #s'], C.cactus),
  art(['#  #s # ', '#  #s # ', '####s## ', '   #s   ', '   #s   '], C.cactus),
]
const BIRD = [
  art(['   #     ', '   ##    ', '  ####   ', '#######  ', '   ######', '   ##    '], C.bird),
  art(['         ', '         ', '  ####   ', '#######  ', '   ######', '  ###    '], C.bird),
]

const now = () => (typeof Date !== 'undefined' ? Date.now() : 0)
const fresh = (best: number, mode: State['mode']): State => ({
  mode, y: 0, vy: 0, duck: 0, obs: [], speed: V_START, dist: 0, score: 0, best, next: 120, t: 0, last: now(), flash: 0,
})

// quadrant glyphs by which of the four pixels are set: 1 top-left, 2 top-right, 4 bottom-left, 8 bottom-right
const QUAD = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█']

const Dino: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const cols = Math.max(40, Math.min(240, surface.columns || 110))
  const rows = Math.max(5, Math.min(10, surface.rows || 8))
  const FW = cols * 2 // fine columns
  const FH = rows * 2 // pixel rows (a world pixel is one row tall)
  const WW = FW / ASPECT // the world's width
  const GROUND = FH - 2 // the ground line's row; feet stand on the row above it
  const ru = props.lang === 'ru'

  const step = (s: State, dt: number): State => {
    const t = s.t + dt
    if (s.mode !== 'run') return { ...s, t }
    const speed = Math.min(V_MAX, V_START + s.dist / 90)
    let { y, vy } = s
    if (y > 0 || vy > 0) {
      vy -= G * dt * (s.duck > 0 ? 2.6 : 1) // ↓ in the air drops faster
      y += vy * dt
      if (y <= 0) { y = 0; vy = 0 }
    }
    const duck = Math.max(0, s.duck - dt)
    let next = s.next - speed * dt
    let obs = s.obs.map(o => ({ ...o, x: o.x - speed * dt * (o.kind >= 10 ? 1.12 : 1) })).filter(o => o.x > -20)
    if (next <= 0) {
      const birds = s.score > 250 && Math.random() < 0.3
      obs = [...obs, birds
        ? { x: WW + 4, kind: 10, y: Math.random() < 0.5 ? 4 : 9 } // low: duck under it; high: it flies over
        : { x: WW + 4, kind: Math.floor(Math.random() * CACTI.length), y: 0 }]
      next = 70 + Math.random() * 90 + speed * 0.9
    }
    const dist = s.dist + speed * dt
    const score = Math.floor(dist / 7)
    const flash = Math.floor(score / 100) > Math.floor(s.score / 100) ? 1.2 : Math.max(0, s.flash - dt)
    // the hit test, on boxes a pixel inside the sprites
    const dSpr = duck > 0 && y === 0 ? DINO_DUCK[0]! : DINO_STAND
    const dx0 = 4 + 1
    const dx1 = 4 + dSpr[0]!.length - 2
    const dy0 = y
    const dy1 = y + dSpr.length - 1.5
    const hit = obs.some(o => {
      const spr = o.kind >= 10 ? BIRD[0]! : CACTI[o.kind]!
      const ox0 = o.x + 0.8
      const ox1 = o.x + spr[0]!.length - 0.8
      const oy0 = o.y + (o.kind >= 10 ? 1 : 0)
      const oy1 = o.y + spr.length - 1
      return ox0 < dx1 && ox1 > dx0 && oy0 < dy1 && oy1 > dy0
    })
    if (hit) {
      const best = Math.max(s.best, score)
      if (best > s.best) surface.post({ best })
      return { ...s, mode: 'over', y, obs, score, best, t }
    }
    return { ...s, y, vy, duck, obs, speed, dist, score, next, t, flash }
  }

  let st = surface.state
  if (!st) {
    st = fresh(props.best ?? 0, 'ready')
    surface.every(16, () => {
      const cur = surface.state
      if (!cur) return
      const ms = now()
      const dt = Math.min(0.05, Math.max(0, (ms - cur.last) / 1000)) || 1 / 60
      surface.setState({ ...step(cur, dt), last: ms })
    })
    const jump = () => {
      const cur = surface.state
      if (!cur) return
      if (cur.mode !== 'run') surface.setState({ ...fresh(Math.max(cur.best, props.best ?? 0), 'run'), vy: V0, y: 0.01 })
      else if (cur.y === 0) surface.setState({ ...cur, vy: V0, y: 0.01, duck: 0 })
    }
    surface.onKey(k => {
      const cur = surface.state
      if (!cur) return
      if (k.key === ' ' || k.key === 'space' || k.key === 'up' || k.key === 'w' || k.key === 'return') jump()
      else if ((k.key === 'down' || k.key === 's') && cur.mode === 'run') surface.setState({ ...cur, duck: 0.3 })
    })
    surface.onPointer(e => { if (e.type === 'down') jump() })
    surface.setState(st)
  }
  const s = st

  // ---- the picture, on a grid of fine pixels
  const grid: Uint8Array[] = Array.from({ length: FH }, () => new Uint8Array(FW))
  const fx = (wx: number) => Math.round(wx * ASPECT)
  const plot = (wx: number, wy: number, w: number, c: number) => {
    if (wy < 0 || wy >= FH) return
    const a = Math.max(0, fx(wx))
    const b = Math.min(FW, fx(wx + w))
    const row = grid[wy]!
    for (let x = a; x < b; x++) row[x] = c
  }
  const put = (spr: number[][], wx: number, lift: number) => {
    const h = spr.length
    const base = GROUND - 1 - Math.round(lift) // the sprite's lowest row
    for (let r = 0; r < h; r++) {
      const line = spr[r]!
      for (let c = 0; c < line.length; c++) if (line[c]) plot(wx + c, base - (h - 1 - r), 1, line[c]!)
    }
  }
  // stars that twinkle, and a crescent moon
  for (let k = 0; k < 14; k++) {
    const sx = (k * 53.7 + 11) % WW
    const sy = (k * 7) % Math.max(1, GROUND - 9)
    if (Math.sin(s.t * 1.3 + k) > -0.6) plot(sx, sy, 1, C.star)
  }
  const mx = WW * 0.72
  for (const [dx, dy, w] of [[1, 0, 3], [0, 1, 2], [0, 2, 2], [0, 3, 2], [1, 4, 3]] as const) plot(mx + dx, 1 + dy, w, C.moon)
  // far hills (slow), then clouds (slower still)
  const hillOff = s.dist * 0.15
  for (let wx = 0; wx < WW; wx++) {
    const u = wx + hillOff
    const h = Math.max(0, Math.round(2.2 + 1.8 * Math.sin(u / 23) + 1.2 * Math.sin(u / 9.5 + 1.3)))
    for (let k = 0; k < h; k++) plot(wx, GROUND - 1 - k, 1, C.hill)
  }
  const cloudOff = s.dist * 0.3 + s.t * 2
  for (let k = 0; k < 3; k++) {
    const span = WW + 30
    const cx = ((k * span) / 3 - cloudOff) % span
    const x0 = (cx < 0 ? cx + span : cx) - 15
    const cy = 3 + ((k * 2) % 4)
    plot(x0 + 3, cy, 5, C.cloud)
    plot(x0, cy + 1, 11, C.cloud)
  }
  // the ground: a line, and pebbles below it that run past
  for (let wx = 0; wx < WW; wx++) {
    const u = Math.floor(wx + s.dist)
    plot(wx, GROUND, 1, u % 37 === 0 ? C.pebble : C.ground)
    if (u % 11 === 3 || u % 17 === 8) plot(wx, GROUND + 1, 1, C.pebble)
  }
  // obstacles, then the dino
  for (const o of s.obs) {
    if (o.kind >= 10) put(BIRD[Math.floor(s.t * 6) % 2]!, o.x, o.y)
    else put(CACTI[o.kind]!, o.x, 0)
  }
  const legs = Math.floor(s.t * 12) % 2
  const dino = s.mode === 'over' ? DINO_HURT
    : s.mode === 'ready' ? DINO_STAND
      : s.duck > 0 && s.y === 0 ? DINO_DUCK[legs]!
        : s.y > 0 ? DINO_STAND : DINO_RUN[legs]!
  put(dino, 4, s.y)

  // ---- text over the picture: the score at the top right, a hint in the middle
  const pad = (v: number) => String(v).padStart(5, '0')
  const over: Record<number, { col: number; text: string; color: string }[]> = {}
  const blink = s.flash > 0 && Math.floor(s.flash * 6) % 2 === 0
  const scoreText = `HI ${pad(s.best)} ${blink ? '     ' : pad(s.score)}`
  over[0] = [{ col: cols - scoreText.length - 1, text: scoreText, color: '#9b9a94' }]
  const hint = s.mode === 'ready'
    ? (ru ? 'кликните и жмите пробел — прыжок, ↓ — пригнуться' : 'click, then Space to jump, ↓ to duck')
    : s.mode === 'over'
      ? (ru ? 'G A M E   O V E R  ·  пробел — заново' : 'G A M E   O V E R  ·  Space to restart')
      : ''
  if (hint) over[Math.floor(rows / 2) - 1] = [{ col: Math.max(0, Math.floor((cols - hint.length) / 2)), text: hint, color: '#ecebe4' }]

  const lines = []
  for (let r = 0; r < rows; r++) {
    const top = grid[2 * r]!
    const bot = grid[2 * r + 1]!
    const cells: { ch: string; fg?: string; bg?: string }[] = []
    for (let c = 0; c < cols; c++) {
      const px = [top[2 * c]!, top[2 * c + 1]!, bot[2 * c]!, bot[2 * c + 1]!]
      // the two colours most used in the cell (the sky counts as one)
      const count = new Map<number, number>()
      for (const p of px) count.set(p, (count.get(p) ?? 0) + 1)
      const solid = [...count.entries()].filter(([k]) => k !== 0).sort((a, b) => b[1] - a[1] || b[0] - a[0])
      if (solid.length === 0) { cells.push({ ch: ' ' }); continue }
      const fg = solid[0]![0]
      // the background: the sky, or the second colour where it covers more than the sky does
      const sky = count.get(0) ?? 0
      const second = solid[1]
      const bg = second && second[1] >= sky ? second[0] : 0
      let bits = 0
      px.forEach((p, k) => { if (p === fg) bits |= 1 << k })
      if (bits === 15) cells.push({ ch: ' ', bg: PAL[fg] })
      else cells.push({ ch: QUAD[bits]!, fg: PAL[fg], bg: bg ? PAL[bg] : undefined })
    }
    for (const o of over[r] ?? []) {
      [...o.text].forEach((ch, k) => {
        const c = o.col + k
        if (c >= 0 && c < cols) cells[c] = { ch, fg: o.color, bg: cells[c]!.bg }
      })
    }
    // runs of cells that look alike become one Text
    const runs: { ch: string; fg?: string; bg?: string }[] = []
    let cur: { ch: string; fg?: string; bg?: string } | null = null
    for (const cell of cells) {
      if (cur && cur.fg === cell.fg && cur.bg === cell.bg) cur.ch += cell.ch
      else { cur = { ...cell }; runs.push(cur) }
    }
    lines.push(
      <Box key={`r${r}`} height={1}>
        {runs.map((u, k) => (
          <Text key={`c${k}`} mono color={u.fg} backgroundColor={u.bg}>{u.ch}</Text>
        ))}
      </Box>,
    )
  }
  return <Box flexDirection="column">{lines}</Box>
}

export default Dino
