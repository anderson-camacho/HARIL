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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activateCopy, pruneVendor } from "../src/tools/activate.js";
import { type EnsureFs, nodeEnsureFs } from "../src/tools/fs.js";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");

describe("activating a verified copy", () => {
  let root: string;
  let vendor: string;
  let source: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "haril-activate-"));
    vendor = join(root, "vendor", "engram");
    source = join(root, "extracted-engram");
    writeFileSync(source, "engram 3.6.0");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const activate = (fs: EnsureFs = nodeEnsureFs) =>
    activateCopy(
      { vendorRoot: vendor, version: "3.6.0", binary: "engram", source, pid: 42, now: NOW },
      fs,
    );

  it("puts the binary in <vendor>/<version>/ and leaves no staging folder", () => {
    const result = activate();
    expect(result).toEqual({ ok: true, path: join(vendor, "3.6.0", "engram") });
    expect(readFileSync(join(vendor, "3.6.0", "engram"), "utf8")).toBe("engram 3.6.0");
    expect(readdirSync(vendor)).toEqual(["3.6.0"]);
  });

  it("stages next to the final folder, so the last step is one rename", () => {
    const seen: string[] = [];
    const spy: EnsureFs = {
      ...nodeEnsureFs,
      rename: (from, to) => {
        seen.push(`${from.slice(vendor.length + 1)} -> ${to.slice(vendor.length + 1)}`);
        nodeEnsureFs.rename(from, to);
      },
    };
    activate(spy);
    expect(seen).toEqual(["3.6.0.tmp-42 -> 3.6.0"]);
  });

  it("moves an existing copy aside, installs, and deletes the old one", () => {
    mkdirSync(join(vendor, "3.6.0"), { recursive: true });
    writeFileSync(join(vendor, "3.6.0", "engram"), "corrupt");
    const seen: string[] = [];
    const spy: EnsureFs = {
      ...nodeEnsureFs,
      rename: (from, to) => {
        seen.push(`${from.slice(vendor.length + 1)} -> ${to.slice(vendor.length + 1)}`);
        nodeEnsureFs.rename(from, to);
      },
    };
    const result = activate(spy);
    expect(result).toMatchObject({ ok: true });
    expect(seen).toEqual([`3.6.0 -> 3.6.0.old-${NOW}`, "3.6.0.tmp-42 -> 3.6.0"]);
    expect(readFileSync(join(vendor, "3.6.0", "engram"), "utf8")).toBe("engram 3.6.0");
    expect(readdirSync(vendor)).toEqual(["3.6.0"]);
  });

  it("restores the previous copy when the final rename fails", () => {
    mkdirSync(join(vendor, "3.6.0"), { recursive: true });
    writeFileSync(join(vendor, "3.6.0", "engram"), "previous");
    let calls = 0;
    const failing: EnsureFs = {
      ...nodeEnsureFs,
      rename: (from, to) => {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
        nodeEnsureFs.rename(from, to);
      },
    };
    const result = activate(failing);
    expect(result).toMatchObject({ ok: false, inUse: false });
    expect(readFileSync(join(vendor, "3.6.0", "engram"), "utf8")).toBe("previous");
    expect(readdirSync(vendor)).toEqual(["3.6.0"]);
  });

  it.each(["EBUSY", "EPERM", "EACCES"])(
    "says the runtime is using Engram when %s stops moving the old copy, and changes nothing",
    (code) => {
      mkdirSync(join(vendor, "3.6.0"), { recursive: true });
      writeFileSync(join(vendor, "3.6.0", "engram"), "previous");
      const busy: EnsureFs = {
        ...nodeEnsureFs,
        rename: () => {
          throw Object.assign(new Error(`${code}: resource busy or locked`), { code });
        },
      };
      const result = activate(busy);
      expect(result).toMatchObject({ ok: false, inUse: true });
      expect(!result.ok && result.message).toContain("haril stop");
      expect(readFileSync(join(vendor, "3.6.0", "engram"), "utf8")).toBe("previous");
      expect(readdirSync(vendor)).toEqual(["3.6.0"]);
    },
  );

  it("cleans the staging folder up when the copy itself fails", () => {
    const failing: EnsureFs = {
      ...nodeEnsureFs,
      copyFile: () => {
        throw new Error("ENOSPC: no space left on device");
      },
    };
    const result = activate(failing);
    expect(result).toMatchObject({ ok: false, inUse: false });
    expect(existsSync(join(vendor, "3.6.0.tmp-42"))).toBe(false);
    expect(existsSync(join(vendor, "3.6.0"))).toBe(false);
  });

  it("clears a leftover staging folder of an earlier run", () => {
    mkdirSync(join(vendor, "3.6.0.tmp-42"), { recursive: true });
    writeFileSync(join(vendor, "3.6.0.tmp-42", "junk"), "x");
    expect(activate()).toMatchObject({ ok: true });
    expect(readdirSync(vendor)).toEqual(["3.6.0"]);
  });
});

describe("pruning old copies", () => {
  let vendor: string;
  beforeEach(() => {
    vendor = mkdtempSync(join(tmpdir(), "haril-prune-"));
    for (const name of [
      "3.1.0",
      "3.3.0",
      "3.5.0",
      "3.6.0",
      "3.7.0",
      "3.6.0.old-1730000000000",
      "3.6.0.tmp-99",
      "notes",
    ]) {
      mkdirSync(join(vendor, name));
      writeFileSync(join(vendor, name, "engram"), name);
    }
    writeFileSync(join(vendor, "stray.txt"), "x");
  });
  afterEach(() => rmSync(vendor, { recursive: true, force: true }));

  it("keeps the pin and the one version before it, anything newer, and what it does not know", () => {
    const removed = pruneVendor({ vendorRoot: vendor, pin: "3.6.0" }, nodeEnsureFs);
    expect(readdirSync(vendor).sort()).toEqual(["3.5.0", "3.6.0", "3.7.0", "notes", "stray.txt"]);
    expect(removed.sort()).toEqual(["3.1.0", "3.3.0", "3.6.0.old-1730000000000", "3.6.0.tmp-99"]);
  });

  it("never removes a folder it was told to keep", () => {
    pruneVendor(
      { vendorRoot: vendor, pin: "3.6.0", keep: [join(vendor, "3.3.0", "engram")] },
      nodeEnsureFs,
    );
    expect(existsSync(join(vendor, "3.3.0"))).toBe(true);
    expect(existsSync(join(vendor, "3.1.0"))).toBe(false);
  });

  it("is best effort: a folder that cannot be removed does not stop the rest", () => {
    const stubborn: EnsureFs = {
      ...nodeEnsureFs,
      remove: (path) => {
        if (path.endsWith("3.1.0")) throw new Error("EBUSY");
        nodeEnsureFs.remove(path);
      },
    };
    expect(() => pruneVendor({ vendorRoot: vendor, pin: "3.6.0" }, stubborn)).not.toThrow();
    expect(existsSync(join(vendor, "3.1.0"))).toBe(true);
    expect(existsSync(join(vendor, "3.3.0"))).toBe(false);
  });

  it("does nothing when the folder does not exist", () => {
    expect(
      pruneVendor({ vendorRoot: join(vendor, "missing"), pin: "3.6.0" }, nodeEnsureFs),
    ).toEqual([]);
  });
});
