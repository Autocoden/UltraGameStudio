import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const OPENSPEC_PACKAGE = "@fission-ai/openspec";
const OPENSPEC_VERSION = "1.13.0";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDirectory, "..");
const sourceNodeModules = join(appRoot, "node_modules");
const stageRoot = resolve(appRoot, "src-tauri", "resources", "openspec");
const stageNodeModules = join(stageRoot, "node_modules");

function isInside(parent, candidate) {
  const value = relative(parent, candidate);
  return (
    value === "" ||
    (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))
  );
}

if (!isInside(appRoot, stageRoot)) {
  throw new Error(
    `Refusing to stage OpenSpec outside the app directory: ${stageRoot}`,
  );
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readPackage(packageDirectory) {
  const packageJsonPath = join(packageDirectory, "package.json");
  try {
    return JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read ${packageJsonPath}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function packagePath(root, packageName) {
  return join(root, ...packageName.split("/"));
}

async function resolveDependency(fromPackageDirectory, packageName) {
  let cursor = fromPackageDirectory;
  while (isInside(appRoot, cursor)) {
    const candidate = packagePath(join(cursor, "node_modules"), packageName);
    if (await isDirectory(candidate)) return candidate;
    if (cursor === appRoot) break;
    cursor = dirname(cursor);
  }
  return null;
}

const rootPackageDirectory = packagePath(sourceNodeModules, OPENSPEC_PACKAGE);
if (!(await isDirectory(rootPackageDirectory))) {
  throw new Error(
    `Install ${OPENSPEC_PACKAGE}@${OPENSPEC_VERSION} before staging the desktop runtime.`,
  );
}

const rootManifest = await readPackage(rootPackageDirectory);
if (rootManifest.version !== OPENSPEC_VERSION) {
  throw new Error(
    `Expected ${OPENSPEC_PACKAGE}@${OPENSPEC_VERSION}, found ${rootManifest.version || "unknown"}.`,
  );
}

const packages = new Map();
const queue = [{ name: OPENSPEC_PACKAGE, directory: rootPackageDirectory }];

while (queue.length > 0) {
  const current = queue.shift();
  const relativeDirectory = relative(sourceNodeModules, current.directory);
  if (
    !isInside(sourceNodeModules, current.directory) ||
    relativeDirectory.startsWith("..")
  ) {
    throw new Error(
      `Resolved dependency outside node_modules: ${current.directory}`,
    );
  }
  if (packages.has(relativeDirectory)) continue;

  const manifest = await readPackage(current.directory);
  packages.set(relativeDirectory, {
    directory: current.directory,
    name: manifest.name || current.name,
    version: manifest.version || "unknown",
  });

  const dependencies = {
    ...(manifest.dependencies || {}),
    ...(manifest.optionalDependencies || {}),
    ...(manifest.peerDependencies || {}),
  };
  for (const bundled of manifest.bundledDependencies ||
    manifest.bundleDependencies ||
    []) {
    dependencies[bundled] ??= "bundled";
  }

  for (const dependencyName of Object.keys(dependencies).sort()) {
    const dependencyDirectory = await resolveDependency(
      current.directory,
      dependencyName,
    );
    const optional =
      Object.prototype.hasOwnProperty.call(
        manifest.optionalDependencies || {},
        dependencyName,
      ) || manifest.peerDependenciesMeta?.[dependencyName]?.optional === true;
    if (!dependencyDirectory) {
      if (optional) continue;
      throw new Error(
        `Unable to resolve runtime dependency ${dependencyName} required by ${manifest.name || current.name}.`,
      );
    }
    queue.push({ name: dependencyName, directory: dependencyDirectory });
  }
}

await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageNodeModules, { recursive: true });

for (const [relativeDirectory, entry] of [...packages.entries()].sort(
  ([left], [right]) => left.localeCompare(right),
)) {
  const destination = join(stageNodeModules, relativeDirectory);
  await mkdir(dirname(destination), { recursive: true });
  await cp(entry.directory, destination, {
    recursive: true,
    dereference: true,
    filter(source) {
      return (
        source === entry.directory ||
        source.split(/[\\/]/).at(-1) !== "node_modules"
      );
    },
  });
}

const runtimeManifest = {
  package: OPENSPEC_PACKAGE,
  version: OPENSPEC_VERSION,
  generatedAt: new Date().toISOString(),
  packages: [...packages.entries()]
    .map(([path, entry]) => ({
      path: path.replaceAll("\\", "/"),
      name: entry.name,
      version: entry.version,
    }))
    .sort((left, right) => left.path.localeCompare(right.path)),
};
await writeFile(
  join(stageRoot, "runtime-manifest.json"),
  `${JSON.stringify(runtimeManifest, null, 2)}\n`,
);

console.log(
  `Staged ${OPENSPEC_PACKAGE}@${OPENSPEC_VERSION} with ${packages.size - 1} runtime dependencies.`,
);
