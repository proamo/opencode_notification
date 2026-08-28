import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type PackageManifest = {
  license?: string;
  files?: string[];
  publishConfig?: { access?: string; provenance?: boolean };
};

type PackEntry = {
  filename: string;
  files: Array<{ path: string }>;
};

const root = process.cwd();
const requiredFiles = [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/plugin.js",
  "dist/plugin.d.ts",
  "dist/protocol/index.js",
  "dist/protocol/index.d.ts",
  "dist/broker/main.js",
  "dist/broker/main.d.ts",
];
const forbiddenPrefixes = ["src/", "test/", "scripts/", "openspec/", ".gitnexus/", ".github/"];

async function main(): Promise<void> {
  const licenseOnly = process.argv.includes("--license-only");
  await checkLicenseAndManifest();
  if (licenseOnly) return;

  run([process.execPath, "run", "build"]);
  await checkEntrypoints();
  await checkPackContents();
}

async function checkLicenseAndManifest(): Promise<void> {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as PackageManifest;
  if (manifest.license !== "MIT") throw new Error("package license must be MIT");
  if (manifest.publishConfig?.access !== "public") {
    throw new Error("publishConfig.access must be public");
  }
  if (manifest.publishConfig?.provenance !== true) {
    throw new Error("publishConfig.provenance must be true");
  }
  for (const entry of ["dist", "README.md", "LICENSE"]) {
    if (!manifest.files?.includes(entry)) throw new Error(`package files must include ${entry}`);
  }

  const license = await readFile(join(root, "LICENSE"), "utf8");
  if (!license.includes("MIT License") || !license.includes("Permission is hereby granted")) {
    throw new Error("LICENSE must contain the MIT license text");
  }
}

async function checkEntrypoints(): Promise<void> {
  const plugin = await import(pathToFileURL(join(root, "dist", "plugin.js")).href);
  if (typeof plugin.default !== "function") throw new Error("plugin default export is missing");

  const protocol = await import(pathToFileURL(join(root, "dist", "protocol", "index.js")).href);
  if (protocol.PROTOCOL_VERSION?.major !== 1) throw new Error("protocol major must be 1");

  const help = run([process.execPath, join(root, "dist", "broker", "main.js"), "--help"]);
  if (!help.includes("Usage: opencode-telegram-broker")) {
    throw new Error("broker CLI help smoke test failed");
  }
}

async function checkPackContents(): Promise<void> {
  const destination = await mkdtemp(join(tmpdir(), "opencode-telegram-pack-"));
  try {
    await mkdir(destination, { recursive: true });
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const output = run([
      npmCmd,
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      destination,
    ]);
    const packs = JSON.parse(output) as PackEntry[];
    const pack = packs[0];
    if (!pack?.filename) throw new Error("npm pack did not produce package metadata");

    const files = new Set(pack.files.map((file) => file.path));
    for (const file of requiredFiles) {
      if (!files.has(file)) throw new Error(`packed artifact is missing ${file}`);
    }
    for (const file of files) {
      if (forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) {
        throw new Error(`packed artifact must not include ${file}`);
      }
    }
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
}

function run(command: string[]): string {
  const result = Bun.spawnSync(command, {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });
  const stdout = Buffer.from(result.stdout).toString("utf8");
  const stderr = Buffer.from(result.stderr).toString("utf8");
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed\n${stdout}${stderr}`);
  }
  return stdout;
}

await main();
