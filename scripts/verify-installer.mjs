import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const command = 'curl -fsSL https://raw.githubusercontent.com/bharath2020/steward/main/install.sh | bash';
const readme = read('README.md');
const section = readme.split('### One-command macOS installation\n')[1]?.split('\n### ')[0];
assert(section, 'README must document the one-command installation');
assert.equal(section.match(/```bash\n([^`]+)```/)?.[1].trim(), command,
  'The public installation command must follow main without a pinned STEWARD_REF');
assert(read('install.sh').includes('${STEWARD_REF:-main}'),
  'Fresh installations must default to main');
console.log('Installer publication contract passed: README and default follow main.');
