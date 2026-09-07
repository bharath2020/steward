#!/usr/bin/env node
import { cp, mkdir, mkdtemp, rename, rm, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const name = 'steward-workflow';
const source = fileURLToPath(new URL(`../skills/${name}/`, import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const ifMissing = args.includes('--if-missing');
  if (ifMissing) args.splice(args.indexOf('--if-missing'), 1);
  if (args.length !== 0 && (args.length !== 2 || !['--agent', '--dest'].includes(args[0]))) {
    throw new Error('Usage: npm run skill:install -- [--if-missing] [--agent codex|claude | --dest /path/to/skills]');
  }
  const agent = args[0] === '--agent' ? args[1] : 'codex';
  if (!['codex', 'claude'].includes(agent)) throw new Error('Supported agents: codex, claude. Use --dest for other agents.');
  const root = args[0] === '--dest' ? resolve(args[1]) : agent === 'claude'
    ? join(homedir(), '.claude', 'skills')
    : join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills');
  const destination = join(root, name);
  await mkdir(root, { recursive: true });
  // A directory reservation prevents concurrent installs and protects existing skills.
  const reserved = await mkdir(destination).then(() => true).catch((error) => {
    if (error.code === 'EEXIST' && ifMissing) {
      console.log(`Preserving existing skill: ${destination}. To refresh it, move it aside and rerun skill:install.`);
      return false;
    }
    if (error.code === 'EEXIST') throw new Error(`Skill already exists: ${destination}. Choose another --dest or explicitly remove it before reinstalling.`);
    throw error;
  });
  if (!reserved) return;
  let staging;
  try {
    staging = await mkdtemp(join(root, '.steward-skill-'));
    const stagedSkill = join(staging, name);
    await cp(source, stagedSkill, { recursive: true, errorOnExist: true, force: false });
    if (!(await lstat(join(stagedSkill, 'SKILL.md'))).isFile()) throw new Error('Missing SKILL.md');
    await rename(stagedSkill, destination);
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
  console.log(`Installed ${name} to ${destination}`);
  console.log('Use the skill on your next agent turn. Other agents can read SKILL.md directly.');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
