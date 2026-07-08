# Project Notes

Environment/setup quirks for this repo that aren't covered in [CLAUDE.md](CLAUDE.md). Read this first in a new session.

## Location

The repo lives in `TornadoSurvival/`, one level below `ClaudeProjects/`. Commands (`npm run dev`, etc.) must be run from inside `TornadoSurvival/`, not the parent folder.

## Node/npm on this machine

Node is installed via **nvm** under Git Bash only, at:
```
C:\Users\jesse\.nvm\versions\node\v22.15.0\bin
```

- **Git Bash**: `node`/`npm` work out of the box (this path is on Bash's PATH via nvm init).
- **PowerShell / cmd**: this path has been added to the user-level `PATH` env var. New terminal windows opened after 2026-07-06 pick it up automatically.
- If `npm` is "not recognized" in an **already-open** PowerShell tab, the tab predates the PATH fix — close and reopen the terminal (or `$env:PATH += ";C:\Users\jesse\.nvm\versions\node\v22.15.0\bin"` as a one-off fix in that session).

## Commands

Run from `TornadoSurvival/`:
```bash
npm install
npm run dev              # Vite dev server
npm run build
npm run typecheck
npm run verify:hospital  # static hospital invariants (tsx; no dev server, terminating)
npm run verify:lightning # static lightning/alarm invariants (tsx; no dev server, terminating)
```

Both `verify:*` scripts are `tsx` and terminate on their own. If either errors with
**`tsx` not recognized**, run it directly (same checks; tsx resolves via npx):
`npx tsx scripts/verify-hospital.ts` · `npx tsx scripts/verify-lightning.ts`.

## Vercel Web Analytics

`@vercel/analytics` is installed and `inject()` runs once in [`src/main.ts`](src/main.ts) (framework-agnostic path for this Vite/TS SPA). The script is a **no-op in local dev** and only phones home from the deployed site, so there's nothing to see running `npm run dev`. **Events won't flow until Analytics is enabled for the project in the Vercel dashboard** (project → Analytics tab → Enable) — a one-time manual toggle, unrelated to the code.

## Image assets (the storm sky)

The world is otherwise procedural, but the storm sky background is a real image at `assets/images/` (e.g. `storm_texture_2.png`). It's **imported** in [`src/systems/Atmosphere.ts`](src/systems/Atmosphere.ts) (`import url from "../../assets/images/…png"`), so **Vite** bundles + content-hashes it into `dist/assets/` — it must be committed for the Vercel build to find it. `src/vite-env.d.ts` (`/// <reference types="vite/client" />`) supplies the `*.png` import types so `tsc` doesn't choke. To swap the sky image, drop a new file in `assets/images/` and change the import path (don't use a bare `/assets/...` URL — there's no `public/` dir, so only imported assets are served/bundled).
