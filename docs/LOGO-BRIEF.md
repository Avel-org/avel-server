# Avel — Logo & Motion Brief

For Claude Design. Paste the section marked **PROMPT** to start; the rest is reference to paste in as it comes up.

---

## PROMPT — paste this first

> I need a logo system for Avel, an AI development agency. We build custom software for small professional firms and deliver it with proof attached — fixed price, shipped in weeks, no retainers.
>
> **We already have a wordmark: `avel.` — lowercase, with a period.** It is set in Space Grotesk Bold at −0.02em tracking. Do not redesign it. I need a symbol that lives alongside it, and the period is the most distinctive thing we own, so build from that.
>
> Explore three directions:
>
> **1. The seal.** A hallmark — the mark struck into silver to certify purity. Contained, geometric, minimal interior. Reads as *applied after inspection*, not drawn.
>
> **2. The period.** The mark is the dot from the wordmark, made structural. A filled circle that is also an aperture, a bolt head, or a stop. The full stop as a gate.
>
> **3. The gauge.** Two forms in exact relation with a defined gap between them. Measurement, not approximation.
>
> **Palette — use exactly these:**
> - Cyan `#0092CA` — the only chromatic colour, used sparingly
> - Ink `#1A1D23` — dark surface
> - Paper `#EEEEEE` — light surface
> - Mid `#393E46` — if a second neutral is needed
>
> **Constraints:** must read at 16px. Must work in one flat colour on both `#1A1D23` and `#EEEEEE`. Geometrically exact — consistent stroke weight, grid-aligned, defined angle increments. Nothing hand-drawn, no gradients, no glow, no gloss. Flat solid colour only.
>
> **Avoid:** neural nodes, connected dots, circuit traces, swooshes, infinity loops, chat bubbles, sparkles, standalone checkmarks, anything suggesting speed. The product is deliberate slowness at the point where it matters. The mark should be still.
>
> Give me the symbol on its own, plus a horizontal lockup with `avel.` set in Space Grotesk Bold.

---

## Reference

### Voice and audience

Owners and partners at small professional firms — legal, accounting, consulting. People personally liable for their work product, buying custom software for the first or second time. Not impressed by novelty, reassured by precision.

Site voice is short declarative sentences: *"Built with intent." "Scope doesn't drift if the plan is signed off." "You actually own the software when we're done."*

The visual register is a good instrument maker or a technical standards body. Restraint reads as competence to this audience.

### Type

| Role | Face |
|---|---|
| Display / wordmark | Space Grotesk, 700, −0.02em |
| Body | Inter |
| Data, paths, hashes | Geist Mono |
| Emphasis inside headlines | Fraunces italic, 500 |

The Fraunces italic is used for one emphasised word inside a display headline, optically corrected to 0.96em with a 0.04em baseline lift. It is the one soft moment in an otherwise engineered system — worth knowing, probably not worth putting in the mark.

### Why the period matters

`avel.` with a full stop is a finished statement. The company sells finished products, not time. The punctuation is already doing the positioning work, which is why it is the strongest thing to build the symbol from — the symbol becomes an argument the wordmark is already making.

---

## Motion

Animation is where most identity systems overreach. The rules first, then the pieces.

### Rules

**The mark never spins, bounces, or pulses idly.** Rotation implies processing; the product's whole claim is that it *stops* and checks. A logo that spins while you wait is saying the opposite of the brand.

**Motion is a state change, never decoration.** Every animation below marks a transition between two real states. Nothing loops without a reason.

**Durations:** 120ms for micro-interactions, 200ms for state changes, 320ms for entrances. Easing `cubic-bezier(.2,.7,.3,1)` — fast out, settled in. Nothing bouncy; overshoot reads as playful and this brand is not.

**Everything collapses under `prefers-reduced-motion`.** Not shortened — collapsed to the end state.

### The five pieces

**1. Mark draw-on — page load, once**
The symbol assembles from its construction. Strokes draw in along their own paths, or the geometry snaps together from an exploded state. 320ms, then it is still forever. Reads as *struck*, like a stamp landing.

*Ask for: an SVG with `stroke-dasharray` animation, or a two-keyframe snap-together.*

**2. The period — the one signature loop**
If any single element animates continuously, it is the full stop, and it should be nearly imperceptible: opacity drifting between 1 and 0.85 over three seconds, or a 1px scale breath. A cursor blink, not a beacon.

Use once per page. Never next to another animated element.

**3. Verified stamp — the product moment**
When a gate passes, the mark is applied to the artifact: scale from 1.15 to 1.0 with a slight settle, opacity 0 to 1, 200ms. It lands and stops.

This is the most brand-true animation in the system, because it is literally what the company does. Worth building carefully — it belongs on the verification receipt and probably on the landing page too.

**4. Refusal — the counterpart**
A gate blocking should not shake or flash red. A single 60ms horizontal displacement of 2px and back, once, and the state colour changes. Restraint under failure is more convincing than alarm.

**5. Lockup entrance — hero only**
Symbol draws first, wordmark fades in from 6px right, period lands last with a 40ms hold before it. That final beat is the whole identity in one frame: the statement completes.

### What not to animate

- No gradient sweeps or shimmer across the mark
- No particles, trails, or orbiting elements
- No 3D rotation or perspective tilt
- No hover animation on the logo in the site header — it is a link, not a toy
- Nothing that runs while the user is reading

### Deliverables

| # | Asset |
|---|---|
| 1 | Symbol, flat one colour, SVG |
| 2 | Horizontal lockup — symbol + `avel.` |
| 3 | Stacked lockup |
| 4 | App icon, 512px, rounded-square safe area |
| 5 | Favicon, 32px and 16px |
| 6 | On `#1A1D23` and on `#EEEEEE` |
| 7 | Draw-on animation, SVG or Lottie |
| 8 | Verified stamp animation |
| 9 | Clear space and minimum size note |

---

## The test

Show the final mark to someone who does not know the company and ask what kind of business it is.

"AI" or "tech" means it is generic. "Inspection," "certification," "engineering," or "quality" means it is right.
