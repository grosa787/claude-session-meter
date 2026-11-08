// The lo-fi player: a YouTube live stream played by mpv, sound only, no window.
//
// Fast start: when the track menu opens, every track starts loading in a paused
// mpv (a "warm" player, steered through its IPC socket). Picking a track only
// unpauses it, so the music starts at once; the others are killed. The streams'
// direct addresses are looked up ahead (yt-dlp, about 3 s) and kept in the store
// for every session, so a warm player skips that step too.
//
// A child lives as long as the loop reading it: ending the loop (Stop), the
// stream ending, or the module unloading (Claude closed, the mod reloaded) kills it.
import { atom, read, update } from 'claude-code'

export type Track = { id: string; name: string; by: string; vid: string }
// Long-running 24/7 streams. The menu shows them in columns of two, left to
// right, so the last column (next to the button) holds the first two picks.
export const TRACKS: Track[] = [
  { id: 'chillhop', name: 'lofi hip hop radio', by: 'Chillhop Music', vid: '7NOSDKb0HlU' },
  { id: 'chillhopradio', name: 'Chillhop Radio', by: 'Chillhop Music', vid: '5yx6BWlEVcY' },
  { id: 'bootleg', name: 'sad & sleepy beats', by: 'the bootleg boy', vid: 'FWjZ0x2M8og' },
  { id: 'jazz', name: 'jazz lofi radio', by: 'Lofi Girl', vid: 'E2vONfzoyRI' },
  { id: 'synthwave', name: 'synthwave radio', by: 'Lofi Girl', vid: '4xDzrJKXOOY' },
  { id: 'sleep', name: 'sleep/chill radio', by: 'Lofi Girl', vid: 'JD-kMIpDfnY' },
  { id: 'lofigirl', name: 'lofi hip hop radio', by: 'Lofi Girl', vid: 'rFZHOHl-L8A' },
  { id: 'claude', name: 'Claude FM', by: 'Claude', vid: 'tRsQsTMvPNg' },
]
// warmed up when the menu opens (all of them would be eight streams loading at
// once): the last pick, then these; the rest start in two or three seconds
const WARM_FIRST = ['lofigirl', 'claude']
const WARM_MAX = 3
const LAST = 'lofiLast' // store: the id of the last pick
const VOL = 'lofiVol' // store: the volume, 0..100 (mpv's scale is cubic: 60 is about -13 dB)
export const DEFAULT_VOL = 60
const watchUrl = (t: Track) => `https://www.youtube.com/watch?v=${t.vid}`

// what plays now ('' for nothing), whether the menu is open, the thumbnails (data URIs);
// the hooks module declares the same atoms to read them
const lofiTrack = atom({ plugin: 'session-meter', key: 'lofiTrack' } as const, '')
const lofiMenu = atom({ plugin: 'session-meter', key: 'lofiMenu' } as const, false)
const lofiThumbs = atom({ plugin: 'session-meter', key: 'lofiThumbs' } as const, {} as Record<string, string>)

// toasts, in the strip's language (set by the hooks module)
export const LOFI_MSG = { need: 'Lo-fi needs mpv and yt-dlp: brew install mpv yt-dlp', fail: 'Lo-fi did not start: the stream is unavailable', vol: 'Lo-fi volume' }

const PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
const URLS = 'lofiUrls' // store: vid -> { url, exp } (exp in seconds)
const THUMBS = 'lofiThumbs' // store: vid -> { data, at }
const DAY = 86_400_000

type Proc = { stream: any; sock: string; vid: string; cached: boolean; t0: number }
let player: Proc | null = null
const warm: Record<string, Proc> = {}

const bins: Record<string, string> = {}
async function find($: any, bin: string) {
  if (bins[bin]) return bins[bin]
  try {
    const r = await $.process.run(['/usr/bin/which', bin], { env: { PATH }, timeoutMs: 5000 })
    if (r.exitCode === 0) bins[bin] = String(r.stdout).trim()
  } catch {}
  return bins[bin] ?? ''
}

async function cachedUrl($: any, vid: string, nowMs: number) {
  try {
    const all = ((await $.store.get(URLS)) ?? {}) as Record<string, { url: string; exp: number }>
    const c = all[vid]
    return c && c.exp * 1000 - nowMs > 15 * 60_000 ? c.url : ''
  } catch {
    return ''
  }
}
async function forgetUrl($: any, vid: string) {
  try {
    const all = ((await $.store.get(URLS)) ?? {}) as Record<string, unknown>
    delete all[vid]
    await $.store.set(URLS, all)
  } catch {}
}

// Fetches the thumbnails that are missing or a day old, all at once; each one
// shows as soon as it is in. Then looks up the streams' direct addresses (a few
// at a time; about 3 s each). Run in the background at the session's start;
// quiet when offline.
export async function prefetchLofi($: any) {
  await prefetchThumbs($)
  await prefetchUrls($)
}

// One thumbnail as a small JPEG (160x90) in a data URI, or '' when it cannot be had.
async function fetchThumb($: any, t: Track) {
  try {
    const sh = `f=$(mktemp -t smthumb).jpg; curl -sfL -m 10 -o "$f" "https://i.ytimg.com/vi/${t.vid}/mqdefault.jpg" && sips -Z 160 -s formatOptions 75 "$f" >/dev/null 2>&1; base64 < "$f"; rm -f "$f"`
    const r = await $.process.run(['/bin/sh', '-c', sh], { env: { PATH }, timeoutMs: 20_000 })
    const b64 = String(r.stdout).replace(/\s+/g, '')
    if (r.exitCode === 0 && b64.length > 500) {
      const data = `data:image/jpeg;base64,${b64}`
      await update($, lofiThumbs, (m: Record<string, string>) => ({ ...m, [t.vid]: data }))
      return data
    }
  } catch {}
  return ''
}

export async function prefetchThumbs($: any) {
  const nowMs = await $.clock.now()
  let stored: Record<string, { data: string; at: number }> = {}
  try {
    stored = ((await $.store.get(THUMBS)) ?? {}) as typeof stored
  } catch {}
  // what the store already has shows at once
  const have: Record<string, string> = {}
  for (const t of TRACKS) if (stored[t.vid]) have[t.vid] = stored[t.vid]!.data
  await update($, lofiThumbs, (m: Record<string, string>) => ({ ...have, ...m }))
  const todo = TRACKS.filter(t => !stored[t.vid] || nowMs - stored[t.vid]!.at >= DAY)
  if (todo.length === 0) return
  const got = await Promise.all(todo.map(t => fetchThumb($, t)))
  try {
    const all = ((await $.store.get(THUMBS)) ?? {}) as typeof stored
    todo.forEach((t, k) => { if (got[k]) all[t.vid] = { data: got[k]!, at: nowMs } })
    await $.store.set(THUMBS, all)
  } catch {}
}

async function lookUp($: any, ytdl: string, t: Track) {
  try {
    const r = await $.process.run([ytdl, '-f', 'bestaudio/best', '-g', watchUrl(t)], { env: { PATH }, timeoutMs: 40_000 })
    const url = String(r.stdout).trim().split('\n')[0] ?? ''
    const exp = Number(url.match(/expire\/(\d+)/)?.[1] ?? 0)
    if (r.exitCode === 0 && url && exp) return { url, exp }
  } catch {}
  return null
}

async function prefetchUrls($: any) {
  const ytdl = await find($, 'yt-dlp')
  if (!ytdl) return
  const nowMs = await $.clock.now()
  const todo: Track[] = []
  for (const t of TRACKS) if (!(await cachedUrl($, t.vid, nowMs))) todo.push(t)
  for (let k = 0; k < todo.length; k += 4) {
    const batch = todo.slice(k, k + 4)
    const got = await Promise.all(batch.map(t => lookUp($, ytdl, t)))
    try {
      const all = ((await $.store.get(URLS)) ?? {}) as Record<string, unknown>
      batch.forEach((t, j) => { if (got[j]) all[t.vid] = got[j] })
      await $.store.set(URLS, all)
    } catch {}
  }
}

// Starts mpv for a track, paused (warm) or playing.
async function spawn($: any, t: Track, paused: boolean): Promise<Proc | null> {
  const mpv = await find($, 'mpv')
  const ytdl = await find($, 'yt-dlp')
  if (!mpv || !ytdl) return null
  const nowMs = await $.clock.now()
  const direct = await cachedUrl($, t.vid, nowMs)
  const sock = `/tmp/session-meter-lofi-${t.vid}-${nowMs}.sock`
  const vol = await getVolume($)
  // Steady playback: start a few segments behind the live edge (a buffer from the
  // first second), keep up to a minute read ahead, open a fresh connection for
  // every segment (YouTube drops kept-alive ones) and reconnect when one breaks.
  const argv = [
    mpv, '--no-config', '--no-video', '--no-terminal', '--force-window=no', '--idle=no',
    `--volume=${vol}`,
    '--cache=yes', '--cache-secs=60', '--demuxer-max-bytes=32MiB', '--demuxer-readahead-secs=30',
    '--demuxer-lavf-o=live_start_index=-4,http_persistent=0',
    '--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=4',
    '--cache-pause-wait=2',
    `--input-ipc-server=${sock}`,
    ...(paused ? ['--pause'] : []),
    ...(direct
      ? ['--ytdl=no', direct]
      : ['--ytdl-format=bestaudio/best', `--script-opts=ytdl_hook-ytdl_path=${ytdl}`, watchUrl(t)]),
  ]
  const p: Proc = { stream: $.process.spawn({ argv, env: { PATH } }), sock, vid: t.vid, cached: !!direct, t0: nowMs }
  void watch($, p)
  return p
}

// Reads the child until it ends. Ending by itself (not stopped by us) means the
// stream dropped or mpv failed: a stale cached address is forgotten and the track
// tried once more through yt-dlp; otherwise the button goes back to Play.
async function watch($: any, p: Proc) {
  try {
    for await (const _ of p.stream) { /* mpv writes nothing: --no-terminal */ }
  } catch {}
  // the control socket mpv may leave behind
  try { await $.process.run(['/bin/rm', '-f', p.sock], { timeoutMs: 5000 }) } catch {}
  if (warm[p.vid] === p) {
    delete warm[p.vid]
    if (p.cached) await forgetUrl($, p.vid)
  }
  if (player === p) {
    player = null
    const quick = (await $.clock.now()) - p.t0 < 20_000
    if (p.cached && quick) {
      await forgetUrl($, p.vid)
      const t = TRACKS.find(x => x.vid === p.vid)
      const again = t ? await spawn($, t, false) : null
      if (again) {
        player = again
        return
      }
    }
    await update($, lofiTrack, () => '')
    await $.ui.toast(LOFI_MSG.fail)
  }
}

async function kill(p: Proc | null | undefined) {
  try { await p?.stream?.return?.() } catch {}
}

// Sends one command to a player through its socket.
async function send($: any, p: Proc, command: unknown[]) {
  try {
    const r = await $.process.run(['/usr/bin/nc', '-U', p.sock], { stdin: JSON.stringify({ command }) + '\n', timeoutMs: 2000 })
    return r.exitCode === 0 && String(r.stdout).includes('success')
  } catch {
    return false
  }
}

// Unpauses a warm player (its socket may not exist for the first instants
// after the start: tried for up to 3 s).
async function unpause($: any, p: Proc) {
  for (let i = 0; i < 15; i++) {
    if (await send($, p, ['set_property', 'pause', false])) return true
    await $.clock.sleep({ ms: 200 })
  }
  return false
}

export async function getVolume($: any) {
  try {
    const raw = await $.store.get(VOL)
    const v = Number(raw)
    return raw !== undefined && raw !== null && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : DEFAULT_VOL
  } catch {
    return DEFAULT_VOL
  }
}

// Sets the volume (0..100), remembers it, and applies it to what is playing and warming.
export async function setVolume($: any, v: number) {
  const vol = Math.max(0, Math.min(100, Math.round(v)))
  try { await $.store.set(VOL, vol) } catch {}
  for (const p of [player, ...Object.values(warm)]) if (p) await send($, p, ['set_property', 'volume', vol])
  return vol
}

async function coolDown() {
  for (const vid of Object.keys(warm)) {
    const p = warm[vid]
    delete warm[vid]
    await kill(p)
  }
}

export async function stopLofi($: any) {
  const p = player
  player = null
  await update($, lofiTrack, () => '')
  await kill(p)
}

// The strip's button: Stop while playing; otherwise opens the menu (and warms
// every track up) or closes it again.
export async function pressLofi($: any) {
  if (player) return stopLofi($)
  return (await read($, lofiMenu)) ? closeMenu($) : openMenu($)
}

export async function openMenu($: any) {
  if (!(await find($, 'mpv')) || !(await find($, 'yt-dlp'))) {
    await $.ui.toast(LOFI_MSG.need)
    return
  }
  await update($, lofiMenu, () => true)
  // thumbnails still missing (the session has just started): fetch them now
  const shown = (await read($, lofiThumbs)) as Record<string, string>
  if (TRACKS.some(t => !shown[t.vid])) void prefetchThumbs($)
  let last = ''
  try { last = String((await $.store.get(LAST)) ?? '') } catch {}
  const ids = [...new Set([last, ...WARM_FIRST].filter(Boolean))].slice(0, WARM_MAX)
  for (const id of ids) {
    const t = TRACKS.find(x => x.id === id)
    if (!t || warm[t.vid]) continue
    const p = await spawn($, t, true)
    if (p) warm[t.vid] = p
  }
}

export async function closeMenu($: any) {
  await update($, lofiMenu, () => false)
  await coolDown()
}

export async function pickLofi($: any, id: string) {
  const t = TRACKS.find(x => x.id === id)
  if (!t) return
  await update($, lofiMenu, () => false)
  await stopLofi($)
  let p = warm[t.vid] ?? null
  delete warm[t.vid]
  await coolDown()
  if (p && !(await unpause($, p))) {
    await kill(p)
    p = null
  }
  if (!p) p = await spawn($, t, false)
  if (!p) {
    await $.ui.toast(LOFI_MSG.need)
    return
  }
  player = p
  await update($, lofiTrack, () => t.id)
  try { await $.store.set(LAST, t.id) } catch {}
}

// A reload killed whatever the module had running: start from Play, menu closed.
export async function resetLofi($: any) {
  await update($, lofiTrack, () => '')
  await update($, lofiMenu, () => false)
}

// The thumbnail with a LIVE badge, as an SVG (a dark placeholder until it loads).
export const thumbSvg = (data: string | undefined, W = 64, H = 36) => {
  const k = H / 36 // the badge scales with the picture
  const R = Math.round(5 * k)
  const img = data
    ? `<image href="${data}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice" clip-path="url(#tc)"/>`
    : `<rect width="${W}" height="${H}" rx="${R}" fill="#3d3d3a"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<clipPath id="tc"><rect width="${W}" height="${H}" rx="${R}"/></clipPath>
${img}
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="${R - 0.5}" fill="none" stroke="#ffffff" stroke-opacity="0.12"/>
<rect x="${(3 * k).toFixed(1)}" y="${(H - 11 * k).toFixed(1)}" width="${(21 * k).toFixed(1)}" height="${(8 * k).toFixed(1)}" rx="${(2 * k).toFixed(1)}" fill="#e5534b"/>
<text x="${(13.5 * k).toFixed(1)}" y="${(H - 4.8 * k).toFixed(1)}" font-size="${(6 * k).toFixed(1)}" font-weight="700" fill="#ffffff" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif">LIVE</text>
</svg>`
}
