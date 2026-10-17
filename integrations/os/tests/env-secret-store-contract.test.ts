import type { SecretStore } from "@haril/core/ports";
import { describeSecretStoreContract } from "@haril/core/testing";
import { describe, it } from "vitest";
import { EnvSecretStore } from "../src/index.js";

// The SecretStore contract suite against EnvSecretStore (TEST_STRATEGY 5 row 10; BL-089). Every store of a run shares
// one environment map, so a store that persisted a put where a fresh store reads it would be caught (SS-08).

const test = { describe, it };
const env: Readonly<Record<string, string | undefined>> = {
  HARIL_UNRELATED_SETTING: "fake-unrelated-value",
};

describeSecretStoreContract(test, "EnvSecretStore", (): SecretStore => new EnvSecretStore(env));
