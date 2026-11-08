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
const VIDEO = 'lofiVideo' // store: show the stream's picture (true unless turned off)
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

async function lookUp($: any, ytdl: string, t: Track, format = 'bestaudio/best') {
  try {
    const r = await $.process.run([ytdl, '-f', format, '-g', watchUrl(t)], { env: { PATH }, timeoutMs: 40_000 })
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
  // the sound of every stream first, then (when the picture is on) its 360p video
  const jobs: { key: string; t: Track; format: string }[] = []
  for (const t of TRACKS) if (!(await cachedUrl($, t.vid, nowMs))) jobs.push({ key: t.vid, t, format: 'bestaudio/best' })
  if (await videoOn($))
    for (const t of TRACKS) if (!(await cachedUrl($, `${t.vid}:v`, nowMs))) jobs.push({ key: `${t.vid}:v`, t, format: 'bv*[height<=360]/b[height<=360]' })
  for (let k = 0; k < jobs.length; k += 4) {
    const batch = jobs.slice(k, k + 4)
    const got = await Promise.all(batch.map(j => lookUp($, ytdl, j.t, j.format)))
    try {
      const all = ((await $.store.get(URLS)) ?? {}) as Record<string, unknown>
      batch.forEach((j, i) => { if (got[i]) all[j.key] = got[i] })
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
  if (video === p) {
    video = null
    return
  }
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
    await stopVideo()
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

// ---- The picture: a small borderless window of the stream's video (no sound;
// the sound player above keeps playing on its own), glued to the bottom-right
// corner of the Claude window, beside the prompt. Claude's interface has no
// place a mod can play video in, so it is a window of mpv's own, on top while
// Claude is the app in front. mpv cannot move a window it has opened, so when
// the Claude window moves or is resized the picture reopens at the new place.
const VW = 224 // the picture, in points (fits between the prompt and the scrollbar)
const VH = 126
const VRIGHT = 20 // from the window's right edge (past the scrollbar)
const VBOTTOM = 42 // from its bottom edge: level with the bottom of the prompt
let video: Proc | null = null
let videoAt = '' // the Claude window's bounds the picture was placed for

// The Claude window (the largest on screen) in its screen's pixels, its
// screen's index and scale, and the app in front.
const WIN_JS = `ObjC.import('CoreGraphics'); ObjC.import('AppKit')
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0))) || []
const front = ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName)
let best = null
for (const w of list) { if (w.kCGWindowOwnerName !== 'Claude' || w.kCGWindowLayer !== 0) continue; const b = w.kCGWindowBounds; if (!best || b.Width * b.Height > best.Width * best.Height) best = b }
const out = { front, win: null }
if (best) {
  const ss = $.NSScreen.screens; const mainH = ss.objectAtIndex(0).frame.size.height
  for (let k = 0; k < ss.count; k++) {
    const sc = ss.objectAtIndex(k); const f = sc.frame; const top = mainH - (f.origin.y + f.size.height)
    const cx = best.X + best.Width / 2, cy = best.Y + best.Height / 2
    if (cx >= f.origin.x && cx < f.origin.x + f.size.width && cy >= top && cy < top + f.size.height) {
      out.win = { x: best.X - f.origin.x, y: best.Y - top, w: best.Width, h: best.Height, screen: k, scale: sc.backingScaleFactor }
      break
    }
  }
}
JSON.stringify(out)`

async function claudeWindow($: any): Promise<{ front: string; win: { x: number; y: number; w: number; h: number; screen: number; scale: number } | null } | null> {
  try {
    const r = await $.process.run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', WIN_JS], { timeoutMs: 5000 })
    return r.exitCode === 0 ? JSON.parse(String(r.stdout).trim()) : null
  } catch {
    return null
  }
}

export async function videoOn($: any) {
  try { return (await $.store.get(VIDEO)) !== false } catch { return true }
}

export async function setVideo($: any, on: boolean) {
  try { await $.store.set(VIDEO, on) } catch {}
  const t = TRACKS.find(x => x.vid === player?.vid)
  if (!on) await stopVideo()
  else if (t && !video) void startVideo($, t)
}

async function stopVideo() {
  const v = video
  video = null
  videoAt = ''
  await kill(v)
}

async function openVideo($: any, t: Track) {
  const at = await claudeWindow($)
  const w = at?.win
  if (!w) return null
  const mpv = await find($, 'mpv')
  const ytdl = await find($, 'yt-dlp')
  if (!mpv || !ytdl) return null
  const nowMs = await $.clock.now()
  const direct = await cachedUrl($, `${t.vid}:v`, nowMs)
  const px = (v: number) => Math.round(v * w.scale)
  const x = w.x + w.w - VW - VRIGHT
  const y = w.y + w.h - VH - VBOTTOM
  const sock = `/tmp/session-meter-lofi-video-${t.vid}-${nowMs}.sock`
  const argv = [
    mpv, '--no-config', '--no-audio', '--no-terminal', '--idle=no',
    '--border=no', `--ontop=${at.front === 'Claude' ? 'yes' : 'no'}`, '--title=lo-fi',
    `--screen=${w.screen}`, '--macos-geometry-calculation=whole', '--force-window-position',
    `--geometry=${px(VW)}x${px(VH)}+${px(x)}+${px(y)}`,
    '--osc=no', '--osd-level=0', '--input-default-bindings=no', '--cursor-autohide=always',
    '--macos-app-activation-policy=accessory',
    '--cache=yes', '--demuxer-max-bytes=32MiB', '--demuxer-readahead-secs=20',
    '--demuxer-lavf-o=live_start_index=-4,http_persistent=0',
    '--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=4',
    `--input-ipc-server=${sock}`,
    ...(direct
      ? ['--ytdl=no', direct]
      : ['--ytdl-format=bv*[height<=360]/b[height<=360]', `--script-opts=ytdl_hook-ytdl_path=${ytdl}`, watchUrl(t)]),
  ]
  const p: Proc = { stream: $.process.spawn({ argv, env: { PATH } }), sock, vid: t.vid, cached: !!direct, t0: nowMs }
  void watch($, p)
  videoAt = `${w.x},${w.y},${w.w},${w.h},${w.screen}`
  return p
}

// Opens the picture and keeps it in place: on top while Claude is in front
// (or the picture itself was clicked), reopened when the Claude window moves.
async function startVideo($: any, t: Track) {
  await stopVideo()
  const p = await openVideo($, t)
  if (!p) return
  video = p
  let onTop: boolean | null = null
  let moved = ''
  while (video && player && video.vid === t.vid) {
    await $.clock.sleep({ ms: 1500 })
    if (!video || !player) break
    const at = await claudeWindow($)
    if (!at) continue
    const top = at.front === 'Claude' || at.front === 'mpv'
    if (top !== onTop && video) {
      onTop = top
      await send($, video, ['set_property', 'ontop', top])
    }
    const w = at.win
    const now = w ? `${w.x},${w.y},${w.w},${w.h},${w.screen}` : ''
    if (now && now !== videoAt) {
      // wait until it stops moving (the same new place twice), then reopen there
      if (now === moved && video) {
        const old = video
        video = null
        await kill(old)
        const again = await openVideo($, t)
        if (!again) return
        video = again
        onTop = null
        moved = ''
      } else moved = now
    }
  }
}

export async function stopLofi($: any) {
  const p = player
  player = null
  await update($, lofiTrack, () => '')
  await kill(p)
  await stopVideo()
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
  if (await videoOn($)) void startVideo($, t)
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
