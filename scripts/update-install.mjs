// Bootstrap lifecycle only: never starts workflows or modifies runtime evidence.
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const preserved = name => ['runtime', 'output', 'tmp', 'node_modules', '.git', '.agents', '.codex', '.claude'].includes(name)
  || (name.startsWith('.env') && name !== '.env.example');
const entryExists = path => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

function ownedProcesses(directory, entrypoint) {
  const rows = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).trim().split('\n');
  return rows.flatMap(row => {
    const match = row.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || !/^(?:\S*\/)?(?:node|temporal)\s/.test(match[2]) || !entrypoint.test(match[2])) return [];
    const pid = Number(match[1]);
    if (pid === process.pid || pid === process.ppid) return [];
    let cwd;
    try {
      cwd = process.platform === 'linux' ? realpathSync(`/proc/${pid}/cwd`)
        : execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
          .split('\n').find(line => line.startsWith('n'))?.slice(1);
    } catch (error) {
      try { process.kill(pid, 0); } catch { return []; }
      throw new Error(`Cannot verify the working directory of service PID ${pid}; stop it before updating.`, { cause: error });
    }
    return cwd === directory ? [pid] : [];
  });
}

async function stopOwned(directory, entrypoint) {
  for (const pid of ownedProcesses(directory, entrypoint)) {
    console.log(`Stopping installed Steward service PID ${pid}…`);
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const deadline = Date.now() + 30_000;
  while (ownedProcesses(directory, entrypoint).length) {
    if (Date.now() > deadline) throw new Error('Services have not stopped. Source was not replaced; stop them before retrying.');
    await new Promise(done => setTimeout(done, 250));
  }
}

export async function updateInstallation(destination, source) {
  if (lstatSync(destination).isSymbolicLink()) throw new Error('Refusing a symlink installation directory.');
  const directory = realpathSync(destination);
  for (const path of ['runtime/services/bootstrap.lock', 'runtime/services/setup.lock']) {
    if (existsSync(join(directory, path))) throw new Error(`Setup lock exists: ${path}. Finish setup before updating.`);
  }
  const incoming = readdirSync(source);
  if (incoming.some(preserved)) throw new Error('Source archive contains a reserved local-data path.');
  const manifest = join(directory, '.steward-source-files');
  const previous = existsSync(manifest) ? readFileSync(manifest, 'utf8').trim().split('\n').filter(Boolean) : [];
  if (previous.some(name => name === '.' || name === '..' || name.includes('/') || name.includes('\\') || preserved(name))) {
    throw new Error('Invalid installed source manifest.');
  }
  // Legacy installs have no manifest. Replacing incoming source directories also
  // removes obsolete files within them; unknown top-level user files stay put.
  const managed = [...new Set([...previous, ...incoming])];
  await stopOwned(directory, /(?:^|\s|\/)src\/(?:cli\/)?launcher\.ts(?:\s|$)/);
  await stopOwned(directory, /(?:^|\s|\/)src\/(?:cli\/)?(?:worker|server)\.ts(?:\s|$)/);
  await stopOwned(directory, /(?:^|\/)temporal\s+server\s+start-dev(?:\s|$)/);
  const backup = mkdtempSync(join(dirname(directory), '.steward-source-backup.'));
  const movedOld = [], movedNew = [];
  try {
    for (const name of managed) {
      if (entryExists(join(directory, name))) {
        renameSync(join(directory, name), join(backup, name));
        movedOld.push(name);
      }
      if (entryExists(join(source, name))) {
        renameSync(join(source, name), join(directory, name));
        movedNew.push(name);
      }
    }
  } catch (error) {
    for (const name of movedNew.reverse()) renameSync(join(directory, name), join(source, name));
    for (const name of movedOld.reverse()) renameSync(join(backup, name), join(directory, name));
    throw error;
  }
  console.log(`Updated Steward source. Previous source retained at ${backup}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await updateInstallation(process.argv[2], process.argv[3]);
}
