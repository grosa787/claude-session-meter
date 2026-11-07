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
export const TRACKS: Track[] = [
  { id: 'lofigirl', name: 'lofi hip hop radio', by: 'Lofi Girl', vid: 'rFZHOHl-L8A' },
  { id: 'claude', name: 'Claude FM', by: 'Claude', vid: 'tRsQsTMvPNg' },
]
const watchUrl = (t: Track) => `https://www.youtube.com/watch?v=${t.vid}`

// what plays now ('' for nothing), whether the menu is open, the thumbnails (data URIs);
// the hooks module declares the same atoms to read them
const lofiTrack = atom({ plugin: 'session-meter', key: 'lofiTrack' } as const, '')
const lofiMenu = atom({ plugin: 'session-meter', key: 'lofiMenu' } as const, false)
const lofiThumbs = atom({ plugin: 'session-meter', key: 'lofiThumbs' } as const, {} as Record<string, string>)

// toasts, in the strip's language (set by the hooks module)
export const LOFI_MSG = { need: 'Lo-fi needs mpv and yt-dlp: brew install mpv yt-dlp', fail: 'Lo-fi did not start: the stream is unavailable' }

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

// Looks up the streams' direct addresses and the thumbnails that are missing or
// old. Run in the background at the session's start; quiet when offline.
export async function prefetchLofi($: any) {
  const ytdl = await find($, 'yt-dlp')
  const nowMs = await $.clock.now()
  if (ytdl) {
    for (const t of TRACKS) {
      if (await cachedUrl($, t.vid, nowMs)) continue
      try {
        const r = await $.process.run([ytdl, '-f', 'bestaudio/best', '-g', watchUrl(t)], { env: { PATH }, timeoutMs: 40_000 })
        const url = String(r.stdout).trim().split('\n')[0] ?? ''
        const exp = Number(url.match(/expire\/(\d+)/)?.[1] ?? 0)
        if (r.exitCode === 0 && url && exp) {
          const all = ((await $.store.get(URLS)) ?? {}) as Record<string, unknown>
          all[t.vid] = { url, exp }
          await $.store.set(URLS, all)
        }
      } catch {}
    }
  }
  let stored: Record<string, { data: string; at: number }> = {}
  try {
    stored = ((await $.store.get(THUMBS)) ?? {}) as typeof stored
  } catch {}
  let changed = false
  for (const t of TRACKS) {
    if (stored[t.vid] && nowMs - stored[t.vid]!.at < DAY) continue
    try {
      // a small JPEG (160x90), as base64
      const sh = `f=$(mktemp -t smthumb).jpg; curl -sfL -m 15 -o "$f" "https://i.ytimg.com/vi/${t.vid}/mqdefault.jpg" && sips -Z 160 -s formatOptions 75 "$f" >/dev/null 2>&1; base64 < "$f"; rm -f "$f"`
      const r = await $.process.run(['/bin/sh', '-c', sh], { env: { PATH }, timeoutMs: 30_000 })
      const b64 = String(r.stdout).replace(/\s+/g, '')
      if (r.exitCode === 0 && b64.length > 500) {
        stored[t.vid] = { data: `data:image/jpeg;base64,${b64}`, at: nowMs }
        changed = true
      }
    } catch {}
  }
  if (changed) {
    try { await $.store.set(THUMBS, stored) } catch {}
  }
  const thumbs: Record<string, string> = {}
  for (const t of TRACKS) if (stored[t.vid]) thumbs[t.vid] = stored[t.vid]!.data
  await update($, lofiThumbs, () => thumbs)
}

// Starts mpv for a track, paused (warm) or playing.
async function spawn($: any, t: Track, paused: boolean): Promise<Proc | null> {
  const mpv = await find($, 'mpv')
  const ytdl = await find($, 'yt-dlp')
  if (!mpv || !ytdl) return null
  const nowMs = await $.clock.now()
  const direct = await cachedUrl($, t.vid, nowMs)
  const sock = `/tmp/session-meter-lofi-${t.vid}-${nowMs}.sock`
  const argv = [
    mpv, '--no-config', '--no-video', '--no-terminal', '--force-window=no', '--idle=no',
    '--cache=yes', '--demuxer-max-bytes=4MiB', '--demuxer-lavf-o=live_start_index=-1',
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

// Unpauses a warm player through its socket (it may not exist for the first
// instants after the start: tried for up to 3 s).
async function unpause($: any, p: Proc) {
  for (let i = 0; i < 15; i++) {
    try {
      const r = await $.process.run(['/usr/bin/nc', '-U', p.sock], {
        stdin: '{"command":["set_property","pause",false]}\n',
        timeoutMs: 2000,
      })
      if (r.exitCode === 0 && String(r.stdout).includes('success')) return true
    } catch {}
    await $.clock.sleep({ ms: 200 })
  }
  return false
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
  for (const t of TRACKS) {
    if (warm[t.vid]) continue
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
