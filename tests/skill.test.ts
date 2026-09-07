import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadWorkflow } from "../src/definition";

const root = resolve(__dirname, "..");
const assets = join(root, "skills/steward-workflow/assets");
const validate = (...args: string[]) => spawnSync(process.execPath,
  ["--import", "tsx", "scripts/validate-workflow.ts", ...args], { cwd: root, encoding: "utf8" });

test("bundled authoring examples load and validate their initial inputs offline", async () => {
  for (const name of ["review", "fan-out", "loop"]) {
    const definition = await loadWorkflow(join(assets, `${name}.yaml`));
    assert.ok(definition.nodes.length);
    const result = validate(join(assets, `${name}.yaml`), join(assets, `${name}-input.json`));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No run started/);
  }
});

test("offline validation fails for missing inputs and invalid workflow paths", () => {
  const missingInput = validate(join(assets, "review.yaml"), join(assets, "loop-input.json"));
  assert.equal(missingInput.status, 1);
  assert.match(missingInput.stderr, /could not resolve segment proposal/);
  assert.equal(validate(join(assets, "missing.yaml")).status, 1);
});

test("portable installation includes references and examples and refuses an existing skill", async () => {
  const destination = await mkdtemp(join(tmpdir(), "steward-skill-test-"));
  try {
    const install = () => spawnSync(process.execPath,
      [join(root, "scripts/install-skill.mjs"), "--dest", destination], { cwd: tmpdir(), encoding: "utf8" });
    const result = install();
    assert.equal(result.status, 0, result.stderr);
    for (const path of ["SKILL.md", "references/yaml-schema.md", "assets/fan-out.yaml"]) {
      assert.equal(await readFile(join(destination, "steward-workflow", path), "utf8"),
        await readFile(join(root, "skills/steward-workflow", path), "utf8"));
    }
    const second = install();
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already exists/);
    await loadWorkflow(join(destination, "steward-workflow/assets/review.yaml"));
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});

test("standard setup installs the skill and repeat setup preserves a customized copy", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "steward-setup-skill-"));
  try {
    for (const path of ["scripts", "src", "node_modules", "bin"]) await mkdir(join(fixture, path));
    await cp(join(root, "scripts/setup.sh"), join(fixture, "scripts/setup.sh"));
    await cp(join(root, "scripts/install-skill.mjs"), join(fixture, "scripts/install-skill.mjs"));
    await cp(join(root, "skills"), join(fixture, "skills"), { recursive: true });
    await writeFile(join(fixture, "package.json"), JSON.stringify({ scripts: { build: "node -e ''" } }));
    await writeFile(join(fixture, "package-lock.json"), "{}");
    await writeFile(join(fixture, "node_modules/.steward-setup"), createHash("sha256").update("{}").update(process.versions.node.split(".")[0]).digest("hex"));
    await symlink(join(root, "node_modules/tsx"), join(fixture, "node_modules/tsx"));
    await writeFile(join(fixture, "bin/temporal"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(fixture, "src/setup.ts"), "console.log('Fixture setup reached');\n");
    const run = (agent = "codex") => spawnSync("bash", [join(fixture, "scripts/setup.sh")], {
      env: { ...process.env, CODEX_HOME: join(fixture, "codex"), HOME: join(fixture, "home"),
        STEWARD_SKILL_AGENT: agent, PATH: `${join(fixture, "bin")}:${process.env.PATH}` }, encoding: "utf8",
    });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Fixture setup reached/);
    const skill = join(fixture, "codex/skills/steward-workflow/SKILL.md");
    assert.match(await readFile(skill, "utf8"), /name: steward-workflow/);
    await writeFile(skill, "customized skill");
    const repeat = run();
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.match(repeat.stdout, /Preserving existing skill/);
    assert.equal(await readFile(skill, "utf8"), "customized skill");
    assert.equal(run("none").status, 0);
    assert.equal(run("invalid").status, 1);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
