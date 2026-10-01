// Lets `node --test test/` (a bare folder) work: Node resolves the folder to this
// file, which loads every *.test.mjs so their tests run and report here.
// `node --test test/*.test.mjs` still runs the files one process each.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.mjs')).sort();
(async () => { for (const f of files) await import(pathToFileURL(path.join(__dirname, f)).href); })()
  .catch((e) => { console.error(e); process.exitCode = 1; });
