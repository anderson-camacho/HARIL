---
{
  "id": "haril.methodology.tdd",
  "version": "0.1.0",
  "category": "methodology",
  "capabilities": [],
  "dependencies": [
    { "kind": "block", "id": "haril.agent.developer", "range": "^0.1.0" }
  ],
  "permissions": [],
  "config": {
    "schema": { "type": "object", "additionalProperties": false, "properties": {} },
    "defaults": {},
    "payload": {
      "roles": [{ "id": "implementer", "agent": "haril.agent.developer" }],
      "gates": [
        { "id": "authorize-writes", "kind": "approval_before", "action": "write", "roles": ["implementer"] }
      ],
      "sections": [
        { "id": "red-green-refactor", "roles": ["implementer"], "kinds": ["work"], "mandatory": true }
      ]
    }
  },
  "inputs": [],
  "outputs": [],
  "events": [],
  "errorPolicy": { "failClosed": true },
  "compatibility": { "contracts": "^0.1.0", "core": "^0.1.0" },
  "provides": ["methodology"],
  "replaces": []
}
---
<!-- haril:section:red-green-refactor -->
Test-driven development (RED, GREEN, REFACTOR). For every behavior change:

1. RED: write a test for the expected behavior and run it. It must fail for the expected reason before any production code changes.
2. GREEN: write the smallest production change that makes that test pass.
3. REFACTOR: clean up the code while the tests stay green.

Record the observed RED and GREEN results. When no runnable deterministic test exists, state the exception and run the proportionate checks instead.
<!-- /haril:section:red-green-refactor -->
