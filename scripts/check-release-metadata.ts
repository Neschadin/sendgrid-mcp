const SERVER_NAME = 'io.github.Neschadin/sendgrid-mcp';
const PACKAGE_NAME = '@neschadin/sendgrid-mcp';
const SEMVER =
  /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

interface PackageMetadata {
  name: string;
  version: string;
  mcpName?: string;
}

interface ServerPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type?: string };
}

interface ServerMetadata {
  name: string;
  version: string;
  packages?: ServerPackage[];
}

function fail(message: string): never {
  throw new Error(message);
}

const pkg = (await Bun.file('package.json').json()) as PackageMetadata;
const server = (await Bun.file('server.json').json()) as ServerMetadata;
const entry = server.packages?.[0];

if (pkg.name !== PACKAGE_NAME) fail(`package.json name: ${pkg.name}`);
if (pkg.mcpName !== SERVER_NAME) fail(`package.json mcpName: ${pkg.mcpName}`);
if (server.name !== SERVER_NAME) fail(`server.json name: ${server.name}`);
if (!entry || entry.registryType !== 'npm') {
  fail(`registryType: ${entry?.registryType}`);
}
if (entry.identifier !== pkg.name) fail(`identifier: ${entry.identifier}`);
if (entry.transport?.type !== 'stdio') {
  fail(`transport: ${entry.transport?.type}`);
}
if (entry.runtimeHint !== 'bunx') fail(`runtimeHint: ${entry.runtimeHint}`);
if (!SEMVER.test(pkg.version)) {
  fail(`package.json version is not semver: ${pkg.version}`);
}
if (server.version !== pkg.version || entry.version !== pkg.version) {
  fail(
    `version drift: package.json ${pkg.version}, server.json ${server.version}/${entry.version}`,
  );
}

const ref = process.env.GITHUB_REF ?? '';
if (ref.startsWith('refs/tags/')) {
  const tag = process.env.GITHUB_REF_NAME ?? '';
  const expected = tag.startsWith('v') ? tag.slice(1) : tag;
  if (!tag.startsWith('v') || !SEMVER.test(expected)) {
    fail(`Tag must be semver (vX.Y.Z): got ${tag}`);
  }
  if (pkg.version !== expected) {
    fail(
      `tag ${tag} does not match package.json/server.json ${pkg.version}`,
    );
  }
}

console.log(`release metadata ok: ${pkg.version}`);
