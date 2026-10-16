---
{
  "id": "haril.methodology.odd",
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
        { "id": "odd-protocol", "roles": ["implementer"], "kinds": ["plan", "work", "verify", "summarize"], "mandatory": true }
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
<!-- haril:section:odd-protocol -->
Organic Driven Development (ODD). Follow these steps in order for every request.

1. Authorize: read-only work (explain, review, audit, compare, plan) never writes files. Change needs explicit intent.
2. Explore: read the existing code and requirements before proposing or writing anything.
3. Resolve uncertainty: ask one focused question only for a real product decision, then stop and wait.
4. Classify: substantial work has two or more meaningful steps. Small, understood work creates no tracking artifacts.
5. Track: before the first write of substantial work, record the objective, scope, a checklist with stable task ids, and acceptance criteria.
6. Implement task by task: test first when a runnable deterministic test exists (observe red, implement green, refactor). Check a task off only after its checks were observed.
7. Close: report the verified outcome, every failed, skipped or pending check, and the next step.
<!-- /haril:section:odd-protocol -->

<!-- haril:section:attribution -->
Derived work. Redacted from the Organic Driven Development routing protocol of Gentle AI (routing.go, v4.1.1, commit 898d3976e8049a7238eaa7de60bff325c30d2b3d), referenced by name only and not imported.
Not affiliated with or endorsed by Gentle AI or Engram. The source is licensed under the MIT License (gentle-ai v4.1.1, LICENSE):

MIT License

Copyright (c) 2025 Gentleman Programming

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
<!-- /haril:section:attribution -->
