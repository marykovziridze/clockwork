# Sharing a copy safely

Client names, people and your own paths stay out of the kit. Anything that names them lives in one file on your machine: `~/.claude/clockwork-private.json`, or the file `$CLOCKWORK_PRIVATE` points to.

| Key | What it does |
|---|---|
| `privateTerms` | Refused anywhere in a published file or file name, in any case: client names, company names, domains. |
| `privateWords` | Refused only as a whole word, so a first name does not block "summary". |
| `publishAllow` | Exact strings allowed although they hold a term or word, such as your name on the LICENSE or the repo's own URL. Case-sensitive; the rest of the line is still checked. |
| `publishExclude` | Kit paths left out of a shared copy. `_archive/` is always left out. |
| `live` | Real project paths that the `CLOCKWORK_LIVE=1` tests read. |

## Publishing

```sh
node publish.mjs <git remote>                    # dry run: lists the files and checks them
node publish.mjs <git remote> --apply            # pushes the kit as one new commit
node publish.mjs <git remote> --fresh --apply    # replaces the remote's history with one commit
```

Only committed files go out, so commit first. `publish.mjs` refuses while any published file or file name holds a private term, a private word or your home folder path, and names each file and line. It also refuses when the private file is missing or has no terms, because there would be nothing to check against.

A force push does not erase history on GitHub: replaced commits stay readable by their ID and through the repository's Activity view. To remove old history completely, delete and recreate the repository, then publish with `--fresh`.
