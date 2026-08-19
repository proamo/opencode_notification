import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

describe("release configuration", () => {
  test("configures reproducible npm publishing and provenance", async () => {
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

    expect(packageJson.publishConfig).toEqual({ access: "public", provenance: true });
    expect(packageJson.files).toEqual(["dist", "README.md", "LICENSE"]);
    expect(packageJson.scripts.prepack).toBe("bun run build");
    expect(packageJson.scripts["release:check"]).toContain("release:smoke");
    expect(packageJson.scripts["release:check"]).toContain("npm pack --dry-run");
    expect(packageJson.scripts["license:check"]).toBe(
      "bun scripts/release-smoke.ts --license-only",
    );
    expect(packageJson.scripts["release:changelog"]).toBe("bun scripts/generate-changelog.ts");
  });

  test("defines a provenance publishing workflow", async () => {
    const workflow = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");

    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("bun install --frozen-lockfile");
    expect(workflow).toContain("bun run release:check");
    expect(workflow).toContain("npm publish --provenance --access public");
    expect(workflow).toContain("NODE_AUTH_TOKEN: $" + "{{ secrets.NPM_TOKEN }}");
  });

  test("keeps changelog and release smoke checks in source control", async () => {
    const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
    const smoke = await readFile(join(root, "scripts", "release-smoke.ts"), "utf8");

    expect(changelog).toContain("# Changelog");
    expect(changelog).toContain("## 0.0.0 - Unreleased");
    expect(smoke).toContain("publishConfig.provenance must be true");
    expect(smoke).toContain("packed artifact is missing");
    expect(smoke).toContain("plugin default export is missing");
    expect(smoke).toContain("LICENSE must contain the MIT license text");
  });
});
