import { isIP } from "node:net";

export function parseGatewayWebSocketUrl(value: string): URL {
  const base = value.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  const parsed = new URL(base.includes("://") ? base : `ws://${base}`);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("gateway URL must use ws:// or wss://");
  }
  if (!parsed.pathname || parsed.pathname === "/") parsed.pathname = "/v1/connect";
  if (parsed.protocol === "ws:" && !isPrivateGatewayHost(parsed.hostname)) {
    throw new Error("public gateway URLs must use wss://");
  }
  return parsed;
}

export function isPrivateGatewayHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLoopbackGatewayHost(host)) return true;
  const addressFamily = isIP(host);
  if (addressFamily === 0) return false;
  const parts = host.split(".").map(Number);
  if (addressFamily === 4) {
    const [first = -1, second = -1] = parts;
    return (
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127)
    );
  }
  return (
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe8") ||
    host.startsWith("fe9") ||
    host.startsWith("fea") ||
    host.startsWith("feb")
  );
}

export function isLoopbackGatewayHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) !== 4) return false;
  return Number(host.split(".")[0]) === 127;
}
