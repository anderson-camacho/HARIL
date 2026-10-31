import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkArchiveListing, extractBinary, tarCommand } from "../src/tools/archive.js";
import { nodeEnsureFs } from "../src/tools/fs.js";
import { runCapped } from "../src/tools/system.js";
import type { ExecResult } from "../src/tools/version.js";

// A minimal ustar writer: enough to build archives, hostile ones included, that the real tar reads.
function tarEntry(name: string, content = "", type = "0"): Buffer {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

function tarGz(entries: readonly Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

const BINARY = process.platform === "win32" ? "engram.exe" : "engram";

describe("judging an archive listing", () => {
  it.each([
    [BINARY],
    [`./${BINARY}`],
    [`${BINARY}\nLICENSE\nREADME.md\n`],
    [`${BINARY}\r\ndocs/\r\ndocs/guide.md\r\n`],
    [`./\n./${BINARY}\n./LICENSE\n`],
  ])("accepts a root binary with harmless neighbours: %j", (listing) => {
    expect(checkArchiveListing(listing, BINARY)).toMatchObject({ ok: true });
  });

  it("returns the entry exactly as the archive spells it, for the extraction", () => {
    expect(checkArchiveListing(`LICENSE\n./${BINARY}\n`, BINARY)).toEqual({
      ok: true,
      entry: `./${BINARY}`,
    });
  });

  it.each([
    ["a parent-directory entry", `${BINARY}\n../evil.txt\n`],
    ["a buried parent-directory entry", `${BINARY}\na/b/../../../evil\n`],
    ["a backslash traversal", `${BINARY}\na\\..\\..\\evil\n`],
    ["an absolute POSIX entry", `${BINARY}\n/etc/cron.d/evil\n`],
    ["an absolute Windows entry", `${BINARY}\nC:\\Windows\\evil.dll\n`],
    ["a drive-relative entry", `${BINARY}\nC:evil.dll\n`],
    ["a UNC entry", `${BINARY}\n\\\\server\\share\\evil\n`],
    ["a control character", `${BINARY}\nbad\u0001name\n`],
    ["a bare parent entry", `${BINARY}\n..\n`],
  ])("rejects the whole archive for %s, even beside a good binary", (_name, listing) => {
    const result = checkArchiveListing(listing, BINARY);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("unsafe");
  });

  it("rejects an archive without the binary", () => {
    const result = checkArchiveListing("LICENSE\nREADME.md\n", BINARY);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain(BINARY);
  });

  it("rejects the binary when it is not at the archive root", () => {
    expect(checkArchiveListing(`bin/${BINARY}\n`, BINARY)).toMatchObject({ ok: false });
  });

  it("rejects an archive that holds the binary twice", () => {
    const result = checkArchiveListing(`${BINARY}\n./${BINARY}\n`, BINARY);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("more than once");
  });

  it("rejects an empty listing", () => {
    expect(checkArchiveListing("", BINARY)).toMatchObject({ ok: false });
  });
});

describe("the tar command", () => {
  it("is the system's bsdtar on Windows, never one found on PATH", () => {
    expect(tarCommand("win32", { SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\tar.exe");
    expect(tarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("is plain tar elsewhere", () => {
    expect(tarCommand("linux", {})).toBe("tar");
  });
});

describe("extracting the binary with the real tar", () => {
  let work: string;
  let archive: string;
  let dest: string;
  const tar = tarCommand(process.platform, process.env);

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "haril-archive-"));
    archive = join(work, "engram.tar.gz");
    dest = join(work, "out");
    mkdirSync(dest);
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  const input = () => ({ archive, destDir: dest, binary: BINARY, tar });

  it("takes only the one expected binary and leaves the other entries behind", async () => {
    writeFileSync(
      archive,
      tarGz([
        tarEntry(BINARY, "the binary"),
        tarEntry("LICENSE", "text"),
        tarEntry("README.md", "x"),
      ]),
    );
    const result = await extractBinary(input(), runCapped, nodeEnsureFs);
    expect(result).toEqual({ ok: true, path: join(dest, BINARY) });
    expect(readdirSync(dest)).toEqual([BINARY]);
    expect(readFileSync(join(dest, BINARY), "utf8")).toBe("the binary");
  });

  it("rejects a zip-slip entry and writes nothing, inside or outside the folder", async () => {
    writeFileSync(archive, tarGz([tarEntry(BINARY, "the binary"), tarEntry("../evil.txt", "pwn")]));
    const result = await extractBinary(input(), runCapped, nodeEnsureFs);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("unsafe");
    expect(readdirSync(dest)).toEqual([]);
    expect(existsSync(join(work, "evil.txt"))).toBe(false);
  });

  it("rejects an archive with no binary", async () => {
    writeFileSync(archive, tarGz([tarEntry("LICENSE", "text")]));
    const result = await extractBinary(input(), runCapped, nodeEnsureFs);
    expect(result).toMatchObject({ ok: false });
    expect(readdirSync(dest)).toEqual([]);
  });

  it("fails cleanly on a file that is not an archive", async () => {
    writeFileSync(archive, "this is not an archive");
    const result = await extractBinary(input(), runCapped, nodeEnsureFs);
    expect(result).toMatchObject({ ok: false });
    expect(readdirSync(dest)).toEqual([]);
  });

  it("fails cleanly when the archive does not exist", async () => {
    const result = await extractBinary(input(), runCapped, nodeEnsureFs);
    expect(result).toMatchObject({ ok: false });
  });
});

describe("checking what was extracted", () => {
  const ok = (output: string): ExecResult => ({ code: 0, output, timedOut: false });
  const fakeTar = (listing: string) => async (_file: string, args: readonly string[]) =>
    args.includes("-tf") ? ok(listing) : ok("");
  const stat = (over: Partial<ReturnType<typeof nodeEnsureFs.stat>>) => ({
    ...nodeEnsureFs,
    stat: () => ({ mtimeMs: 0, size: 10, isFile: true, isSymlink: false, links: 1, ...over }),
    chmod: () => undefined,
  });
  const input = { archive: "a.zip", destDir: "/out", binary: "engram", tar: "tar" };

  it("accepts a regular file", async () => {
    const result = await extractBinary(input, fakeTar("engram\n"), stat({}));
    expect(result).toMatchObject({ ok: true });
  });

  it.each([
    ["a symbolic link", { isSymlink: true }],
    ["a hard link", { links: 2 }],
    ["an empty file", { size: 0 }],
    ["a directory", { isFile: false }],
  ])("rejects %s in place of the binary", async (_name, over) => {
    const result = await extractBinary(input, fakeTar("engram\n"), stat(over));
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects a listing the tool could not give", async () => {
    const failing = async () => ({ code: 1, output: "tar: bad", timedOut: false });
    const result = await extractBinary(input, failing, stat({}));
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects a listing that was cut at the output cap", async () => {
    const huge = "a\n".repeat(200_000);
    const result = await extractBinary(input, fakeTar(huge), stat({}));
    expect(result).toMatchObject({ ok: false });
  });
});
