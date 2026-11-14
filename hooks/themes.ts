// Themes the Play menu offers: a picture behind the conversation and the app's
// colors to match, set with $.theme.set. The picture is a still ground the app
// draws itself (no hook, nothing redrawn, so nothing flickers); it is a frame of
// the scene from the backdrop gallery, in themes/. The pick is kept in the store and
// set again at every session's start. "Standard" clears the theme (the app's own).
import { atom, update } from 'claude-code'
import type { ThemeSetArgs } from 'claude-code'

import { makeColors } from './make-colors.js'
import { PIXEL_THUMB, SAKURA_THUMB } from './scenes/thumbs'

export type Theme = { id: string; name: string; by: string; thumb: string; alt: string; look: ThemeSetArgs }


const pixel = makeColors({
  label: 'Pixel Hill',
  only: 'dark',
  roles: { accent: '#d97757', danger: '#e5534b', success: '#6cc070', warning: '#f2a65a', pro: '#a78bfa' },
  dark: { gray: { anchors: {
    'surface-0': '#141026', 'surface-1': '#1b1631', 'surface-2': '#221c3b', 'surface-3': '#241e3e',
    'text-primary': '#f6efff', 'text-secondary': '#d6cbef', 'text-muted': '#b8acd6',
  } } },
})
const sakura = makeColors({
  label: 'Sakura',
  only: 'dark',
  roles: { accent: '#ff9ccb', danger: '#ef5b6b', success: '#7cc58a', warning: '#f2b45a', pro: '#b69cff' },
  dark: { gray: { anchors: {
    'surface-0': '#1a1018', 'surface-1': '#22151f', 'surface-2': '#2a1b27', 'surface-3': '#2c1d29',
    'text-primary': '#fbeaf2', 'text-secondary': '#e3c9d6', 'text-muted': '#c9a6b8',
  } } },
})

export const THEMES: Theme[] = [
  {
    id: 'pixel-hill', name: 'Pixel Hill', by: 'pixel sunset by a lake', thumb: PIXEL_THUMB,
    alt: 'A pixel-art sunset: the sun sinking behind violet mountains, a lake, a cottage with a glowing window, and small orange creatures running along a meadow path',
    look: { colors: pixel.theme, backdrop: { image: { source: 'themes/pixel.png' } } },
  },
  {
    id: 'sakura', name: 'Sakura', by: 'cherry blossom under the moon', thumb: SAKURA_THUMB,
    alt: 'Blossoming cherry branches in the top corners under a large moon, mist over far hills',
    look: { colors: sakura.theme, backdrop: { image: { source: 'themes/sakura.jpg' } } },
  },
]

// the theme picked ('' for the app's own); the hooks module declares the same atom to read it
const themeId = atom({ plugin: 'session-meter', key: 'themeId' } as const, '')
const PICK = 'theme' // store key

// Sets the theme by id ('' clears it), remembers the pick unless `remember` is false.
export async function applyTheme($: any, id: string, remember = true) {
  const t = THEMES.find(x => x.id === id)
  if (t) await $.theme.set(t.look)
  else await $.theme.clear()
  await update($, themeId, () => (t ? t.id : ''))
  if (remember) {
    try { await $.store.set(PICK, t ? t.id : '') } catch {}
  }
}

// At a session's start: the remembered pick, if any (nothing is cleared when none was made).
export async function restoreTheme($: any) {
  let id = ''
  try { id = String((await $.store.get(PICK)) ?? '') } catch {}
  if (THEMES.some(x => x.id === id)) await applyTheme($, id, false)
  else await update($, themeId, () => '')
}
