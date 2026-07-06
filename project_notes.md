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
npm run dev         # Vite dev server
npm run build
npm run typecheck
```
