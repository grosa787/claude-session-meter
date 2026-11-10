export type Stats = {
  steps: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  lastAt: number
  ttl: '5m' | '1h'
  usd: number
  now: number
  frame: number
  busy: boolean
  hist: number[]
  effort: string
  ultra: boolean
  limitResetAt: number
  limitPct: number
  limit7ResetAt: number
  limit7Pct: number
  ctxTokens: number
  ctxWindow: number
  ctxLimit: number
  goals: number
  goalAt: number
  fx: { kind: string; at: number } | null
  longTool: boolean
  intent: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-meter': { stats: Shaped<Stats>; lofiTrack: string; lofiMenu: boolean; lofiThumbs: Record<string, string> }
  }
}
