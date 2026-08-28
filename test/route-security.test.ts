import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { RouteRegistry } from "../src/broker/registry";

describe("Route Security & Strict Resolution", () => {
  test("never routes cross-project even if sessionId matches on same machine", () => {
    const registry = new RouteRegistry();
    const conn1 = randomUUID();
    const machineId = randomUUID();
    const instanceIdA = randomUUID();
    const instanceIdB = randomUUID();
    const routeGeneration = randomUUID();
    const sharedSessionId = "ses_conflict_123";

    const fakeSocket = {
      data: { connectionId: conn1 },
      send: () => {},
      close: () => {},
    } as any;

    registry.registerConnection(fakeSocket, instanceIdA, machineId, "codeCenter", "Project Alpha");

    registry.registerRoute(conn1, {
      route: {
        machineId,
        instanceId: instanceIdA,
        projectId: "proj_alpha_1234567890",
        sessionId: sharedSessionId,
        routeGeneration,
      },
      projectLabel: "Project Alpha",
      sessionLabel: sharedSessionId,
    });

    // An incoming route intended for Project Beta (different projectId)
    const betaRoute = {
      machineId,
      instanceId: instanceIdB,
      projectId: "proj_beta_12345678900",
      sessionId: sharedSessionId,
      routeGeneration,
    };

    // Strict resolution MUST fail-closed and return undefined, NOT route to Project Alpha!
    const resolved = registry.resolve(betaRoute);
    expect(resolved).toBeUndefined();
  });
});
