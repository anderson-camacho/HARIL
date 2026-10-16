---
{
  "id": "haril.methodology.custom",
  "version": "0.1.0",
  "category": "methodology",
  "capabilities": [],
  "dependencies": [],
  "permissions": [],
  "config": {
    "schema": { "type": "object", "additionalProperties": false, "properties": {} },
    "defaults": {},
    "payload": { "roles": [], "gates": [], "sections": [] }
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
<!-- haril:section:custom-guidance -->
Custom methodology. This block declares no roles, gates or sections, so it adds no rules and no context. Copy it into a project and edit the body to define your own method.
<!-- /haril:section:custom-guidance -->
