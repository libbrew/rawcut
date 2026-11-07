#!/usr/bin/env node
// `npx rawcut` — start the local editor and open it in your browser.
process.argv.push('--open');
await import('../server.js');
