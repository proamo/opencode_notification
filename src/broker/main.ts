#!/usr/bin/env bun
import { runSetupCli } from "../setup";
import { runUninstallCli } from "../uninstall";
import { runBrokerCli } from "./commands";

export async function runBroker(): Promise<void> {
  const command = process.argv[2];
  if (command === "setup") {
    process.exitCode = await runSetupCli({ argv: process.argv.slice(3) });
    return;
  }
  if (command === "uninstall") {
    process.exitCode = await runUninstallCli({ argv: process.argv.slice(3) });
    return;
  }

  const status = await runBrokerCli({ argv: process.argv.slice(2) });
  if (status !== undefined) process.exitCode = status;
}

if (import.meta.main) {
  await runBroker();
}
