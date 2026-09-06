import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import test from "node:test";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "steward-installer-test-"));
  const source = join(root, "source", "steward");
  const bin = join(root, "bin");
  mkdirSync(join(source, "scripts"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(source, "package-lock.json"), "{}");
  writeFileSync(join(source, "scripts/setup.sh"), '#!/bin/bash\nprintf "%s\\n" "$@" >> "$(dirname "$0")/../calls"\n');
  const archive = join(root, "source.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", join(root, "source"), "steward"]);
  writeFileSync(join(bin, "curl"), '#!/bin/bash\nif [ "${DOWNLOAD_FAIL:-0}" = 1 ]; then exit 22; fi\nwhile [ "$1" != "-o" ]; do shift; done\ncp "$FIXTURE_ARCHIVE" "$2"\n', { mode: 0o755 });
  writeFileSync(join(bin, "git"), '#!/bin/bash\necho "Git must not be used" >&2\nexit 99\n', { mode: 0o755 });
  const destination = join(root, "Installed Steward");
  const run = (args: string[] = [], overrides: Record<string, string> = {}) => spawnSync("/bin/bash", [resolve("install.sh"), ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_ARCHIVE: archive, STEWARD_INSTALL_DIR: destination, STEWARD_REF: "test-ref", ...overrides },
    encoding: "utf8", timeout: 10_000,
  });
  return { root, destination, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("archive installer needs no Git, forwards options, and preserves an existing installation", () => {
  const f = fixture();
  try {
    let result = f.run(["--example", "file", "--no-open"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.destination, ".steward-install"), "utf8"), "test-ref\n");
    assert.equal(readFileSync(join(f.destination, "calls"), "utf8"), "--example\nfile\n--no-open\n");
    writeFileSync(join(f.destination, "saved-data"), "preserve me");
    result = f.run(["--no-open"], { DOWNLOAD_FAIL: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.destination, "saved-data"), "utf8"), "preserve me");
    assert(!existsSync(join(f.destination, ".git")));
  } finally { f.cleanup(); }
});

test("archive installer refuses an unrelated destination", () => {
  const f = fixture();
  try {
    mkdirSync(f.destination);
    writeFileSync(join(f.destination, "personal-file"), "keep");
    assert.notEqual(f.run().status, 0);
    assert.equal(readFileSync(join(f.destination, "personal-file"), "utf8"), "keep");
  } finally { f.cleanup(); }
});

test("failed downloads leave no install directory or stale download lock", () => {
  const f = fixture();
  try {
    assert.notEqual(f.run([], { DOWNLOAD_FAIL: "1" }).status, 0);
    assert(!existsSync(f.destination));
    assert(!existsSync(`${f.destination}.installing`));
    assert(!readdirSync(f.root).some(name => name.startsWith(".steward-download.")));
  } finally { f.cleanup(); }
});
