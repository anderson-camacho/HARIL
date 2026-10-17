import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

// Where the control channel of one data root lives (ARCH 4.3). On win32 it is a named pipe whose name hashes the data
// root, so two data roots never share a pipe; elsewhere it is a Unix socket under run/ in the data root. The token
// file sits next to it. Both the server and the clients derive the same paths from the same data root.

const RUN_DIR = "run";
const TOKEN_FILE = "ctl.token";
const SOCKET_FILE = "ctl.sock";
const PIPE_PREFIX = "\\\\.\\pipe\\haril-ctl-";
const HASH_HEX_LENGTH = 16;

export interface ControlLocation {
  // The pipe name on win32, the socket path elsewhere: what the client connects to.
  readonly endpoint: string;
  // The file holding the token the client must send in its hello.
  readonly tokenFile: string;
  // The directory of the token file, created at start.
  readonly runDir: string;
  // The socket file on POSIX, which start removes when it is stale. Undefined on win32, where the pipe needs no file.
  readonly socketFile: string | undefined;
}

export function controlLocation(
  dataDir: string,
  platform: string = process.platform,
): ControlLocation {
  const root = resolve(dataDir);
  const runDir = join(root, RUN_DIR);
  const tokenFile = join(runDir, TOKEN_FILE);
  if (platform === "win32") {
    const digest = createHash("sha256").update(root, "utf8").digest("hex");
    return {
      endpoint: `${PIPE_PREFIX}${digest.slice(0, HASH_HEX_LENGTH)}`,
      tokenFile,
      runDir,
      socketFile: undefined,
    };
  }
  const socketFile = join(runDir, SOCKET_FILE);
  return { endpoint: socketFile, tokenFile, runDir, socketFile };
}
