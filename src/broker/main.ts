import { startOrReuseBroker } from "./server";

export async function runBroker(): Promise<void> {
  const port = parsePositiveInteger(process.env.OPENCODE_TELEGRAM_BROKER_PORT);
  const idleTimeoutMs = parsePositiveInteger(process.env.OPENCODE_TELEGRAM_BROKER_IDLE_TIMEOUT_MS);
  const result = await startOrReuseBroker({
    ...(process.env.OPENCODE_TELEGRAM_BROKER_STATE_DIR
      ? { stateDirectory: process.env.OPENCODE_TELEGRAM_BROKER_STATE_DIR }
      : {}),
    ...(port ? { port } : {}),
    ...(idleTimeoutMs ? { idleTimeoutMs } : {}),
  });
  if (result.kind === "existing") return;

  const stop = () => void result.broker.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await result.broker.finished;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

if (import.meta.main) {
  await runBroker();
}
