// Where HARIL may reach an `engram serve`: 127.0.0.1 only, on a port it chose, never a reserved one. A URL that fails
// this check is never contacted (ADR-0008 D4; MEMORY.md 4.4; memory.md 9.4 point 2).

// Engram's default port, where the user's own Engram listens (06 sec3.2). An ENGRAM_PORT of 0 or an invalid value
// falls back to it silently (06 sec7), so HARIL never passes either.
export const ENGRAM_DEFAULT_PORT = 7437;

// Ports HARIL never uses (ARCH 4.5 "Puertos"): Engram's default and those of the tools around it (00 sec2.3).
export const RESERVED_PORTS: readonly number[] = [ENGRAM_DEFAULT_PORT, 8317, 8325, 20128, 53692];

type PortProblem = "invalid" | "reserved";

// Why a port cannot be ENGRAM_PORT, or undefined when it can (whether it is free is another check).
export function portProblem(port: number): PortProblem | undefined {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return "invalid";
  return RESERVED_PORTS.includes(port) ? "reserved" : undefined;
}

// Why a base URL is not one HARIL may contact, or undefined: plain HTTP to the literal 127.0.0.1 (not a name that
// could resolve elsewhere), an allowed port, no path, credentials, query or fragment.
export function endpointProblem(baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return "the endpoint is not a URL";
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    return "the endpoint is not http://127.0.0.1";
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return "the endpoint carries credentials, a query or a fragment";
  }
  if (url.pathname !== "/") return "the endpoint has a path";
  const problem = portProblem(Number(url.port === "" ? "80" : url.port));
  if (problem === "reserved") return `the endpoint uses the reserved port ${url.port}`;
  if (problem === "invalid" || url.port === "") return "the endpoint has no valid explicit port";
  return undefined;
}
