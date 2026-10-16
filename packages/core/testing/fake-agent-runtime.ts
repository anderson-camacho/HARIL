import type {
  AgentHandle,
  AgentHello,
  AgentOutcome,
  AgentRuntime,
  AgentSpec,
  Cancel,
  Clock,
  HarilError,
  Result,
} from "../src/ports/index.js";

// Simulated agent (M1-D7). The behaviour is chosen by agentRef:
//   fake:succeed (default), fake:fail, fake:slow:<ms>; any other ref succeeds as a simulated run until M2.
// Work starts when prompt() is accepted; a slow run settles at its completion time or at timeoutMs.

export interface FakeAgentRuntimeOptions {
  readonly clock: Clock;
  // Test hook: the tool list announced in hello. Defaults to the spec's allowedTools.
  readonly helloTools?: (allowedTools: readonly string[]) => readonly string[];
}

type Behaviour =
  | { readonly kind: "succeed" }
  | { readonly kind: "fail" }
  | { readonly kind: "slow"; readonly ms: number }
  | { readonly kind: "simulated" };

const SLOW_REF = /^fake:slow:(\d+)$/;

// M1 fix (a): an unknown ref is not an error in M1; it is a simulated success until a real agent exists (M2).
function parseAgentRef(agentRef: string): Behaviour {
  if (agentRef === "fake:succeed") return { kind: "succeed" };
  if (agentRef === "fake:fail") return { kind: "fail" };
  const slow = SLOW_REF.exec(agentRef);
  if (slow !== null) return { kind: "slow", ms: Number(slow[1]) };
  return { kind: "simulated" };
}

function sameTools(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((tool, index) => tool === right[index]);
}

export class FakeAgentRuntime implements AgentRuntime {
  private readonly options: FakeAgentRuntimeOptions;

  constructor(options: FakeAgentRuntimeOptions) {
    this.options = options;
  }

  async start(spec: AgentSpec): Promise<Result<AgentHandle, HarilError>> {
    const behaviour = parseAgentRef(spec.agentRef);
    return { ok: true, value: new FakeAgentHandle(spec, behaviour, this.options) };
  }
}

class FakeAgentHandle implements AgentHandle {
  readonly runId: string;
  readonly hello: Promise<AgentHello>;
  readonly settled: Promise<AgentOutcome>;
  private resolveSettled!: (outcome: AgentOutcome) => void;
  private finished = false;
  private readonly cancels: Cancel[] = [];
  private readonly spec: AgentSpec;
  private readonly behaviour: Behaviour;
  private readonly options: FakeAgentRuntimeOptions;

  constructor(spec: AgentSpec, behaviour: Behaviour, options: FakeAgentRuntimeOptions) {
    this.spec = spec;
    this.behaviour = behaviour;
    this.options = options;
    this.runId = spec.runId;
    const tools = options.helloTools ? options.helloTools(spec.allowedTools) : spec.allowedTools;
    this.hello = Promise.resolve({ tools: [...tools] });
    this.settled = new Promise<AgentOutcome>((resolve) => {
      this.resolveSettled = resolve;
    });
  }

  async prompt(_text: string): Promise<Result<void, HarilError>> {
    if (this.finished) {
      return { ok: false, error: { code: "agent.closed", message: "the run has already settled" } };
    }
    const hello = await this.hello;
    if (!sameTools(hello.tools, this.spec.allowedTools)) {
      const message = "hello tool list differs from allowedTools; the prompt is refused";
      this.finish({ status: "failed", code: "agent.handshake_mismatch", message });
      return { ok: false, error: { code: "agent.handshake_mismatch", message } };
    }
    this.begin();
    return { ok: true, value: undefined };
  }

  async abort(): Promise<void> {
    this.finish({ status: "aborted" });
  }

  async dispose(): Promise<void> {
    this.finish({ status: "aborted" });
  }

  private begin(): void {
    const { behaviour, options, spec } = this;
    if (behaviour.kind === "succeed") {
      this.finish({ status: "succeeded", summary: "fake agent succeeded" });
    } else if (behaviour.kind === "simulated") {
      this.finish({
        status: "succeeded",
        summary: "simulated: no real agent until M2",
        simulated: true,
      });
    } else if (behaviour.kind === "fail") {
      this.finish({
        status: "failed",
        code: "fake.failed",
        message: "fake agent failed on request",
      });
    } else {
      this.cancels.push(
        options.clock.schedule(behaviour.ms, () =>
          this.finish({ status: "succeeded", summary: "fake agent finished slowly" }),
        ),
        options.clock.schedule(spec.timeoutMs, () => this.finish({ status: "timed_out" })),
      );
    }
  }

  private finish(outcome: AgentOutcome): void {
    if (this.finished) return;
    this.finished = true;
    for (const cancel of this.cancels) cancel();
    this.resolveSettled(outcome);
  }
}
