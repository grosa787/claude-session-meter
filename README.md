<div align="center">

# session-meter

**See what your Claude Code session costs, when the prompt cache dies, and where your tokens go.**
A live strip above the prompt, a hover card with the details, and six little pixel Clodies that run while Claude works.

![License: MIT](https://img.shields.io/badge/license-MIT-d97757)
![Claude Code mod](https://img.shields.io/badge/Claude%20Code-mod-d97757)
![Surface: Desktop](https://img.shields.io/badge/surface-Desktop-4b4a46)

<img src="docs/strip.png" alt="The session-meter strip above the Claude Code prompt" width="900">

</div>

---

## Features

### The strip

| Segment | What it shows |
| --- | --- |
| `IN` | All input tokens for the session, as the API counts them: new + cache read + cache write |
| `OUT` | Output tokens |
| `CACHE` | Tokens read from the prompt cache |
| `$` | What the session has cost so far |
| bar + clock | The prompt cache draining to zero — 1 hour by default, `/meter 5m` for the 5‑minute cache |
| `CTX` | Context used, as `used/limit` in thousands of tokens, e.g. `123/600k`. The limit follows your `/autocompact` setting for the current model and falls back to the model's whole window (e.g. `1000k`) when none is set; it updates as soon as you change it. Marker green → yellow → red |
| `5H` / `7D` | Time until your 5‑hour and 7‑day usage limits reset (`3:26` / `3d03h`). When both are known, one readout turns like a wheel: 5H stays for 2:30, then 7D for 30 s, and back; the whole plate scrolls down as one and the next face arrives from above. The marker beside it runs smoothly from green through yellow to red as that limit fills. Shown only when your account reports the limit |

Numbers are abbreviated as **K / M / B**. Every segment has a fixed width, so nothing jumps when the numbers change.
The countdown runs *inside* the picture, so the strip is never redrawn on a timer.

### Hover for the full picture

Hover the strip and a card opens above it with exact counts, cache‑write tokens, cache hit rate, the number of requests and how much of the 5‑hour and 7‑day limits is used. `/meter` shows the same card in a pane.

<div align="center">
<img src="docs/card.png" alt="The hover card" width="320">
</div>

### Clodies

Seven pixel Clodies live on the left of the strip, in an evenly spaced row.

- **Working** – they run to the right in a line, one after another, and re‑enter from the left.
- **Done** – they keep walking, slowing down smoothly, and settle into an even row.
- **Standing** – each has its own routine: a double jump, waving in turns, swaying, stretching, a turn‑around with a little heart.
- **Cache gone cold** – they fall asleep.
- **The footballer** – the seventh Clodie wears a blue kit. He dribbles a ball while the others run, and when standing he kicks it out to a neighbour and lets it roll back.
- **They react to what happens:**
  - a tool fails → they droop, a tear falls;
  - tests pass, or a round sum ($10, $20 …) is spent → they hop, cheer and throw confetti;
  - a tool call runs long (8 s+) → one of them opens an umbrella;
  - your prompt says *find / search / grep* → one gets a magnifier; *fix / bug* → one gets a hammer (until the answer ends);
  - the footballer scores a goal after every successful answer, and keeps the score (`×N` above him).
- **Time of day** – nightcaps (and a moon) from 22:00 to 06:00, coffee mugs in the morning, party hats on Friday evening.
- **Five idle minutes** – they pass a wave along the row, and shimmer in turn once a minute.

### The sixth Clodie shows your reasoning level

<div align="center">
<img src="docs/levels.png" alt="Reasoning level Clodies: low, medium, high, xhigh, max, ultracode" width="720">
</div>

---

## Install

In a Claude Code session:

```
/plugin install session-meter --marketplace grosa787/claude-session-meter
```

or from a shell:

```
claude plugin install session-meter --marketplace grosa787/claude-session-meter
```

Open sessions need a restart to pick it up.

## Commands

| Command | Does |
| --- | --- |
| `/meter` | Opens the stats card in a pane |
| `/meter 1h` / `/meter 5m` | Sets the cache lifetime used for the countdown |
| `/meter reset` | Resets the token counters |

## Good to know

- The strip, the Clodies and the card are SVG, so they appear in **Claude Code Desktop**. On a terminal the mod falls back to a plain text line and hover card, without the Clodies.
- **Reasoning level** is read from your settings and from each request. Max is not stored in settings, so it shows once `effortLevel` disappears from them or after the first request following the switch.
- **Ultracode** is detected from the `ultracode` setting, or from the word `ultracode` in a prompt (for that turn). Claude Code does not expose the mode to mods in any other way.
- The *find* / *fix* reactions also recognise a few Russian words (найди, поиск, почини, баг).
- Token counters start from zero whenever the mod loads; the cost is read from the session itself.

## How it works

The mod is a single hooks module (`hooks/register.tsx`). It listens to model responses for token usage and to session measurements for cost, keeps them in the mod's state, and draws the strip into the band above the prompt. All animation is SVG/SMIL, so the only redraws happen when something actually changes.

## License

MIT © grosa787
