// Preloaded by bunfig.toml: tests must never read or rewrite the developer's real
// OpenCode config, state, or plugin links. Bun caches os.homedir() at startup, so
// the module is mocked in addition to the environment variables.
import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(os.tmpdir(), "opencode-telegram-test-home-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.XDG_STATE_HOME = join(home, ".local", "state");
process.env.XDG_DATA_HOME = join(home, ".local", "share");
process.env.XDG_CACHE_HOME = join(home, ".cache");

const isolatedOs = { ...os, homedir: () => home };
mock.module("node:os", () => ({ ...isolatedOs, default: isolatedOs }));
mock.module("os", () => ({ ...isolatedOs, default: isolatedOs }));
