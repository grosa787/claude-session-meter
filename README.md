# session-meter

A live strip above the Claude Code prompt that shows what the session costs, how long the prompt cache will live, and how many tokens went where, with a row of small animated pixel Clodies that run while Claude is working.

## What you get

- **Cost and cache countdown.** Session cost in dollars, plus a bar and a clock that drain to zero when the prompt cache expires (1 hour by default; `/meter 5m` switches to the 5-minute cache). The countdown animates inside the picture, so the strip is not redrawn every second.
- **Token statistics.** `IN`, `OUT` and `CACHE` (cache read) for the whole session, abbreviated as K / M / B. Hover the strip for a card with exact numbers, cache-write tokens, cache hit rate and request count.
- **Clodies.** Six pixel Clodies stand in an even row. While Claude answers they run to the right in a line, and when it finishes they slow down smoothly into the row again. Each has its own idle routine, they sleep when the cache has gone cold, and after five idle minutes they pass a wave along the row and shimmer once a minute.
- **A Clodie for the reasoning level.** The sixth one changes with the effort level: a cloud for low, a thought bubble for medium, headphones for high, lightning for xhigh, a crown for max, and an iridescent body when ultracode is on.
- `/meter` opens the same card in a pane. `/meter 1h`, `/meter 5m` and `/meter reset` set the cache lifetime or reset the token counters.

## Install

In a Claude Code session:

```
/plugin install session-meter --marketplace grosa787/claude-session-meter
```

From a shell:

```
claude plugin install session-meter --marketplace grosa787/claude-session-meter
```

Restart open sessions afterwards.

## Notes

- The strip, the Clodies and the hover card are drawn as SVG, so they appear in Claude Code Desktop. On a terminal the mod falls back to a plain text line and hover card without the Clodies.
- The reasoning level is read from your settings and from each request. Max is not stored in settings, so it shows after the first request following the switch, or when `effortLevel` disappears from settings.
- Ultracode is detected from the `ultracode` setting or from the word `ultracode` in a prompt (for that turn only), because Claude Code does not expose the mode to mods otherwise.
- Token counts start from zero each time the mod loads; the cost is read from the session.

## License

MIT
