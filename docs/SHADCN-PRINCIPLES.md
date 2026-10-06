# shadcn in the Command Center

How shadcn components inherit the Avel design system without either one bending.

You already made the two hardest calls correctly. `components.json` is committed with `new-york`, `neutral`, CSS variables on, lucide icons — and the brand/shadcn token collision is resolved by renaming shadcn's `accent` to `--color-accent-surface` so the cyan stays the cyan. Everything below builds on that.

Owns: component-layer conventions. Tokens are in `patches/globals-patch.css`. Roster and mounts are in `ROSTER-V2.md`.

---

## The one principle everything follows from

**shadcn is not a dependency. It is a starting point you own.**

The components land in your repo as source. There is no upstream to break you and no version to upgrade past. That is the whole design of the library, and most teams waste it by treating the generated files as untouchable.

So the rule is not "avoid modifying shadcn components." It is:

> Modify them once, deliberately, at the point of generation — and never twice for the same reason.

If you find yourself overriding the same thing at three call sites, the component was wrong and you should have edited it.

---

## 1 · Tokens flow one direction

Brand tokens are the source. shadcn's semantic names are aliases pointing at them. Never the reverse.

```
--color-accent  #0092ca        brand, the source of truth
      ↓
--color-primary                shadcn alias, points at it
--color-ring                   shadcn alias, points at it
```

**The trap you already avoided:** shadcn's `accent` means "subtle hover surface," not "brand accent." If those had shared a name, every ghost button hover would have turned cyan. Renaming it to `--color-accent-surface` is the correct fix and the comment explaining why should stay in the file forever — the next person will otherwise "simplify" it back.

**The one that will bite next:** never write a literal hex in a component. If a component needs a colour the tokens do not have, that is a token change, not a call-site change. Same rule as "never invent a shape the contract does not define."

---

## 2 · Variants live in the component, not the call site

`class-variance-authority` is already a dependency. Use it as the boundary between what a component *is* and how it is *used*.

Variant names stay shadcn's (`default`, `destructive`, `outline`, `secondary`, `ghost`, `link`), per `avel-web/design/AVEL-DESIGN.md` §10: primitives keep shadcn's anatomy and prop names. AVEL changes how each one looks, not what it is called.

```tsx
// components/ui/button.tsx — the variants live here
const buttonVariants = cva(base, {
  variants: {
    variant: {
      default:     "bg-primary text-primary-foreground hover:bg-primary/90",
      secondary:   "bg-secondary text-secondary-foreground hover:bg-state-hover",
      ghost:       "hover:bg-state-hover",
      destructive: "border border-gate-block-line text-gate-block hover:bg-gate-block-soft",
    },
  },
  defaultVariants: { variant: "default" },
})
```

```tsx
// good
<Button variant="destructive">Revoke connection</Button>

// wrong — this is a new variant wearing a className
<Button className="border-gate-block text-gate-block">Revoke</Button>
```

**The senior test:** a `className` prop on a shadcn component should only ever adjust layout — margin, width, grid placement. The moment it changes colour, weight, or state behaviour, you have created an undocumented variant that will drift from its siblings.

Keep `cn()` for layout escape hatches. Audit for anything else.

---

## 3 · Wrap, do not fork

Your product has components shadcn does not: gate rows, blast radius entries, agent chips, the pre-flight panel.

Build them as thin wrappers over shadcn primitives rather than as new base components.

```tsx
// components/gate/gate-row.tsx
export function GateRow({ state, label, source }: GateRowProps) {
  return (
    <div className="grid grid-cols-[14px_1fr_auto_auto] items-center gap-3.5 px-4 py-2">
      <GateGlyph state={state} />
      <span className="text-sm">{label}</span>
      <Badge variant="source">{source}</Badge>
      <GateStatus state={state} />
    </div>
  )
}
```

`Badge` is shadcn's. `GateGlyph` and `GateStatus` are yours because nothing in shadcn expresses them. That split is the right one: the domain layer sits on the primitive layer and never reimplements it.

**Directory shape:**

```
components/
  ui/          shadcn, generated, modified once at generation
  gate/        domain — gate rows, verdicts, glyphs
  blast/       domain — diff rows, path display
  roster/      domain — agent chips, mount display
  layout/      shell, sidebar, window chrome
```

`ui/` is the only folder where a file's origin is shadcn. Everything else is yours.

---

## 4 · Every state in the variant, including the ones you dislike

A shadcn component with a `variant` prop but no `disabled`, `loading`, or `error` treatment is half a component. You will add those at call sites and they will diverge.

**The `<Surface>` rule applies here too.** Loading, empty, error, success — if the compiler does not require all four, they will not all exist.

For interactive components the equivalent set is: rest, hover, active, focus-visible, disabled, and where relevant loading.

**Two that are specific to this product:**

`disabled` must be a real attribute, never styling. Your deliver button is unreachable while a check is unresolved. A component that renders `opacity-40` and stays clickable is the exact failure this product exists to prevent, appearing in the product.

`destructive` is outlined, never filled. A filled red button attracts the click it should discourage.

---

## 5 · Radius through the token, never the utility

shadcn ships `--radius` and derives `rounded-lg`, `rounded-md`, `rounded-sm` from it. You now have a six-step scale.

Map them:

```css
--radius: var(--radius-md);          /* shadcn's base = 10px */
```

Then in components use the semantic name:

```tsx
// good
<div className="rounded-[--radius-md]">

// wrong — an opinion about a specific size, at a call site
<div className="rounded-[10px]">
```

**Why it matters more here than usual:** radius encodes hierarchy in this system. Chips are 4, cards are 10, modals are 18. A hardcoded value at a call site is a hierarchy claim nobody reviewed.

---

## 6 · The dark/light boundary is structural

`.light` sits on the `/app` shell wrapper. Never on `<html>`, never on a component.

**The consequence for shadcn:** every component must resolve its tokens at render, inside the subtree. Which means no component may read a colour into a JS variable and use it later — that value freezes at the theme it was read in.

```tsx
// wrong — freezes at whatever theme was active on mount
const passColor = getComputedStyle(el).getPropertyValue('--color-gate-pass')

// right — resolves per render, per subtree
<span className="text-gate-pass" />
```

This bites hardest in charts and canvas rendering, where reading computed values is the normal pattern. If you add Recharts, this is the first thing that will break.

---

## 7 · `data-testid` is part of the component

Not a call-site responsibility. If a shadcn component is wrapped for domain use, the wrapper supplies the test id.

```tsx
export function GateRow({ state, label, testId }: GateRowProps) {
  return <div data-testid={testId ?? `gate-row-${slug(label)}`}>…</div>
}
```

Your standing rule is that `data-testid` ships in the same commit as the component. Making the wrapper supply it by default means the rule holds even when someone forgets — which is the difference between a convention and a mechanism.

---

## 8 · Icons: lucide only, sized on a scale

`components.json` already pins lucide. Hold that.

Two conventions worth fixing now:

**One size scale.** 14 for inline, 16 for buttons and nav, 20 for headers. Not `size={15}` because it looked better in one place.

**Icons never carry meaning alone.** Every gate state has a glyph *and* a label *and* a colour. An icon-only status is unreadable to a colourblind operator and invisible in a printed receipt.

---

## 9 · Do not install what you will not customise

shadcn's value is that you own the source. That is also its cost — every component you add is code you maintain.

**Install when you need it, not when you might.** A `ui/` folder with forty components and twelve in use is forty components that drift from your tokens.

**For this product, the likely set is small:** button, input, select, dialog, dropdown-menu, tabs, badge, tooltip, separator, scroll-area, skeleton, sonner. Most of the interesting surface area is domain components, not primitives.

---

## 10 · Audit at generation, not later

When you run `shadcn add`, read the file before committing it. Three things to check every time:

1. **Hardcoded values** — spacing, radius, colour that should be a token
2. **Missing states** — no `disabled`, no `focus-visible`
3. **Wrong semantic token** — components sometimes reach for `accent` where your system means `accent-surface`

Fix all three in that commit. A shadcn component committed unread is a component you will debug at 2am and not recognise as yours.

---

## The senior version of all of this

**Own the source, and act like it.** The generated file is a draft. Edit it once, deliberately, and never override the same thing twice at call sites.

**Tokens flow one direction.** Brand is the source, shadcn names are aliases, no literal values in components.

**Variants are the API.** A `className` that changes appearance is an undocumented variant.

**The compiler enforces what memory will not.** Four states, required test ids, exhaustive error codes.

**Wrap, never fork.** Domain components sit on primitives and never reimplement them.

---

## The check worth adding

A lint rule that fails on a hex value, an `rgb()`, or an arbitrary Tailwind value inside `components/`. Roughly ten lines, and it converts the token discipline from a convention into a mechanism — which is the same move as everything else in this system.
