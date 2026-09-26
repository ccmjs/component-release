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
  await write('ccm.hello.mjs', '/** @version 1.2.3 */\nexport const component = { name: "hello", ccm: "././libs/ccm.js", css: "././resources/style.css" };');
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

test('version comes only from the documentation header and is retained in output', async t => {
  const f = await fixture(t);
  const result = await build({ ...f, version: '9.9.9' });
  assert.equal(result.version, '1.2.3');
  assert.match(await fs.readFile(path.join(f.output, result.file), 'utf8'), /@version 1.2.3/);
});

test('missing, duplicate, misplaced and malformed annotations fail', async t => {
  const f = await fixture(t);
  for (const content of [
    'export const component = {};',
    '/** @version 1.2.3 */\n/** @version 1.2.3 */\nexport const component = {};',
    '/** @version v1.2.3 */\nexport const component = {};',
    '/** @version 1.2 */\nexport const component = {};',
    '/** @version */\nexport const component = {};',
    'export const component = {};\n/** @version 1.2.3 */',
    'const text = "/** @version 1.2.3 */"; export const component = {};'
  ]) {
    await f.write('ccm.hello.mjs', content);
    await assert.rejects(build(f), /version|SemVer/);
  }
});

test('development versions build in dry runs but cannot be published', async t => {
  const f = await fixture(t);
  await f.write('ccm.hello.mjs', '/** @version 1.3.0-dev.1 */\nexport const component = {};');
  assert.equal((await build(f)).version, '1.3.0-dev.1');
  await assert.rejects(build({ ...f, output: path.join(f.root, 'publish'), dryRun: false }), /dry run/);
  await assert.rejects(publish({ ...f, version: '1.3.0-dev.1' }), /dry run/);
});

test('framework uses script semantics, checks runtime version and creates .js output', async t => {
  const f = await fixture(t);
  const header = '"use strict";\n/**\n * @version 28.0.0\n */\n';
  await f.write('ccm.js', header + '{ const ccm = { version: "28.0.0" }; window.ccm = ccm; }');
  const result = await build({ ...f, framework: true });
  assert.equal(result.file, 'ccm-28.0.0.min.js');
  const { runInNewContext } = await import('node:vm');
  const window = {};
  runInNewContext(await fs.readFile(path.join(f.output, result.file), 'utf8'), { window });
  assert.equal(window.ccm.version, result.version);
  for (const body of ['const ccm = { version: "27.0.0" };', 'const ccm = { version: getVersion() };', 'const ccm = {};']) {
    await f.write('ccm.js', header + body);
    await assert.rejects(build({ ...f, main: 'ccm.js', output: path.join(f.root, 'invalid') }), /ccm.version/);
  }
});

test('SRI matches the final framework bytes and the CLI reports a copyable embed in Actions', async t => {
  const f = await fixture(t);
  await f.write('ccm.js', '/** @version 28.0.0 */\n{ const ccm = { version: "28.0.0" }; window.ccm = ccm; }');
  const summary = path.join(f.root, 'summary.md');
  const outputs = path.join(f.root, 'outputs.txt');
  await fs.writeFile(summary, 'Existing summary\n');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../scripts/build.mjs', import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, [cli,
    '--source', f.source, '--output', f.output, '--repository', 'ccmjs/framework', '--framework',
  ], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: outputs } }));
  const bytes = await fs.readFile(path.join(f.output, result.file));
  assert.match(bytes.toString(), /sourceMappingURL=/);
  const expected = 'sha384-' + Buffer.from(await crypto.subtle.digest('SHA-384', bytes)).toString('base64');
  assert.equal(result.integrity, expected);
  assert.equal(result.snippet, `<script src="https://cdn.jsdelivr.net/gh/ccmjs/framework@v28.0.0/ccm-28.0.0.min.js" integrity="${expected}" crossorigin="anonymous"></script>`);
  const changed = Buffer.from(await crypto.subtle.digest('SHA-384', Buffer.concat([bytes, Buffer.from('\n')]))).toString('base64');
  assert.notEqual(result.integrity, 'sha384-' + changed);
  const markdown = await fs.readFile(summary, 'utf8');
  assert.ok(markdown.startsWith('Existing summary\n'));
  assert.ok(markdown.includes('```html\n' + result.snippet + '\n```'));
  assert.match(markdown, /dry run does not publish/);
  const output = await fs.readFile(outputs, 'utf8');
  assert.ok(output.includes(`integrity=${expected}\n`));
  assert.ok(output.includes(`snippet=${result.snippet}\n`));
});

test('component builds return their final-byte SRI without a framework embed snippet', async t => {
  const f = await fixture(t);
  const result = await build(f);
  const bytes = await fs.readFile(path.join(f.output, result.file));
  assert.equal(result.integrity, 'sha384-' + Buffer.from(await crypto.subtle.digest('SHA-384', bytes)).toString('base64'));
  assert.equal(result.snippet, undefined);
});
