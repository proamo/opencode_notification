import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installOmoExtension, omoExtensionDirectory, removeOmoExtension } from "../src/omo/install";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omo-install-test-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("OMO extension install", () => {
  test("copies the bundle with a relative entry and removes it again", async () => {
    const agentDirectory = await temporaryDirectory();
    const bundlePath = join(await temporaryDirectory(), "extension.js");
    await writeFile(bundlePath, "export default () => {};\n");

    const { directory } = await installOmoExtension({ agentDirectory, bundlePath });

    expect(directory).toBe(omoExtensionDirectory(agentDirectory));
    expect(await readFile(join(directory, "extension.js"), "utf8")).toBe(
      "export default () => {};\n",
    );
    expect(await readFile(join(directory, "index.ts"), "utf8")).toBe(
      'export { default } from "./extension.js";\n',
    );
    expect(await removeOmoExtension(agentDirectory)).toBe("removed");
    expect(await Bun.file(join(directory, "index.ts")).exists()).toBe(false);
  });

  test("leaves an extension directory it did not install", async () => {
    const agentDirectory = await temporaryDirectory();
    const directory = omoExtensionDirectory(agentDirectory);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "index.ts"), 'export { default } from "/dev/build.js";\n');

    expect(await removeOmoExtension(agentDirectory)).toBe("foreign");
    expect(await Bun.file(join(directory, "index.ts")).exists()).toBe(true);
    expect(await removeOmoExtension(await temporaryDirectory())).toBe("absent");
  });
});
