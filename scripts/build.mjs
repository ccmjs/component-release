import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { minify } from 'terser';
import CleanCSS from 'clean-css';
import { readVersion, validatePublication } from './version.mjs';
export { validateVersion } from './version.mjs';

async function filesIn(root, relative = '') {
  const files = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${file}`);
    if (entry.isDirectory()) files.push(...await filesIn(root, file));
    else if (entry.isFile()) files.push(file);
    else throw new Error(`Unsupported file: ${file}`);
  }
  return files.sort();
}

export async function build({ source, output, repository, main, dryRun = true, framework = false }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? ''))
    throw new Error('Repository must have the form owner/name.');
  source = await fs.realpath(source);
  // Resolve the parent too, so an output path through a symlink cannot overlap the source.
  output = path.join(await fs.realpath(path.dirname(path.resolve(output))), path.basename(output));
  const overlaps = (a, b) => a === b || a.startsWith(b + path.sep);
  if (overlaps(output, source) || overlaps(source, output))
    throw new Error('Output must be outside the source directory.');
  const roots = await fs.readdir(source, { withFileTypes: true });
  const candidates = roots.filter(e => e.isFile() && (framework ? e.name === 'ccm.js' : /^ccm\..+\.mjs$/.test(e.name) && !e.name.endsWith('.min.mjs'))).map(e => e.name);
  if (main) {
    if (path.basename(main) !== main || !/\.(m?js)$/.test(main) || !roots.some(e => e.name === main && e.isFile()))
      throw new Error('Main must name an existing .js or .mjs file in the source root.');
  } else {
    if (candidates.length !== 1) throw new Error(`Expected exactly one main file (ccm.*.mjs or framework ccm.js); found ${candidates.length}. Set main explicitly.`);
    main = candidates[0];
  }
  const content = await fs.readFile(path.join(source, main), 'utf8');
  const version = readVersion(content, { module: main.endsWith('.mjs'), framework: framework || main === 'ccm.js' });
  validatePublication(version, dryRun);
  const files = [main];
  for (const dir of ['resources', 'libs']) {
    const entry = roots.find(e => e.name === dir);
    if (!entry) continue;
    if (!entry.isDirectory()) throw new Error(`${dir} must be a real directory.`);
    files.push(...(await filesIn(path.join(source, dir))).map(f => `${dir}/${f}`));
  }
  for (const entry of roots) {
    if (/^(LICENSE|LICENCE|NOTICE)(\..+)?$/i.test(entry.name) && entry.isFile()) files.push(entry.name);
  }
  // Never clean or overwrite an existing directory.
  await fs.mkdir(output);
  const base = `https://cdn.jsdelivr.net/gh/${repository}@v${version}/`;
  const mainOutput = main.replace(/\.(m?js)$/, `-${version}.min.$1`);
  const outputNames = new Set(files.map(f => f === main ? mainOutput : f));
  for (const file of files) {
    const isJS = file === main || (file.startsWith('resources/') && /\.(m?js)$/.test(file));
    const target = file === main ? mainOutput : file;
    if (isJS && outputNames.has(`${target}.map`)) throw new Error(`Source map output collides with input: ${target}.map`);
    const destination = path.join(output, target);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (isJS) {
      const content = (await fs.readFile(path.join(source, file), 'utf8')).replaceAll('././', base);
      const result = await minify({ [file]: content }, {
        module: file.endsWith('.mjs'), compress: true, mangle: true,
        format: { comments: /@license|@preserve|@version|^!/ },
        sourceMap: { filename: target, root: 'ccmjs:///', includeSources: true, url: base + target + '.map' }
      });
      await fs.writeFile(destination, result.code);
      await fs.writeFile(destination + '.map', result.map);
    } else if (file.startsWith('resources/') && file.endsWith('.css')) {
      const result = new CleanCSS({ rebase: false }).minify(await fs.readFile(path.join(source, file), 'utf8'));
      if (result.errors.length) throw new Error(`CSS errors in ${file}: ${result.errors.join('; ')}`);
      await fs.writeFile(destination, result.styles);
    } else {
      await fs.copyFile(path.join(source, file), destination);
    }
  }
  // Hash the final bytes, including the sourceMappingURL comment. Do not rewrite afterward.
  const integrity = 'sha384-' + createHash('sha384')
    .update(await fs.readFile(path.join(output, mainOutput))).digest('base64');
  const url = base + mainOutput;
  const result = { version, tag: `v${version}`, file: mainOutput, url, integrity };
  if (framework || main === 'ccm.js')
    result.snippet = `<script src="${url}" integrity="${integrity}" crossorigin="anonymous"></script>`;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(['source', 'output', 'repository', 'main'].map(k => [k, { type: 'string' }]).concat([['publish', { type: 'boolean', default: false }], ['framework', { type: 'boolean', default: false }]])) });
    if (!values.source || !values.output) throw new Error('--source and --output are required.');
    const result = await build({ ...values, dryRun: !values.publish });
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) {
      const summary = [
        '## Build prepared: ' + result.tag,
        '',
        'The CDN URL becomes available only after successful publication. A dry run does not publish it.',
        '',
        '**CDN URL:** ' + result.url,
        '',
        '**Subresource Integrity (SHA-384):**',
        '',
        '```text', result.integrity, '```',
        ...(result.snippet ? ['', '**Embed this framework version:**', '', '```html', result.snippet, '```'] : []),
        '',
        'The hash covers the exact generated main file, including its source map comment. Update the URL and hash together when changing versions.',
        '',
      ].join('\n');
      await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    }
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, Object.entries(result).map(([k, v]) => `${k}=${v}\n`).join(''));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
