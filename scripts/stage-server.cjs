// Stages the embedded server bundle as a single tarball for electron-builder
// extraResources (which otherwise filters out nested node_modules).
// Produces dist-server.tar.gz containing a top-level "server/" dir with:
//   .next/standalone/* + .next/static + public/ + .env.local
// The Electron main process extracts it into userData on first launch.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.join(__dirname, "..");
const staging = path.join(root, "release", ".staging");
// Keep the artifact outside the installer output dir — electron-builder may
// clean release/ before copying extraResources.
const out = path.join(root, "dist-server.tar.gz");

const posix = (p) => p.replace(/\\/g, "/");
const cp = (from, to) =>
  execSync(`cp -r "${posix(from)}/." "${posix(to)}"`, { stdio: "inherit" });

fs.rmSync(staging, { recursive: true, force: true });
const serverDir = path.join(staging, "server");
fs.mkdirSync(serverDir, { recursive: true });

cp(path.join(root, ".next", "standalone"), serverDir);
fs.mkdirSync(path.join(serverDir, ".next"), { recursive: true });
cp(path.join(root, ".next", "static"), path.join(serverDir, ".next", "static"));
cp(path.join(root, "public"), path.join(serverDir, "public"));

const envLocal = path.join(root, ".env.local");
if (fs.existsSync(envLocal)) fs.copyFileSync(envLocal, path.join(serverDir, ".env.local"));
fs.rmSync(path.join(serverDir, "data"), { recursive: true, force: true });
// Version stamp — main.cjs re-extracts when the app version changes.
fs.writeFileSync(
  path.join(serverDir, ".version"),
  require(path.join(root, "package.json")).version
);

fs.mkdirSync(path.dirname(out), { recursive: true });
execSync(`tar --force-local -czf "${posix(out)}" -C "${posix(staging)}" server`);
fs.rmSync(staging, { recursive: true, force: true });
console.log(`Staged ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
