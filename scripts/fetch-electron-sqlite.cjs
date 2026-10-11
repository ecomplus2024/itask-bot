// Replaces the better-sqlite3 native binary inside .next/standalone with the
// prebuilt Electron ABI build, so the packaged app can run the embedded
// server under Electron's embedded Node (ELECTRON_RUN_AS_NODE).
//
// Usage: node scripts/fetch-electron-sqlite.cjs   (runs automatically in `npm run dist`)
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

const root = path.join(__dirname, "..");
const sqliteDir = path.join(
  root,
  ".next",
  "standalone",
  "node_modules",
  "better-sqlite3"
);
const releaseDir = path.join(sqliteDir, "build", "Release");

if (!fs.existsSync(sqliteDir)) {
  console.error("better-sqlite3 not found in .next/standalone — run next build first");
  process.exit(1);
}

// Ask Electron itself which ABI its embedded Node uses (avoids stale
// node-abi tables when Electron ships newer than the lookup).
const electronBin = require("electron");
const abi = execSync(`"${electronBin}" -p "process.versions.modules"`, {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
})
  .toString()
  .trim();

const version = require(path.join(sqliteDir, "package.json")).version;
const platform = process.platform; // win32 | darwin | linux
const arch = process.arch; // x64 | arm64
const asset = `better-sqlite3-v${version}-electron-v${abi}-${platform}-${arch}.tar.gz`;
const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${asset}`;

console.log(`Fetching ${asset} (Electron ABI ${abi})...`);

function download(u, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(u, { headers: { "User-Agent": "itask-build" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (!redirects) return reject(new Error("too many redirects"));
          return resolve(download(res.headers.location, dest, redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        res.pipe(fs.createWriteStream(dest)).on("finish", resolve).on("error", reject);
      })
      .on("error", reject);
  });
}

(async () => {
  const tmp = path.join(require("os").tmpdir(), asset);
  await download(url, tmp);
  // bsdtar on Windows parses "C:" in the archive path as a remote host and
  // chokes on backslashes in -C — pass POSIX-style paths.
  const posix = (p) => p.replace(/\\/g, "/");
  // Patch every copy: node_modules/better-sqlite3 AND the nft-traced
  // .next/node_modules/better-sqlite3-<hash> duplicates.
  const extract = fs.mkdtempSync(path.join(require("os").tmpdir(), "bsq-"));
  execSync(`tar --force-local -xzf "${posix(tmp)}" -C "${posix(extract)}"`);
  const binary = path.join(extract, "build", "Release", "better_sqlite3.node");
  const standalone = path.join(root, ".next", "standalone");
  const findTargets = (dir) => {
    const hits = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        hits.push(
          ...(e.name === "better_sqlite3.node" ? [] : findTargets(p))
        );
      } else if (e.name === "better_sqlite3.node") {
        hits.push(p);
      }
    }
    return hits;
  };
  const targets = findTargets(standalone);
  for (const t of targets) fs.copyFileSync(binary, t);
  fs.rmSync(extract, { recursive: true, force: true });
  fs.rmSync(tmp, { force: true });
  console.log(`OK → patched ${targets.length} better_sqlite3.node file(s)`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
