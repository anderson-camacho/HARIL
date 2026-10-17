import { describeSecretStoreContract } from "@haril/core/testing";
import { describe, it } from "vitest";
import { secretStoreFor } from "../src/providers.js";

// The SecretStore contract suite against the composition root's store (secretStoreFor, an EnvSecretStore over the
// host's environment; TEST_STRATEGY 5 row 10). The adapter's own run is in integrations/os/tests.

const test = { describe, it };
const env: Readonly<Record<string, string | undefined>> = {
  HARIL_UNRELATED_SETTING: "fake-unrelated-value",
};

describeSecretStoreContract(test, "the composition root's store (secretStoreFor)", () =>
  secretStoreFor({ nodeVersion: "v24.21.0", platform: "linux", arch: "x64", homeDir: ".", env }),
);
