import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repository = resolve(__dirname, "..");
const skillName = "steward-workflow";
const metadataName = "skill-version.json";
const metadata = (version: number) => JSON.stringify({ name: skillName, version });
const skill = (body: string) => `---\nname: ${skillName}\ndescription: Fixture authoring skill\n---\n${body}\n`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "steward-skill-update-"));
  const app = join(root, "app");
  const source = join(app, "skills", skillName);
  const destinationRoot = join(root, "agent", "skills");
  const installed = join(destinationRoot, skillName);
  await mkdir(join(app, "scripts"), { recursive: true });
  await mkdir(join(source, "references"), { recursive: true });
  await mkdir(destinationRoot, { recursive: true });
  await cp(join(repository, "scripts/install-skill.mjs"), join(app, "scripts/install-skill.mjs"));
  await writeFile(join(source, "SKILL.md"), skill("Bundled current instructions"));
  await writeFile(join(source, metadataName), metadata(2));
  await writeFile(join(source, "references", "schema.md"), "Current schema");
  const run = (...flags: string[]) => spawnSync(process.execPath,
    [join(app, "scripts/install-skill.mjs"), ...flags, "--dest", destinationRoot], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, CODEX_HOME: join(root, "unused-codex"), HOME: join(root, "unused-home") },
    });
  const seed = async (version: number | undefined, body = "Customized old instructions") => {
    await mkdir(join(installed, "custom"), { recursive: true });
    await writeFile(join(installed, "SKILL.md"), skill(body));
    if (version !== undefined) await writeFile(join(installed, metadataName), metadata(version));
    await writeFile(join(installed, "custom", "notes.txt"), "Preserve these user notes");
  };
  return { root, app, source, destinationRoot, installed, run, seed };
}

async function tree(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!path.isFile()) continue;
    const absolute = join(path.parentPath, path.name);
    result[absolute.slice(directory.length + 1)] = (await readFile(absolute)).toString("base64");
  }
  return result;
}

async function backups(root: string) {
  return (await readdir(root)).filter(name => name.includes("backup")).map(name => join(root, name));
}

test("fresh installation includes the bundled version metadata", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await tree(f.installed), await tree(f.source));
});

test("update upgrades an older skill and retains its complete customized copy", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.seed(1);
  const previous = await tree(f.installed);
  const result = f.run("--update");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await tree(f.installed), await tree(f.source));
  const retained = await backups(f.destinationRoot);
  assert.equal(retained.length, 1, "An upgrade must retain one complete backup");
  assert.deepEqual(await tree(join(retained[0], skillName)), previous);
  assert(result.stdout.includes(retained[0]), "The operator must receive the backup path");
});


test("update installs when no prior skill exists", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = f.run("--update");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await tree(f.installed), await tree(f.source));
  assert.equal((await backups(f.destinationRoot)).length, 0);
});

for (const version of [2, 3]) {
  test(`update preserves customized same/newer version ${version} without a backup`, async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
    await f.seed(version);
    const previous = await tree(f.installed);
    const result = f.run("--update");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await tree(f.installed), previous);
    assert.equal((await backups(f.destinationRoot)).length, 0);
    assert.match(result.stdout, /preserv/i);
  });
}

test("recognized unversioned Steward skill upgrades and backs up local customizations", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.seed(undefined, "Customized legacy authoring instructions");
  const previous = await tree(f.installed);
  const result = f.run("--update");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await tree(f.installed), await tree(f.source));
  const retained = await backups(f.destinationRoot);
  assert.equal(retained.length, 1);
  assert.deepEqual(await tree(join(retained[0], skillName)), previous);
});

test("unknown unversioned directory stays untouched", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.seed(undefined);
  await writeFile(join(f.installed, "SKILL.md"), "---\nname: unrelated-skill\n---\nUnrelated instructions\n");
  const previous = await tree(f.installed);
  const result = f.run("--update");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await tree(f.installed), previous);
  assert.equal((await backups(f.destinationRoot)).length, 0);
  assert.match(result.stdout, /preserv|unrecognized|unknown/i);
});

for (const [label, value] of [
  ["invalid JSON", "{"],
  ["string version", JSON.stringify({ name: skillName, version: "1" })],
  ["zero version", metadata(0)],
  ["wrong name", JSON.stringify({ name: "unrelated", version: 1 })],
  ["unsafe version", metadata(Number.MAX_SAFE_INTEGER + 1)],
]) {
  test(`malformed installed metadata (${label}) rejects without changing files`, async t => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
    await f.seed(1);
    await writeFile(join(f.installed, metadataName), value);
    const previous = await tree(f.installed);
    const result = f.run("--update");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /version|metadata/i);
    assert.deepEqual(await tree(f.installed), previous);
    assert.equal((await backups(f.destinationRoot)).length, 0);
  });
}

test("malformed bundled metadata rejects before disturbing the installed skill", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.seed(1);
  await writeFile(join(f.source, metadataName), "not JSON");
  const previous = await tree(f.installed);
  const result = f.run("--update");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /version|metadata/i);
  assert.deepEqual(await tree(f.installed), previous);
  assert.equal((await backups(f.destinationRoot)).length, 0);
});

test("symlink destination rejects without touching the target", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const target = join(f.root, "external-skill");
  await mkdir(target);
  await writeFile(join(target, "SKILL.md"), skill("External skill"));
  await writeFile(join(target, metadataName), metadata(1));
  await symlink(target, f.installed);
  const previous = await tree(target);
  const result = f.run("--update");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /symlink|symbolic|real directory/i);
  assert.deepEqual(await tree(target), previous);
  assert.equal((await backups(f.destinationRoot)).length, 0);
});

test("repeat setup upgrades an older installed skill through the public bootstrap path", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await cp(join(repository, "scripts/setup.sh"), join(f.app, "scripts/setup.sh"));
  for (const path of ["src", "node_modules", "bin"]) await mkdir(join(f.app, path));
  await writeFile(join(f.app, "package.json"), JSON.stringify({ scripts: { build: "node -e ''" } }));
  await writeFile(join(f.app, "package-lock.json"), "{}");
  await writeFile(join(f.app, "node_modules/.steward-setup"), createHash("sha256").update("{}").update(process.versions.node.split(".")[0]).digest("hex"));
  await symlink(join(repository, "node_modules/tsx"), join(f.app, "node_modules/tsx"));
  await writeFile(join(f.app, "bin/temporal"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(f.app, "src/setup.ts"), "console.log('Fixture setup reached');\n");
  const agentHome = join(f.root, "setup-agent");
  const run = () => spawnSync("bash", [join(f.app, "scripts/setup.sh")], {
    env: { ...process.env, CODEX_HOME: agentHome, HOME: join(f.root, "setup-home"), STEWARD_SKILL_AGENT: "codex", PATH: `${join(f.app, "bin")}:${process.env.PATH}` },
    encoding: "utf8", timeout: 20_000,
  });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const installed = join(agentHome, "skills", skillName);
  assert.deepEqual(await tree(installed), await tree(f.source));
  await writeFile(join(installed, metadataName), metadata(1));
  await writeFile(join(installed, "local-notes.txt"), "Preserve setup customization");
  const previous = await tree(installed);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Fixture setup reached/);
  assert.deepEqual(await tree(installed), await tree(f.source));
  const retained = await backups(join(agentHome, "skills"));
  assert.equal(retained.length, 1);
  assert.deepEqual(await tree(join(retained[0], skillName)), previous);
});

test("publication failure restores the old skill and releases the installation lock", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.seed(1);
  const previous = await tree(f.installed);
  const hook = join(f.root, "fail-publish.mjs");
  await writeFile(hook, `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const original = fs.rename;
fs.rename = async (source, destination) => {
  if (String(source).includes(".steward-skill-") && String(destination).endsWith("/steward-workflow")) {
    throw new Error("Injected publication rename failure");
  }
  return original(source, destination);
};
syncBuiltinESMExports();
`);
  const failed = spawnSync(process.execPath, ["--import", hook, join(f.app, "scripts/install-skill.mjs"), "--update", "--dest", f.destinationRoot], {
    cwd: f.root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, CODEX_HOME: join(f.root, "unused-codex"), HOME: join(f.root, "unused-home") },
  });
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /Injected publication rename failure/);
  assert.deepEqual(await tree(f.installed), previous);
  assert.deepEqual(await readdir(f.destinationRoot), [skillName], "Failed publication must leave no lock or staging directories");
  const retry = f.run("--update");
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(await tree(f.installed), await tree(f.source));
});

test("an existing installer lock refuses concurrent mutation and preserves its owner", async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.seed(1);
  const previous = await tree(f.installed);
  const lock = join(f.destinationRoot, ".steward-workflow-install.lock");
  await mkdir(lock);
  await writeFile(join(lock, "owner"), "another active installer");
  const result = f.run("--update");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /lock|installation/i);
  assert.deepEqual(await tree(f.installed), previous);
  assert.equal(await readFile(join(lock, "owner"), "utf8"), "another active installer");
  assert.equal((await backups(f.destinationRoot)).length, 0);
});
