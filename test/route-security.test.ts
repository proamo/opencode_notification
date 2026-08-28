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
    } as unknown as Parameters<typeof registry.registerConnection>[0];

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

  test("never routes cross-instance even if project and sessionId match on same machine", () => {
    const registry = new RouteRegistry();
    const conn1 = randomUUID();
    const machineId = randomUUID();
    const instanceIdA = randomUUID();
    const instanceIdB = randomUUID();
    const routeGenerationA = randomUUID();
    const routeGenerationB = randomUUID();
    const projectId = "proj_alpha_1234567890";
    const sessionId = "ses_shared_1234";

    const fakeSocket = {
      data: { connectionId: conn1 },
      send: () => {},
      close: () => {},
    } as unknown as Parameters<typeof registry.registerConnection>[0];

    registry.registerConnection(fakeSocket, instanceIdA, machineId, "codeCenter", "Project Alpha");
    registry.registerRoute(conn1, {
      route: {
        machineId,
        instanceId: instanceIdA,
        projectId,
        sessionId,
        routeGeneration: routeGenerationA,
      },
      projectLabel: "Project Alpha",
      sessionLabel: sessionId,
    });

    // An incoming route intended for instance B (same machine, same project, same session, but different instanceId)
    const instanceBRoute = {
      machineId,
      instanceId: instanceIdB,
      projectId,
      sessionId,
      routeGeneration: routeGenerationB,
    };

    // Stale route from instance B MUST NOT fallback to instance A
    const resolved = registry.resolve(instanceBRoute);
    expect(resolved).toBeUndefined();

    // But same instance with new generation DOES resolve (reconnection fallback)
    const sameInstanceNewGen = {
      machineId,
      instanceId: instanceIdA,
      projectId,
      sessionId,
      routeGeneration: randomUUID(),
    };
    const resolvedSameInstance = registry.resolve(sameInstanceNewGen);
    expect(resolvedSameInstance).toBeDefined();
    expect(resolvedSameInstance?.route.instanceId).toBe(instanceIdA);
  });

  test("resolveBySessionId fails closed on ambiguous session collision across instances unless target is provided", () => {
    const registry = new RouteRegistry();
    const connA = randomUUID();
    const connB = randomUUID();
    const machineId = randomUUID();
    const instanceIdA = randomUUID();
    const instanceIdB = randomUUID();
    const sharedSessionId = "ses_collision_999";

    const fakeSocketA = {
      data: { connectionId: connA },
      send: () => {},
      close: () => {},
    } as unknown as Parameters<typeof registry.registerConnection>[0];

    const fakeSocketB = {
      data: { connectionId: connB },
      send: () => {},
      close: () => {},
    } as unknown as Parameters<typeof registry.registerConnection>[0];

    registry.registerConnection(fakeSocketA, instanceIdA, machineId, "Node-A", "Project-A");
    registry.registerConnection(fakeSocketB, instanceIdB, machineId, "Node-B", "Project-B");

    registry.registerRoute(connA, {
      route: {
        machineId,
        instanceId: instanceIdA,
        projectId: "proj_a_1234567890",
        sessionId: sharedSessionId,
        routeGeneration: randomUUID(),
      },
      projectLabel: "Project-A",
      sessionLabel: "Session 1",
    });

    registry.registerRoute(connB, {
      route: {
        machineId,
        instanceId: instanceIdB,
        projectId: "proj_b_1234567890",
        sessionId: sharedSessionId,
        routeGeneration: randomUUID(),
      },
      projectLabel: "Project-B",
      sessionLabel: "Session 1",
    });

    // Ambiguous lookup without target MUST fail-closed (return undefined)
    expect(registry.resolveBySessionId(sharedSessionId)).toBeUndefined();

    // Disambiguated lookup with target resolves to the correct instance
    const resolvedA = registry.resolveBySessionId(sharedSessionId, "Project-A");
    expect(resolvedA).toBeDefined();
    expect(resolvedA?.instanceId).toBe(instanceIdA);

    const resolvedB = registry.resolveBySessionId(sharedSessionId, "Project-B");
    expect(resolvedB).toBeDefined();
    expect(resolvedB?.instanceId).toBe(instanceIdB);
  });
});
