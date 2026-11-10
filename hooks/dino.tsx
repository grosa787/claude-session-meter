// The dino game, as in Chrome's offline page: a surface module (`Client`) that
// runs in the band above the strip. Pixels are drawn with half blocks: every
// cell holds two pixels, the top one as the glyph's colour and the bottom one
// as the cell's background.
//
// Space / ↑ / a click: jump; ↓: duck. Click the game first so it has the keys.
import type { ClientModule } from 'claude-code'

type Props = { best: number; lang: string }
type Ob = { x: number; kind: number; y: number }
type State = {
  mode: 'ready' | 'run' | 'over'
  y: number // the dino's feet above the ground, in pixels
  vy: number
  duck: number // ticks of ducking left
  obs: Ob[]
  clouds: { x: number; y: number }[]
  speed: number
  dist: number
  score: number
  best: number
  next: number // pixels until the next obstacle
  frame: number
}

const PX_ROWS = 16 // the playfield's height in pixels (8 rows of cells)
const TICK = 40 // ms per frame
const G = 0.22
const V0 = 1.9

// colours: 1 dino, 2 cactus, 3 ground, 4 cloud, 5 bird, 6 eye
const PAL = ['', '#e8e6df', '#8fbf7f', '#6b6a65', '#3d3d3a', '#d97757', '#1f1f1e']

const sprite = (rows: string[]) => rows.map(r => [...r].map(ch => (ch === '#' ? 1 : ch === 'o' ? 6 : 0)))
const DINO = [
  sprite(['      ####', '      #o##', '      ####', '      ##  ', '#    #### ', '##  ##### ', ' ####### #', '  #####   ', '   #  ##  ']),
  sprite(['      ####', '      #o##', '      ####', '      ##  ', '#    #### ', '##  ##### ', ' ####### #', '  #####   ', '   ##  #  ']),
]
const DUCK = [
  sprite(['#      #######', '##########o###', ' ######## ##  ', '  ####        ', '   #  ##      ']),
  sprite(['#      #######', '##########o###', ' ######## ##  ', '  ####        ', '   ##  #      ']),
]
const CACTI = [
  ['  #  ', '# # #', '#####', '  #  ', '  #  '],
  [' # ', '###', ' # ', ' # '],
  ['  #   # ', '# # # ##', '########', '  #   # ', '  #   # ', '  #   # '],
].map(r => r.map(row => [...row].map(ch => (ch === '#' ? 2 : 0))))
const BIRD = [
  ['  #    ', ' ###   ', '#######', '   ##  '],
  ['       ', ' ###   ', '#######', '  ##   '],
].map(r => r.map(row => [...row].map(ch => (ch === '#' ? 5 : 0))))

const fresh = (best: number, mode: State['mode']): State => ({
  mode, y: 0, vy: 0, duck: 0, obs: [], clouds: [{ x: 30, y: 3 }, { x: 90, y: 1 }],
  speed: 1, dist: 0, score: 0, best, next: 60, frame: 0,
})

const Dino: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const W = Math.max(40, Math.min(220, surface.columns || 100))
  const ru = props.lang === 'ru'
  let st = surface.state

  const step = (s: State): State => {
    if (s.mode !== 'run') return { ...s, frame: s.frame + 1 }
    const speed = Math.min(2.2, 1 + s.dist / 2400)
    let { y, vy } = s
    if (y > 0 || vy > 0) {
      y += vy
      vy -= G
      if (y <= 0) { y = 0; vy = 0 }
    }
    let next = s.next - speed
    let obs = s.obs.map(o => ({ ...o, x: o.x - speed * (o.kind >= 3 ? 1.15 : 1) })).filter(o => o.x > -16)
    if (next <= 0) {
      const birds = s.score > 250 && Math.random() < 0.3
      obs = [...obs, birds
        ? { x: W + 2, kind: 3, y: Math.random() < 0.5 ? 5 : 11 }
        : { x: W + 2, kind: Math.floor(Math.random() * 3), y: 0 }]
      next = 34 + Math.random() * 46 + speed * 12
    }
    const clouds = s.clouds.map(c => ({ ...c, x: c.x - speed * 0.25 })).map(c => (c.x < -10 ? { x: W + Math.random() * 30, y: Math.floor(Math.random() * 4) } : c))
    const duck = s.duck > 0 && y === 0 ? s.duck - 1 : 0
    const dist = s.dist + speed
    const score = Math.floor(dist / 4)
    // hit test on slightly smaller boxes than the sprites
    const dx = 3
    const dw = duck ? 13 : 7
    const dh = duck ? 4 : 8
    const hit = obs.some(o => {
      const spr = o.kind >= 3 ? BIRD[0]! : CACTI[o.kind]!
      const ow = spr[0]!.length
      const oh = spr.length
      const ox = o.x + 1
      const oy = o.y
      return ox < dx + dw && ox + ow - 2 > dx + 1 && oy < y + dh && oy + oh - 1 > y
    })
    if (hit) {
      const best = Math.max(s.best, score)
      if (best > s.best) surface.post({ best })
      return { ...s, mode: 'over', obs, score, best, frame: s.frame + 1 }
    }
    return { ...s, y, vy, duck, obs, clouds, speed, dist, score, next, frame: s.frame + 1 }
  }

  if (!st) {
    st = fresh(props.best ?? 0, 'ready')
    surface.every(TICK, () => {
      const cur = surface.state
      if (cur) surface.setState(step(cur))
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
      else if (k.key === 'down' || k.key === 's') {
        if (cur.mode === 'run') surface.setState({ ...cur, duck: 8, vy: cur.y > 0 ? Math.min(cur.vy, -1.6) : cur.vy })
      }
    })
    surface.onPointer(e => { if (e.type === 'down') jump() })
    surface.setState(st)
  }
  const s = st

  // ---- the picture
  const grid: number[][] = Array.from({ length: PX_ROWS }, () => new Array(W).fill(0))
  const put = (spr: number[][], x: number, bottom: number) => {
    // `bottom`: pixels above the ground line of the sprite's lowest row
    const h = spr.length
    for (let r = 0; r < h; r++) {
      const gy = PX_ROWS - 2 - bottom - (h - 1 - r)
      if (gy < 0 || gy >= PX_ROWS) continue
      const row = spr[r]!
      for (let c = 0; c < row.length; c++) {
        const gx = Math.round(x) + c
        if (row[c] && gx >= 0 && gx < W) grid[gy]![gx] = row[c]!
      }
    }
  }
  for (const c of s.clouds) {
    const cx = Math.round(c.x)
    for (let k = 0; k < 7; k++) if (cx + k >= 0 && cx + k < W) grid[c.y + 1]![cx + k] = 4
    for (let k = 2; k < 5; k++) if (cx + k >= 0 && cx + k < W) grid[c.y]![cx + k] = 4
  }
  // the ground line, with gaps that run past
  for (let x = 0; x < W; x++) grid[PX_ROWS - 1]![x] = Math.floor(x + s.dist) % 19 === 0 || Math.floor(x + s.dist) % 31 === 7 ? 0 : 3
  for (const o of s.obs) put(o.kind >= 3 ? BIRD[Math.floor(s.frame / 6) % 2]! : CACTI[o.kind]!, o.x, o.y)
  const legs = s.mode === 'run' && s.y === 0 ? Math.floor(s.frame / 3) % 2 : 0
  put(s.duck > 0 ? DUCK[legs]! : DINO[legs]!, 3, Math.round(s.y))

  const rows = []
  for (let r = 0; r < PX_ROWS / 2; r++) {
    const top = grid[2 * r]!
    const bot = grid[2 * r + 1]!
    const runs: { ch: string; fg?: string; bg?: string; n: number }[] = []
    for (let x = 0; x < W; x++) {
      const a = top[x]!
      const b = bot[x]!
      const cell = a === b ? (a ? { ch: ' ', bg: PAL[a] } : { ch: ' ' }) : !a ? { ch: '▄', fg: PAL[b] } : !b ? { ch: '▀', fg: PAL[a] } : { ch: '▀', fg: PAL[a], bg: PAL[b] }
      const last = runs[runs.length - 1]
      if (last && last.fg === cell.fg && last.bg === cell.bg && last.ch === cell.ch) last.n++
      else runs.push({ ...cell, n: 1 })
    }
    rows.push(
      <Box key={`r${r}`} height={1}>
        {runs.map((u, k) => (
          <Text key={`c${k}`} mono color={u.fg} backgroundColor={u.bg}>{u.ch.repeat(u.n)}</Text>
        ))}
      </Box>,
    )
  }
  const pad = (v: number) => String(v).padStart(5, '0')
  const hint = s.mode === 'ready'
    ? (ru ? 'Кликните по игре и жмите пробел или ↑ — прыжок, ↓ — пригнуться' : 'Click the game, then Space or ↑ to jump, ↓ to duck')
    : s.mode === 'over'
      ? (ru ? 'ИГРА ОКОНЧЕНА — пробел или клик, чтобы заново' : 'GAME OVER — Space or click to restart')
      : ''
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" height={1}>
        <Text dimColor>{hint}</Text>
        <Text mono tabular>
          <Text dimColor>HI {pad(s.best)}  </Text>
          {pad(s.score)}
        </Text>
      </Box>
      {rows}
    </Box>
  )
}

export default Dino
