import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import test from "node:test";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "steward-installer-test-"));
  const source = join(root, "source", "steward");
  const bin = join(root, "bin");
  mkdirSync(join(source, "scripts"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(source, "package-lock.json"), "{}");
  writeFileSync(join(source, "scripts/setup.sh"), '#!/bin/bash\nprintf "%s\\n" "$@" >> "$(dirname "$0")/../calls"\n');
  writeFileSync(join(source, "scripts/update-install.mjs"), readFileSync(resolve("scripts/update-install.mjs")));
  const archive = join(root, "source.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", join(root, "source"), "steward"]);
  writeFileSync(join(bin, "curl"), '#!/bin/bash\nprintf "%s\\n" "$@" >> "$CURL_LOG"\nif [ "${DOWNLOAD_FAIL:-0}" = 1 ]; then exit 22; fi\nresponse="$FIXTURE_ARCHIVE"\nif [[ "$*" == *update-install.mjs* ]]; then response="$UPDATER"; fi\nwhile [ "$1" != "-o" ]; do shift; done\ncp "$response" "$2"\n', { mode: 0o755 });
  writeFileSync(join(bin, "git"), '#!/bin/bash\necho "Git must not be used" >&2\nexit 99\n', { mode: 0o755 });
  const destination = join(root, "Installed Steward");
  const run = (args: string[] = [], overrides: Record<string, string> = {}) => spawnSync("/bin/bash", [resolve("install.sh"), ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, UPDATER: resolve("scripts/update-install.mjs"), FIXTURE_ARCHIVE: archive, CURL_LOG: join(root, "curl.log"), STEWARD_INSTALL_DIR: destination, STEWARD_REF: "test-ref", ...overrides },
    encoding: "utf8", timeout: 10_000,
  });
  return { root, source, archive, destination, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("archive installer needs no Git, forwards options, and preserves an existing installation", () => {
  const f = fixture();
  try {
    let result = f.run(["--example", "file", "--no-open"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.destination, ".steward-install"), "utf8"), "test-ref\n");
    assert.equal(readFileSync(join(f.destination, "calls"), "utf8"), "--example\nfile\n--no-open\n");
    writeFileSync(join(f.destination, "saved-data"), "preserve me");
    result = f.run(["--no-open"]);
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

// An empty override exercises the same fallback as an unset STEWARD_REF.
test("public installer downloads main by default and honors an explicit commit", () => {
  for (const ref of ["", "0123456789abcdef0123456789abcdef01234567"]) {
    const f = fixture();
    try {
      const result = f.run([], { STEWARD_REF: ref });
      assert.equal(result.status, 0, result.stderr);
      const expected = ref || "main";
      assert(readFileSync(join(f.root, "curl.log"), "utf8").split("\n").includes(
        `https://codeload.github.com/bharath2020/steward/tar.gz/${expected}`,
      ));
      assert.equal(readFileSync(join(f.destination, ".steward-install"), "utf8"), `${expected}\n`);
    } finally { f.cleanup(); }
  }
});


test("repeat install replaces source, removes obsolete source, and preserves local data", () => {
  const f = fixture();
  const pack = () => execFileSync("tar", ["-czf", f.archive, "-C", join(f.root, "source"), "steward"]);
  try {
    mkdirSync(join(f.source, "src"));
    writeFileSync(join(f.source, "src/version"), "A");
    writeFileSync(join(f.source, "src/obsolete"), "old");
    writeFileSync(join(f.source, "obsolete-top-level"), "old");
    pack();
    assert.equal(f.run().status, 0);
    mkdirSync(join(f.destination, "runtime/runs/saved"), { recursive: true });
    writeFileSync(join(f.destination, "runtime/temporal.db"), "database");
    writeFileSync(join(f.destination, "runtime/runs/saved/output.json"), "accepted");
    writeFileSync(join(f.destination, ".env"), "local settings");
    writeFileSync(join(f.destination, "personal-file"), "keep");
    writeFileSync(join(f.source, "src/version"), "B");
    rmSync(join(f.source, "src/obsolete"));
    rmSync(join(f.source, "obsolete-top-level"));
    pack();
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.destination, "src/version"), "utf8"), "B");
    assert(!existsSync(join(f.destination, "src/obsolete")));
    assert(!existsSync(join(f.destination, "obsolete-top-level")));
    assert.equal(readFileSync(join(f.destination, "runtime/temporal.db"), "utf8"), "database");
    assert.equal(readFileSync(join(f.destination, "runtime/runs/saved/output.json"), "utf8"), "accepted");
    assert.equal(readFileSync(join(f.destination, ".env"), "utf8"), "local settings");
    assert.equal(readFileSync(join(f.destination, "personal-file"), "utf8"), "keep");
    const backup = readdirSync(f.root).find(name => name.startsWith(".steward-source-backup."))!;
    assert.equal(readFileSync(join(f.root, backup, "src/version"), "utf8"), "A");
    assert(!existsSync(`${f.destination}.installing`));
  } finally { f.cleanup(); }
});

test("failed repeat download leaves installed source and saved data intact", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    const original = readFileSync(join(f.destination, "scripts/setup.sh"), "utf8");
    assert.notEqual(f.run([], { DOWNLOAD_FAIL: "1" }).status, 0);
    assert.equal(readFileSync(join(f.destination, "scripts/setup.sh"), "utf8"), original);
    assert(!existsSync(`${f.destination}.installing`));
  } finally { f.cleanup(); }
});

test("repeat install supports legacy markers and refuses active setup locks", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    rmSync(join(f.destination, ".steward-source-files"));
    assert.equal(f.run().status, 0);
    mkdirSync(join(f.destination, "runtime/services/bootstrap.lock"), { recursive: true });
    assert.notEqual(f.run().status, 0);
    assert(existsSync(join(f.destination, "runtime/services/bootstrap.lock")));
    assert(!existsSync(`${f.destination}.installing`));
  } finally { f.cleanup(); }
});


test("update stops installed services but leaves another workspace's services alone", async () => {
  const f = fixture();
  const children: ReturnType<typeof spawn>[] = [];
  try {
    assert.equal(f.run().status, 0);
    const foreign = join(f.root, "other-workspace");
    mkdirSync(foreign);
    for (const cwd of [f.destination, foreign]) {
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "src/worker.ts"), `const fs = require('fs');
        process.on('SIGTERM', () => { fs.writeFileSync('stopped', 'yes'); process.exit(0); });
        fs.writeFileSync('ready', 'yes'); setInterval(() => {}, 1000);`);
      children.push(spawn(process.execPath, ["src/worker.ts"], { cwd, stdio: "ignore" }));
    }
    const deadline = Date.now() + 5000;
    while (![f.destination, foreign].every(cwd => existsSync(join(cwd, "ready")))) {
      assert(Date.now() < deadline, "fixture workers did not start");
      await new Promise(done => setTimeout(done, 25));
    }
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert(existsSync(join(f.destination, "stopped")), result.stdout);
    assert(!existsSync(join(foreign, "stopped")));
    process.kill(children[1].pid!, 0);
  } finally {
    for (const child of children) child.kill('SIGKILL');
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(done => child.once('exit', () => done()))));
    f.cleanup();
  }
});
