import type { ActorRef, Claim } from "../domain.ts";
import { LifecycleCoordinator, Supervisor } from "../lifecycle.ts";
import { ProcessLifecycleAdapter } from "../platform/process-lifecycle.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import { defineAction, dependency } from "./definition.ts";
import { positional, text } from "./input.ts";
import { claimRef, runRef, withAsyncStore, withStore } from "./store.ts";

export function runActions(services: RuntimeServices) {
  const run = positional(text("Recorded run reference.", "RUN"));
  const claim = positional(text("Recorded claim reference.", "CLAIM"));
  const evidence = text("Verification evidence as JSON.", "JSON");
  const clock = { now: services.now ?? (() => new Date()) };
  const lifecycle = dependency(services.lifecycle, "managed lifecycle adapter");
  const tracker = dependency(services.tracker, "mutating tracker adapter");
  return {
    runs: {
      list: defineAction({
        description: "List durable local runs.",
        input: {},
        dependencies: {},
        handler: () => withStore(services, (store) => store.listRuns()),
      }),
      show: defineAction({
        description: "Inspect a durable local run.",
        input: { run },
        dependencies: {},
        handler: (_, input) => withStore(services, (store) => store.run(runRef(input.run))),
      }),
      export: defineAction({
        description: "Export a run, claim, steps, and recovery evidence.",
        input: { run },
        dependencies: {},
        handler: (_, input) =>
          withStore(services, (store) => {
            const ref = runRef(input.run);
            let claim: Claim | undefined;
            try {
              claim = store.claimForRun(ref);
            } catch {
              /* A run can exist before claiming. */
            }
            return {
              run: store.run(ref),
              claim,
              steps: store.steps(ref),
              recovery: store.recoveryEvidence(ref),
            };
          }),
      }),
    },
    stop: defineAction({
      description: "Stop a recorded run using its composed lifecycle adapter.",
      input: { run },
      dependencies: { lifecycle },
      handler: ({ lifecycle }, input) =>
        withAsyncStore(services, (store) =>
          new LifecycleCoordinator(store, undefined, lifecycle, clock).stop(runRef(input.run)),
        ),
    }),
    recover: defineAction({
      description: "Recover a run using verified evidence.",
      input: { run, evidence },
      dependencies: { verify: dependency(services.verifyRecovery, "recovery verifier") },
      handler: ({ verify }, input) =>
        withAsyncStore(services, (store) =>
          new LifecycleCoordinator(
            store,
            undefined,
            services.lifecycle ?? (() => new ProcessLifecycleAdapter()),
            clock,
          ).recover(runRef(input.run), JSON.parse(input.evidence), verify),
        ),
    }),
    claim: {
      show: defineAction({
        description: "Inspect a durable claim.",
        input: { claim },
        dependencies: {},
        handler: (_, input) => withStore(services, (store) => store.claim(claimRef(input.claim))),
      }),
      release: defineAction({
        description: "Release a claim with explicit actor authorization.",
        input: { claim, "authorized-by": text("Authorizing actor.", "ACTOR") },
        dependencies: { tracker },
        handler: ({ tracker }, input) =>
          withAsyncStore(services, async (store) => {
            const ref = claimRef(input.claim);
            await new LifecycleCoordinator(
              store,
              tracker,
              services.lifecycle ?? (() => new ProcessLifecycleAdapter()),
              clock,
            ).release(ref, input["authorized-by"] as ActorRef);
            return store.claim(ref);
          }),
      }),
    },
    supervisor: {
      status: defineAction({
        description: "Inspect supervisor, active runs, and attention requests.",
        input: {},
        dependencies: {},
        handler: () =>
          withStore(services, (store) => ({
            supervisor: store.supervisorStatus(),
            active: store.activeRuns(),
            attentionRequired: store
              .listRuns()
              .filter((run) => run.status === "attention_required"),
          })),
      }),
      tick: defineAction({
        description: "Observe runs and renew claims through composed services.",
        input: {},
        dependencies: { tracker, lifecycle },
        handler: ({ tracker, lifecycle }) =>
          withAsyncStore(services, (store) =>
            new Supervisor({ store, tracker, lifecycle, clock }).tick(),
          ),
      }),
      reconcile: defineAction({
        description: "Reconcile attention using verified observation and claim evidence.",
        input: { run, evidence },
        dependencies: { verify: dependency(services.verifyAttention, "attention verifier") },
        handler: ({ verify }, input) =>
          withAsyncStore(services, async (store) => {
            const ref = runRef(input.run);
            const verified = await verify(store.run(ref), JSON.parse(input.evidence));
            return new LifecycleCoordinator(
              store,
              services.tracker,
              services.lifecycle ?? (() => new ProcessLifecycleAdapter()),
              clock,
            ).reconcileAttention(ref, verified.observation, verified.claim);
          }),
      }),
    },
  };
}
