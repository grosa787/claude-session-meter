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
}

declare module 'claude-code' {
  interface PluginState {
    'session-meter': { stats: Shaped<Stats> }
  }
}
