#!/usr/bin/env node
import { cp, mkdir, mkdtemp, rename, rm, lstat, readFile, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const name = 'steward-workflow';
const source = fileURLToPath(new URL(`../skills/${name}/`, import.meta.url));

// The skill release version is independent of Steward's YAML language version.
async function version(directory, allowLegacy) {
  const path = join(directory, 'skill-version.json');
  const metadata = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!metadata) {
    if (!allowLegacy) throw new Error(`Missing skill version metadata: ${path}`);
    const skillPath = join(directory, 'SKILL.md');
    const stat = await lstat(skillPath).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat?.isFile()) return undefined;
    const text = await readFile(skillPath, 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
    return frontmatter && /^name: *["']?steward-workflow["']? *$/m.test(frontmatter) ? 0 : undefined;
  }
  if (!metadata.isFile()) throw new Error(`Invalid skill version metadata: ${path}`);
  let data;
  try { data = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error(`Invalid skill version metadata: ${path}`); }
  if (!data || data.name !== name || !Number.isSafeInteger(data.version) || data.version < 1 || Object.keys(data).some(key => !['name', 'version'].includes(key))) {
    throw new Error(`Invalid skill version metadata: ${path}`);
  }
  return data.version;
}

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  if (update) args.splice(args.indexOf('--update'), 1);
  const ifMissing = args.includes('--if-missing');
  if (ifMissing) args.splice(args.indexOf('--if-missing'), 1);
  if ((update && ifMissing) || (args.length !== 0 && (args.length !== 2 || !['--agent', '--dest'].includes(args[0])))) {
    throw new Error('Usage: npm run skill:install -- [--if-missing | --update] [--agent codex|claude | --dest /path/to/skills]');
  }
  const agent = args[0] === '--agent' ? args[1] : 'codex';
  if (!['codex', 'claude'].includes(agent)) throw new Error('Supported agents: codex, claude. Use --dest for other agents.');
  const root = args[0] === '--dest' ? resolve(args[1]) : agent === 'claude'
    ? join(homedir(), '.claude', 'skills')
    : join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills');
  const destination = join(root, name);
  await mkdir(root, { recursive: true });
  const lock = join(root, '.steward-workflow-install.lock');
  await mkdir(lock).catch((error) => {
    if (error.code === 'EEXIST') throw new Error(`Another skill installation holds ${lock}. If interrupted, confirm it stopped before removing this lock.`);
    throw error;
  });
  let staging;
  let backup;
  let moved = false;
  try {
    const current = await lstat(destination).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (current && (!current.isDirectory() || current.isSymbolicLink())) throw new Error(`Skill destination must be a real directory: ${destination}`);
    if (current && ifMissing) {
      console.log(`Preserving existing skill: ${destination}. Use --update to upgrade an older version.`);
      return;
    }
    if (current && !update) throw new Error(`Skill already exists: ${destination}. Use --update to upgrade an older version.`);
    const bundled = await version(source, false);
    if (current) {
      const installed = await version(destination, true);
      if (installed === undefined || installed >= bundled) {
        console.log(`Preserving existing skill: ${destination} (${installed === undefined ? 'unrecognized unversioned skill; move it aside to install' : `version ${installed} is current or newer`}).`);
        return;
      }
    }
    staging = await mkdtemp(join(root, '.steward-skill-'));
    const stagedSkill = join(staging, name);
    await cp(source, stagedSkill, { recursive: true, errorOnExist: true, force: false });
    if (!(await lstat(join(stagedSkill, 'SKILL.md'))).isFile()) throw new Error('Missing SKILL.md');
    if (await version(stagedSkill, false) !== bundled) throw new Error('Staged skill version changed');
    if (current) {
      backup = await mkdtemp(join(root, '.steward-workflow-backup-'));
      await rename(destination, join(backup, name));
      moved = true;
    }
    try {
      await rename(stagedSkill, destination);
    } catch (error) {
      if (moved) {
        await rename(join(backup, name), destination);
        moved = false;
      }
      throw error;
    }
    console.log(`${current ? 'Updated' : 'Installed'} ${name} version ${bundled} to ${destination}`);
    if (moved) console.log(`Previous skill backup: ${join(backup, name)}`);
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    if (backup && !moved) await rmdir(backup);
    await rmdir(lock);
  }
  console.log('Use the skill on your next agent turn. Other agents can read SKILL.md directly.');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
