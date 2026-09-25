import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validatePublication } from './version.mjs';

// A temporary index builds the release tree without changing the checkout or its branch.
export async function publish({ source, output, version, dryRun = false }) {
  validatePublication(version, dryRun);
  source = await fs.realpath(source);
  output = await fs.realpath(output);
  const git = args => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
  const tag = `v${version}`;
  const ref = `refs/tags/${tag}`;
  if (git(['ls-remote', '--tags', 'origin', ref])) throw new Error(`Tag already exists: ${tag}`);
  const parent = git(['rev-parse', 'HEAD']);
  const gitDir = git(['rev-parse', '--absolute-git-dir']);
  const temp = await fs.mkdtemp(path.join(path.dirname(output), 'release-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temp, 'index'),
    GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'github-actions[bot]', GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com' };
  const run = args => execFileSync('git', [`--git-dir=${gitDir}`, `--work-tree=${output}`, ...args], { env, cwd: output, encoding: 'utf8' }).trim();
  try {
    run(['read-tree', '--empty']);
    run(['add', '--all', '--force', '--', '.']);
    const tree = run(['write-tree']);
    const commit = run(['commit-tree', tree, '-p', parent, '-m', `build ${tag}`]);
    if (!dryRun) {
      // No force: a concurrent or pre-existing release is never overwritten.
      run(['push', 'origin', `${commit}:${ref}`]);
    }
    return { tag, commit, published: !dryRun };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await publish({ source: process.env.SOURCE_DIR, output: process.env.OUTPUT_DIR,
      version: process.env.VERSION, dryRun: process.env.DRY_RUN === 'true' }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
