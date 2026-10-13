import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDirectory, "..");
const stagedRoot = join(appRoot, "src-tauri", "resources", "openspec");
const temporaryParent = resolve(tmpdir());
const temporaryRoot = await mkdtemp(
  join(temporaryParent, "ugs-openspec-runtime-"),
);

function isInside(parent, candidate) {
  const value = relative(parent, candidate);
  return (
    value === "" ||
    (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))
  );
}

if (!isInside(temporaryParent, temporaryRoot)) {
  throw new Error(
    `Refusing to use an unsafe OpenSpec smoke-test directory: ${temporaryRoot}`,
  );
}

const runtimeRoot = join(temporaryRoot, "runtime");
const workspaceRoot = join(temporaryRoot, "workspace");
const changeRoot = join(workspaceRoot, "openspec", "changes", "runtime-smoke");

function runOpenSpec(cliPath, args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_PATH: "",
      NO_COLOR: "1",
      OPENSPEC_TELEMETRY: "0",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `OpenSpec ${args.join(" ")} failed with exit code ${result.status}.`,
        result.stdout?.trim(),
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout.trim();
}

function parseJsonOutput(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start)
    throw new Error(`OpenSpec did not return JSON:\n${text}`);
  return JSON.parse(text.slice(start, end + 1));
}

try {
  await cp(stagedRoot, runtimeRoot, { recursive: true, dereference: true });
  await mkdir(workspaceRoot, { recursive: true });
  const cliPath = join(
    runtimeRoot,
    "node_modules",
    "@fission-ai",
    "openspec",
    "bin",
    "openspec.js",
  );
  const runtimeManifest = JSON.parse(
    await readFile(join(runtimeRoot, "runtime-manifest.json"), "utf8"),
  );

  const version = runOpenSpec(cliPath, ["--version"], workspaceRoot);
  if (version !== runtimeManifest.version) {
    throw new Error(
      `Staged OpenSpec version mismatch: expected ${runtimeManifest.version}, got ${version}.`,
    );
  }

  runOpenSpec(
    cliPath,
    ["init", ".", "--tools", "none", "--language", "zh-CN", "--force"],
    workspaceRoot,
  );
  runOpenSpec(
    cliPath,
    [
      "new",
      "change",
      "runtime-smoke",
      "--description",
      "Verify the bundled OpenSpec runtime",
      "--schema",
      "spec-driven",
      "--json",
    ],
    workspaceRoot,
  );

  await mkdir(join(changeRoot, "specs", "runtime-smoke"), { recursive: true });
  await writeFile(
    join(changeRoot, "proposal.md"),
    `## Why\n\nThe desktop package must run OpenSpec without a global OpenSpec installation.\n\n## What Changes\n\n- Verify the packaged CLI and its production dependencies.\n\n## Capabilities\n\n### New Capabilities\n- \`runtime-smoke\`: Confirms that the packaged OpenSpec CLI can load and validate a change.\n`,
  );
  await writeFile(
    join(changeRoot, "design.md"),
    `## Context\n\nThe smoke workspace is isolated from the application repository.\n\n## Goals / Non-Goals\n\n**Goals:**\n- Exercise the staged CLI dependency tree.\n\n**Non-Goals:**\n- Modify application source.\n\n## Decisions\n\nUse a minimal valid change so strict validation traverses all required runtime modules.\n`,
  );
  await writeFile(
    join(changeRoot, "tasks.md"),
    `## 1. Runtime verification\n\n- [x] 1.1 Start the staged CLI\n- [x] 1.2 Run strict validation\n`,
  );
  await writeFile(
    join(changeRoot, "specs", "runtime-smoke", "spec.md"),
    `## ADDED Requirements\n\n### Requirement: Staged runtime starts\nThe desktop package SHALL include the official OpenSpec CLI and all of its production dependencies.\n\n#### Scenario: Strict validation runs\n- **WHEN** the staged CLI validates a complete change\n- **THEN** validation succeeds without resolving packages from the application node_modules directory\n`,
  );

  const status = parseJsonOutput(
    runOpenSpec(
      cliPath,
      ["status", "--change", "runtime-smoke", "--json"],
      workspaceRoot,
    ),
  );
  if (!status.isPlanningComplete) {
    throw new Error(
      `OpenSpec smoke change is incomplete:\n${JSON.stringify(status, null, 2)}`,
    );
  }
  runOpenSpec(
    cliPath,
    [
      "validate",
      "runtime-smoke",
      "--type",
      "change",
      "--strict",
      "--json",
      "--no-interactive",
    ],
    workspaceRoot,
  );

  const listed = parseJsonOutput(
    runOpenSpec(
      cliPath,
      ["list", "--changes", "--sort", "recent", "--json"],
      workspaceRoot,
    ),
  );
  if (!listed.changes?.some((change) => change.name === "runtime-smoke")) {
    throw new Error(
      `OpenSpec list omitted the active smoke change:\n${JSON.stringify(listed, null, 2)}`,
    );
  }

  runOpenSpec(
    cliPath,
    ["archive", "runtime-smoke", "--yes", "--json"],
    workspaceRoot,
  );
  const canonicalSpec = await readFile(
    join(workspaceRoot, "openspec", "specs", "runtime-smoke", "spec.md"),
    "utf8",
  );
  if (!canonicalSpec.includes("Requirement: Staged runtime starts")) {
    throw new Error(
      "OpenSpec archive completed without synchronizing the delta into the canonical spec.",
    );
  }

  runOpenSpec(
    cliPath,
    [
      "new",
      "change",
      "runtime-force-smoke",
      "--description",
      "Verify force archive flags",
      "--schema",
      "spec-driven",
      "--json",
    ],
    workspaceRoot,
  );
  runOpenSpec(
    cliPath,
    [
      "archive",
      "runtime-force-smoke",
      "--yes",
      "--json",
      "--skip-specs",
      "--no-validate",
    ],
    workspaceRoot,
  );
  const remaining = parseJsonOutput(
    runOpenSpec(cliPath, ["list", "--changes", "--json"], workspaceRoot),
  );
  if (
    remaining.changes?.some(
      (change) => change.name === "runtime-force-smoke",
    )
  ) {
    throw new Error(
      `Force-archived change still appears as active:\n${JSON.stringify(remaining, null, 2)}`,
    );
  }

  console.log(
    `Verified relocated OpenSpec ${version}: init, list, change creation, status, strict validation, archive synchronization, and force archive passed.`,
  );
} finally {
  if (isInside(temporaryParent, temporaryRoot)) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
