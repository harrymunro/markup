# Markup - Project Instructions

Markup is a local tool for drawing feedback on an HTML page, PDF or screenshot and
exporting it as Markdown plus screenshots that an AI coding agent can read. No npm
dependencies: Node.js and Google Chrome only. Work tracking with **beads** (`bd`).

**Before anything else, run `bd prime` and heed its output** (the SessionStart hook
does this in Claude Code).

## Commands

```bash
./markup                      # open the window
./markup path/to/file.html    # open a file (HTML, PDF or image)
./markup --wait file.html     # block until feedback is exported, print feedback.md's path
npm test                      # end-to-end tests in headless Chrome (HTML, PDF, image, responsive)
scripts/build-app.sh          # build Markup.app, the Dock launcher (gitignored; path is baked in)
node scripts/render-icons.js  # rebuild assets/Markup.icns from assets/icon.svg
```

## Architecture

- `server.js` - everything server-side: a loopback HTTP server, the launcher for a
  dedicated Chrome window (own profile under `~/Library/Application Support/html-markup`),
  and the DevTools pipe to it. The pipe is what takes screenshots
  (`Page.captureScreenshot`) and resolves the real path of a picked or dropped file
  (`DOM.getFileInfo`).
- Routing: everything under `/__markup__/` is the app and its API; every other path is
  the document being reviewed, served from its own folder so relative and root-absolute
  assets resolve. HTML is served with a `data-mk-line` attribute on each start tag,
  which is where the `file:line` references in feedback come from.
- `app/app.js` - the UI. The reviewed page sits in a same-origin iframe; marks are drawn
  on an overlay and each is anchored to a DOM element (geometry is stored relative to
  the anchor's top-left), so marks follow scrolling, reflow and viewport changes.
  `housekeeping()` hides marks whose element is covered or gone and re-finds elements
  by selector after a reload.
- `app/pdf.html`, `app/image.html` - viewers for non-HTML documents. They expose
  `window.__mkViewer` (`anchorAt`, `describe`, `idle`) so the same marking code works.
- `vendor/pdfjs/` - pdf.js, vendored so there is no install step.
- `test/` - `driver.js` drives the real app in headless Chrome over the same pipe;
  `smoke.js` and `viewers.js` are the suites.

## Conventions

- No npm dependencies and no build step. Keep it that way unless Harry says otherwise.
- No API reachable from a web page may accept a file path: paths come only from the
  command line (token-authenticated) or from Chrome's own file picker and drops. The
  server answers only to its loopback Host and checks Origin on every POST.
- On Apple Silicon Chrome must be started natively (`nativeLaunch` in `server.js`):
  launched from a script-based .app it otherwise runs under Rosetta and the window
  may never connect.
- Run `npm test` after any change to `server.js` or `app/`. The tests open a real
  (headless) Chrome; a change that only passes by reading the code is not checked.
- Plain hyphens rather than em dashes in notes and docs written from here on; British
  English in prose.

## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
