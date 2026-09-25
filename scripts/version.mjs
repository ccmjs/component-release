import { parse } from 'acorn';
import semver from 'semver';

export function validateVersion(version) {
  const parsed = typeof version === 'string' ? semver.parse(version) : null;
  const canonical = parsed && parsed.version + (parsed.build.length ? '+' + parsed.build.join('.') : '');
  if (!parsed || canonical !== version)
    throw new Error('Version must be canonical SemVer without a v prefix (e.g. 1.2.3 or 1.2.3-beta.1).');
  return version;
}

export function validatePublication(version, dryRun) {
  validateVersion(version);
  if (!dryRun && semver.prerelease(version)?.some(part => /^dev/i.test(String(part))))
    throw new Error('Development versions (-dev) may only be built in a dry run.');
}

export function readVersion(content, { module = true, framework = false } = {}) {
  const comments = [];
  const ast = parse(content, { ecmaVersion: 'latest', sourceType: module ? 'module' : 'script', onComment: comments });
  const firstCode = ast.body.find(node => !node.directive)?.start ?? content.length;
  const headers = comments.filter(c => c.type === 'Block' && c.value.startsWith('*') && c.end <= firstCode);
  const annotations = comments.filter(c => c.type === 'Block' && c.value.startsWith('*'))
    .flatMap(c => [...c.value.matchAll(/(?:^|\n)\s*\*?\s*@version\b([^\r\n]*)/g)].map(m => ({ comment: c, value: m[1].trim() })));
  if (annotations.length !== 1 || !headers.includes(annotations[0]?.comment))
    throw new Error('Expected exactly one @version in the leading documentation header.');
  const version = validateVersion(annotations[0].value);
  if (framework) {
    const versions = [];
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'VariableDeclarator' && node.id.name === 'ccm' && node.init?.type === 'ObjectExpression') {
        for (const prop of node.init.properties) {
          if (!prop.computed && (prop.key?.name ?? prop.key?.value) === 'version')
            versions.push(prop.value?.type === 'Literal' ? prop.value.value : undefined);
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
      }
    }
    visit(ast);
    if (versions.length !== 1 || versions[0] !== version)
      throw new Error('Framework ccm.version must be a string literal matching @version.');
  }
  return version;
}
