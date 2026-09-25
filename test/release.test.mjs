import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build, validateVersion } from '../scripts/build.mjs';
import { publish } from '../scripts/publish.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'component-release-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  const write = async (name, text) => { await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true }); await fs.writeFile(path.join(source, name), text); };
  await write('ccm.hello.mjs', 'export const component = { name: "hello", ccm: "././libs/ccm.js", css: "././resources/style.css" };');
  return { root, source, write, output: path.join(root, 'dist'), version: '1.2.3', repository: 'ccmjs/hello' };
}

test('validates canonical versions and rejects shell syntax', () => {
  for (const version of ['1.2.3', '0.0.0', '1.2.3-rc.1', '1.2.3+build.1']) assert.equal(validateVersion(version), version);
  for (const version of ['', 'v1.2.3', '01.2.3', '1.2', '1.2.3;echo bad', '1.2.3\n', undefined]) assert.throws(() => validateVersion(version));
});

test('build preserves resource URLs, modules, binary assets, licenses and source checkout', async t => {
  const f = await fixture(t);
  await f.write('dummy.mjs', 'not valid JavaScript');
  await f.write('resources/nested/helper.mjs', 'export const message = "hello";');
  await f.write('resources/script.js', 'function greet() { return "Hello"; }');
  await f.write('resources/style.css', 'body { color: red; background: url("./image.png"); }');
  await f.write('resources/image.png', Buffer.from([0, 255, 128, 42]));
  await f.write('libs/ccm.js', '// keep library\nwindow.ccm = {};');
  await f.write('LICENSE', 'MIT fixture license');
  await f.write('README.md', 'not part of build');
  const result = await build(f);
  assert.equal(result.file, 'ccm.hello-1.2.3.min.mjs');
  const code = await fs.readFile(path.join(f.output, result.file), 'utf8');
  assert.match(code, /@v1\.2\.3\/libs\/ccm\.js/);
  assert.match(code, /@v1\.2\.3\/resources\/style\.css/);
  const module = await import(path.join(f.output, result.file));
  assert.equal(module.component.name, 'hello');
  const map = JSON.parse(await fs.readFile(path.join(f.output, result.file + '.map')));
  assert.equal(map.file, result.file);
  assert.deepEqual(map.sources, ['ccm.hello.mjs']);
  assert.match(map.sourcesContent[0], /cdn.jsdelivr.net/);
  assert.equal((await import(path.join(f.output, 'resources/nested/helper.mjs'))).message, 'hello');
  assert.match(await fs.readFile(path.join(f.output, 'resources/style.css'), 'utf8'), /url\((?:"|')?\.\/image\.png/);
  for (const file of ['resources/image.png', 'libs/ccm.js', 'LICENSE']) assert.deepEqual(await fs.readFile(path.join(f.output, file)), await fs.readFile(path.join(f.source, file)));
  assert.match(await fs.readFile(path.join(f.source, 'ccm.hello.mjs'), 'utf8'), /\.\/\.\//);
  await assert.rejects(fs.access(path.join(f.output, 'README.md')));
});

test('main selection is explicit when ambiguous', async t => {
  const f = await fixture(t);
  await f.write('ccm.other.mjs', 'export const component = {};');
  await assert.rejects(build(f), /exactly one/);
  await build({ ...f, main: 'ccm.hello.mjs' });
});

test('rejects unsafe paths, pre-existing output and symlinks', async t => {
  const f = await fixture(t);
  await assert.rejects(build({ ...f, output: f.source }), /outside/);
  await assert.rejects(build({ ...f, output: path.join(f.source, 'dist') }), /outside/);
  await assert.rejects(build({ ...f, main: '../escape.mjs' }), /Main/);
  await assert.rejects(build({ ...f, repository: 'bad repo' }), /Repository/);
  await fs.mkdir(f.output);
  await fs.writeFile(path.join(f.output, 'keep'), 'keep');
  await assert.rejects(build(f), /EEXIST/);
  assert.equal(await fs.readFile(path.join(f.output, 'keep'), 'utf8'), 'keep');
  await fs.symlink(f.source, path.join(f.source, 'resources'));
  await assert.rejects(build({ ...f, output: path.join(f.root, 'other') }), /real directory/);
});

test('source-map collisions fail rather than overwrite an input', async t => {
  const f = await fixture(t);
  await f.write('resources/helper.js', 'const x = 1;');
  await f.write('resources/helper.js.map', '{}');
  await assert.rejects(build(f), /collides/);
});

test('dry run and publication keep main and working tree unchanged; duplicate tags fail', async t => {
  const f = await fixture(t);
  const git = args => execFileSync('git', ['-C', f.source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const remote = path.join(f.root, 'remote.git');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.com']);
  git(['add', '.']); git(['commit', '-m', 'Source']);
  git(['remote', 'add', 'origin', remote]); git(['push', 'origin', 'main']);
  const head = git(['rev-parse', 'HEAD']);
  const remoteMain = git(['ls-remote', 'origin', 'refs/heads/main']);
  await build(f);
  assert.equal((await publish({ ...f, dryRun: true })).published, false);
  assert.equal(git(['ls-remote', '--tags', 'origin']), '');
  const result = await publish(f);
  assert.equal(result.published, true);
  assert.match(git(['ls-remote', '--tags', 'origin']), /refs\/tags\/v1.2.3/);
  assert.equal(git(['rev-parse', 'HEAD']), head);
  assert.equal(git(['ls-remote', 'origin', 'refs/heads/main']), remoteMain);
  assert.equal(git(['status', '--porcelain']), '');
  assert.equal(git(['rev-parse', `${result.commit}^`]), head);
  assert.match(git(['ls-tree', '--name-only', result.commit]), /ccm.hello-1.2.3.min.mjs/);
  await assert.rejects(publish(f), /Tag already exists/);
});
