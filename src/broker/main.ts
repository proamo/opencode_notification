import { runSetupCli } from "../setup";
import { runBrokerCli } from "./commands";

export async function runBroker(): Promise<void> {
  if (process.argv[2] === "setup") {
    process.exitCode = await runSetupCli({ argv: process.argv.slice(3) });
    return;
  }

  const status = await runBrokerCli({ argv: process.argv.slice(2) });
  if (status !== undefined) process.exitCode = status;
}

if (import.meta.main) {
  await runBroker();
}
