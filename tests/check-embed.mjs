#!/usr/bin/env node
// install.mjs ships statusline-limits.mjs and dashboard.mjs as base64 blobs so the
// installer stays a single curl-able file. That means editing either source ships
// nothing until the blob is regenerated — and a stale blob is invisible: the repo
// looks healthy, the tests pass, and `curl | node` installs the old code. This is
// the check for exactly that. Re-embed with the snippet in README "Development".
import { readFileSync } from "node:fs";

const at = (f) => new URL("../" + f, import.meta.url);
const norm = (s) => s.replace(/\r\n/g, "\n"); // sources are LF (.gitattributes); don't let a CRLF checkout cry wolf
const install = readFileSync(at("install.mjs"), "utf8");

let stale = 0;
for (const [name, file] of [
  ["SCRIPT_B64", "statusline-limits.mjs"],
  ["DASHBOARD_B64", "dashboard.mjs"],
]) {
  const m = install.match(new RegExp(`const ${name} =\\r?\\n  "([A-Za-z0-9+/=]+)";`));
  if (!m) {
    console.error(`  MISSING  ${name} is not in install.mjs`);
    stale++;
    continue;
  }
  const embedded = norm(Buffer.from(m[1], "base64").toString("utf8"));
  const source = norm(readFileSync(at(file), "utf8"));
  if (embedded === source) {
    console.log(`  OK       ${name} matches ${file} (${source.length} chars)`);
  } else {
    console.error(`  STALE    ${name} does not match ${file} — re-embed it (README "Development")`);
    stale++;
  }
}
process.exit(stale ? 1 : 0);
