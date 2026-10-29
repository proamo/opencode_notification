import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_NAME = "opencode-telegram-link";
const ENTRY_SOURCE = 'export { default } from "./extension.js";\n';

export function omoAgentDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return (
    environment.OMO_CODING_AGENT_DIR ??
    environment.SENPI_CODING_AGENT_DIR ??
    join(homedir(), ".omo", "agent")
  );
}

export function omoExtensionDirectory(agentDirectory = omoAgentDirectory()): string {
  return join(agentDirectory, "extensions", EXTENSION_NAME);
}

export function bundledOmoExtensionPath(): string | undefined {
  const candidates = ["../omo/extension.js", "../../dist/omo/extension.js"].map((relative) =>
    fileURLToPath(new URL(relative, import.meta.url)),
  );
  return candidates.find((candidate) => existsSync(candidate));
}

export async function installOmoExtension(input: {
  agentDirectory?: string;
  bundlePath?: string;
}): Promise<{ directory: string }> {
  const bundlePath = input.bundlePath ?? bundledOmoExtensionPath();
  if (!bundlePath) throw new Error("bundled OMO extension was not found; run the package build");
  const directory = omoExtensionDirectory(input.agentDirectory);
  await mkdir(directory, { recursive: true });
  await copyFile(bundlePath, join(directory, "extension.js"));
  await writeFile(join(directory, "index.ts"), ENTRY_SOURCE, "utf8");
  return { directory };
}

export async function removeOmoExtension(
  agentDirectory = omoAgentDirectory(),
): Promise<"removed" | "absent" | "foreign"> {
  const directory = omoExtensionDirectory(agentDirectory);
  const entry = await readFile(join(directory, "index.ts"), "utf8").catch(() => undefined);
  if (entry === undefined) return existsSync(directory) ? "foreign" : "absent";
  if (entry !== ENTRY_SOURCE) return "foreign";
  await rm(directory, { recursive: true, force: true });
  return "removed";
}
