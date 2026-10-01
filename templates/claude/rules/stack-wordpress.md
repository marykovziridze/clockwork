---
# Loads when Claude reads a matching file. Format: https://code.claude.com/docs/en/memory#path-specific-rules
paths:
  - "**/*.php"
  - "**/theme.json"
  - "**/style.css"
  - "**/templates/**/*.html"
  - "**/parts/**/*.html"
  - "**/patterns/**"
  - "**/wp-content/**"
---

# Stack traps: WordPress (block themes, FTPS, REST)

Managed by Clockwork. Each line is a trap that cost a real session time. Add a project's own traps to AGENTS.md or a new rule file, not here.

## Deploying
- Deploy only through one guarded command that: fetches the bytes the server serves now, merges your change into them, checks nothing else moved, uploads the named files only, fetches again and compares byte for byte, and exits non-zero on any mismatch. A check that only prints is not a check. Never upload a whole folder.
- Keep main equal to what is served. When the server holds code that no git copy has, stop: that is the finding, and it becomes its own task.
- No SSH means no WP-CLI. Files go over FTPS; everything else goes through the REST API with an Application Password.
- ProFTPD answering 425 "Operation not permitted" over FTPS is not a rights problem: it wants the data connection to reuse the control connection's TLS session. Use a client setting that does.
- Back up a page's stored content (REST `GET` to a file) before any REST edit.
- A fresh verifier needs a preview of the exact sha: a staging site, deployed by clockwork.json `commands.previewDeploy` (localhost cannot close a task). With none, a task cannot reach `✅ VERIFIED` (overnight it ends FLAGGED).

## Themes and blocks
- A new `patterns/*.php` file does not register until the theme `Version` in `style.css` changes. Bump it in the same deploy.
- Renaming a page does not redirect it, and a `page-<slug>.html` template stops applying. A rename needs an explicit 301, the renamed template file, and every hard-coded internal link repointed.
- Block attributes live inside an HTML comment, where `--` is not allowed. On save WordPress stores `--` as `\u002d\u002d` (and `<` `>` `&` `\"` as `\u003c` `\u003e` `\u0026` `\u0022`; `serialize_block_attributes()` in wp-includes/blocks.php). A generator must write that escaped form, or every run shows a noise diff.
- Generated pages live as source plus a build script; never hand-edit the output.

## Checking
- `?s=` is WordPress search, not a cache-buster: it returns a search page. Bust caches with another parameter, such as `?cb=<timestamp>`.
- Before shipping markup that depends on another session's stylesheet, re-read the served stylesheet; its message about it may be out of date.
- A full-page screenshot of scroll-triggered reveals shows blank sections. Scroll to each section and take viewport shots.

## CSS
- WordPress ships `:root :where(.is-layout-flow) > *` rules; `:where()` counts zero, so a selector that ties with them wins only by load order. Make your rule win on specificity, with no tie.
- Style shared components by class, never `#id`: an id rule cannot reach the next page that needs it.

## Scripts
- In Python, `open(f, "w").write(patch(open(f).read()))` empties the file before it is read. Read into a variable first, then write.
