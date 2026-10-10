#!/usr/bin/env node
/**
 * Build the release assets.
 *
 *   dist/acc.zip          application payload (also embedded in the installer)
 *   dist/acc.tar.gz       same tree, for macOS and Linux
 *   dist/acc-setup.exe    single-file Windows installer
 *   dist/SHA256SUMS       checksums for all of the above
 *
 * The payload is produced with `git archive HEAD`, so the tree has to be
 * committed first — that is what makes a release reproducible from a tag.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const installerProject = path.join(root, "installer", "acc-setup");
const payloadDir = path.join(installerProject, "payload");
const payload = path.join(payloadDir, "acc.zip");

const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const allowDirty = process.argv.includes("--allow-dirty");

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
}

function capture(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
}

if (!allowDirty) {
  const dirty = capture("git", ["status", "--porcelain"]);
  if (dirty) {
    console.error(
      "The working tree has uncommitted changes, so the payload would not match a commit.\n" +
        "Commit first, or re-run with --allow-dirty for a local test build."
    );
    process.exit(1);
  }
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.mkdirSync(payloadDir, { recursive: true });

console.log("Building payloads from HEAD…");
// `-o` takes the path as its own argument; `-o=<path>` makes git treat the
// equals sign as part of the filename.
run("git", ["archive", "--prefix=acc/", "--format=zip", "-o", payload, "HEAD"]);
run("git", [
  "archive",
  "--prefix=acc/",
  "--format=tar.gz",
  "-o",
  path.join(dist, "acc.tar.gz"),
  "HEAD",
]);

fs.copyFileSync(payload, path.join(dist, "acc.zip"));
fs.copyFileSync(payload, path.join(dist, `acc-${version}.zip`));

// The release asset must be LF-only: it is meant to be piped straight into sh.
const installScript = fs
  .readFileSync(path.join(root, "install", "install.sh"), "utf8")
  .replace(/\r\n/g, "\n");
fs.writeFileSync(path.join(dist, "install.sh"), installScript);
if (installScript.includes("\r")) {
  console.error("install.sh still contains carriage returns; refusing to publish it.");
  process.exit(1);
}

console.log("Building the Windows installer (dotnet publish)…");
const publishDir = path.join(dist, "publish");
run("dotnet", [
  "publish",
  installerProject,
  "-c",
  "Release",
  "-o",
  publishDir,
  `-p:Version=${version}`,
  "--nologo",
  "-v",
  "quiet",
]);

const built = path.join(publishDir, "acc-setup.exe");
if (!fs.existsSync(built)) {
  console.error(`dotnet publish did not produce ${built}`);
  process.exit(1);
}
fs.copyFileSync(built, path.join(dist, "acc-setup.exe"));
fs.rmSync(publishDir, { recursive: true, force: true });
fs.rmSync(path.join(installerProject, "bin"), { recursive: true, force: true });
fs.rmSync(path.join(installerProject, "obj"), { recursive: true, force: true });

const assets = ["acc-setup.exe", "acc.zip", "acc.tar.gz", `acc-${version}.zip`, "install.sh"];
const lines = assets.map((name) => {
  const hash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(dist, name)))
    .digest("hex");
  return `${hash}  ${name}`;
});
fs.writeFileSync(path.join(dist, "SHA256SUMS"), `${lines.join("\n")}\n`);

console.log("\nAssets in dist/:");
for (const line of lines) console.log(`  ${line}`);

console.log(`
Publish with:

  gh release create v${version} \\
    dist/acc-setup.exe dist/acc.zip dist/acc.tar.gz dist/acc-${version}.zip dist/install.sh dist/SHA256SUMS \\
    --title "ACC v${version}" --notes-file dist/notes.md
`);
