import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type PackageManifest = { version: string };

const root = process.cwd();

async function main(): Promise<void> {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as PackageManifest;
  const latestTag = run(["git", "describe", "--tags", "--abbrev=0"], { allowFailure: true }).trim();
  const range = latestTag ? `${latestTag}..HEAD` : "HEAD";
  const subjects = run(["git", "log", "--pretty=format:%s", range], { allowFailure: true })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const date = new Date().toISOString().slice(0, 10);
  const changes = subjects.length
    ? subjects.map((subject) => `- ${subject}`).join("\n")
    : "- Initial pre-release.";
  const content = `# Changelog\n\nAll notable changes to this project are documented here. Run \`bun run release:changelog\` before tagging a release.\n\n## ${manifest.version} - ${date}\n\n${changes}\n`;
  await writeFile(join(root, "CHANGELOG.md"), content, "utf8");
}

function run(command: string[], options: { allowFailure?: boolean } = {}): string {
  const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    if (options.allowFailure) return "";
    const stderr = Buffer.from(result.stderr).toString("utf8");
    throw new Error(`${command.join(" ")} failed\n${stderr}`);
  }
  return Buffer.from(result.stdout).toString("utf8");
}

await main();
