# Building with OpenCodra UI

OpenCodra UI is OpenCodra's own React component library (the real components from
`src/client/components/ui`, bundled unchanged). Compose apps from these
components; for your own layout glue, use the **same Tailwind token utilities**
the components use so custom markup matches the design system exactly.

## Setup — no provider needed

There is **no React context/theme provider**. The theme is pure CSS: design
tokens live in `:root` (light) and are overridden under a `.dark` class. So:

- Just render components — `<Button>Save</Button>` works with no wrapper.
- **Dark mode** is class-based, not OS-based. Add `class="dark"` to an ancestor
  (the app puts it on `<html>`) to switch the whole subtree to dark tokens.
  `dark:` utilities follow that class.
- The bound `styles.css` must be loaded (it is, in the design environment); it
  carries the tokens, the compiled utilities, and the two brand fonts
  (IBM Plex Sans / JetBrains Mono, loaded remotely).

## Styling idiom — Tailwind 4 utilities over CSS design tokens

Component **appearance is driven by props, not classes**. Prefer the variant
props; reach for `className` only for spacing/layout:

- `Button` — `variant`: `default` (lime primary), `secondary`, `outline`,
  `ghost`, `link`, `accent`, `destructive`, `destructive-outline`,
  `warning-outline`; `size`: `sm` | `default` | `lg` | `icon`.
- `Badge` — `variant`: `default` | `secondary` | `neutral` | `info` | `success`
  | `warning` | `danger` | `outline`.
- `Alert` — `variant`: `default` (info) | `success` | `warning` | `destructive`.
- `Select` — `variant`: `page` (on gray page bg) | `card` (inside a card).

For **your own layout markup**, style with these token-backed Tailwind
utilities (never hard-coded hex — always go through a token so light/dark and
brand changes flow through):

| Purpose | Utilities |
|---|---|
| Surfaces | `bg-background`, `bg-card`, `bg-secondary`, `bg-muted`, `bg-popover` |
| Text | `text-foreground`, `text-muted-foreground`, `text-primary`, `text-card-foreground` |
| Borders / focus | `border-border`, `border-input`, `ring-ring` |
| Brand accent | `bg-primary` / `text-primary` (OpenCodra's signature lime) |
| Semantic | `text-success` `bg-success-bg` `border-success-border` (and `info` / `warning` / `danger`) |
| Radius / fonts | `rounded-md` `rounded-lg` (via `--radius`), `font-sans`, `font-mono` |

A card container is the `surface` class (`bg-card` + border + radius + soft
shadow) — use `<Card>` rather than re-deriving it.

## Where the truth lives

- Tokens + compiled utilities: the bound `styles.css` → `_ds_bundle.css`
  (search it for `--primary`, `.bg-primary`, `.surface`).
- Each component's API: `components/<group>/<Name>/<Name>.d.ts` and its
  `.prompt.md` usage notes.

## Idiomatic example

```tsx
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Button, Badge } from 'opencodra';

<Card style={{ maxWidth: 380 }}>
  <CardHeader>
    <CardTitle>acme/web-app</CardTitle>
    <CardDescription>Automatic AI review runs on every pull request.</CardDescription>
  </CardHeader>
  <CardContent>
    <div className="flex items-center gap-2">
      <Badge variant="success">Connected</Badge>
      <Badge variant="secondary">main</Badge>
    </div>
  </CardContent>
</Card>
```

The library component carries the control; the `flex items-center gap-2` glue
uses the DS's own token-backed utilities so it sits flush with the components.
