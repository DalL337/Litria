# Capture: Live / Calm theme variants (node energy levels)

> **Status**: Captured — not scheduled. Design direction.
> **Date**: 2026-06-12
> **Origin**: Emerged accidentally from the [minimap redesign prototype](minimap-prototype.html). The prototype's canvas nodes used a flat colored *left edge* (Edge Assignment channel solo, no LED/glow) as filler; the user reacted to it as a desirable calm look in its own right.
> **Dependencies / anchor**: ADR-014 (Glass Material System) — this is **not a new theme**, it's the existing three-channel contract run at a lower energy level.

---

## Decision

Litria ships **one theme with two energy variants**, selectable:

> **Litria Classic** → **Live** (default) · **Calm**

Not two themes. One design language at two volume levels. The channels are identical; only their intensity changes. This keeps the foundational look as the hero and avoids maintaining a divergent second theme.

### Live (default — the differentiator)

Full ADR-014 three-channel material: **Corner LED + Edge Assignment + Rim Refraction**, with glow on state/focus. This is the signature look that sets Litria apart and **must remain the default** — it is the brand.

### Calm (low-stimulus variant)

Same channels, suppressed: **Edge Assignment carries identity on its own** as a flat colored edge; Corner LED, rim refraction, and glow are dialed to near-zero. Reads as "structure at rest." No motion, no bloom.

**Preferred mental model:** ideally Calm and Live are *not* a hard fork but a **rest → focus escalation of one system** — a node sits flat (Calm-like) at rest and lights up (Live) on focus/state-change. If that escalation model holds, "Calm" is just "escalation disabled / floor only," which is even cheaper to maintain than two presets.

---

## Why Calm matters (intent)

- **Accessibility, standard-backed.** Sensory sensitivity, ADHD, migraine-prone, autistic users. Hooks into `prefers-reduced-motion` (and emerging `prefers-reduced-transparency`) — Calm can **auto-suggest from the OS signal on first launch** rather than hiding in a menu. On-brand for the low-friction UX governance: "Litria respected my system setting without being asked."
- **High-density canvases.** Full glow across many tiles becomes visual noise; Calm scales to dense workspaces.
- **VR endpoint.** A wall of hundreds of glowing tiles in 3D is a sensory firehose. Calm is likely the *default* in the VR workspace, making this variant strategic, not cosmetic.

---

## The left-edge decision

Identity color lives on the **left edge**, not top/bottom or a full border.

- The left edge is a **single anchor aligned with LTR reading order** — the eye starts there, so identity-color sits where attention lands.
- Top + bottom edges split the signal into two competing lines and add visual weight without adding information. One edge says "this is mine" more cleanly than two.
- **RTL caveat:** if Litria ever localizes RTL, the assignment edge mirrors to the right. One-line flip, not a redesign.

---

## Open / later

- Exact suppression levels for Calm (does glow go to *zero* or just low? does the LED stay as a tiny static dot for health, or vanish?).
- Confirm the rest→focus escalation model vs. two static presets — decide which is the real architecture.
- Selector placement (settings vs. a quick toggle) and the `prefers-reduced-motion` auto-adopt behavior.
- RTL edge mirroring (only if/when localization happens).

> Firmly a post-beta concern. Anchored here so it stays tethered to ADR-014 and doesn't get re-litigated as a net-new theme.
