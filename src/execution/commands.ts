import { ProcessLifecycleAdapter } from "../adapters/harnesses/process-lifecycle.ts";
import { defineAction, dependency } from "../cli/definition.ts";
import { positional, text } from "../cli/schema.ts";
import { actorRefSchema } from "../domain/identifiers.ts";
import type { Claim } from "../domain/model.ts";
import { claimRef, runRef, withAsyncStore, withStore } from "../persistence/command-store.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import { LifecycleCoordinator, Supervisor } from "./lifecycle.ts";

export function runActions(services: RuntimeServices) {
  const run = positional(text("Recorded run reference.", "RUN"));
  const claim = positional(text("Recorded claim reference.", "CLAIM"));
  const evidence = text("Verification evidence as JSON.", "JSON");
  const clock = { now: services.now ?? (() => new Date()) };
  const lifecycle = dependency(services.lifecycle, "managed lifecycle adapter");
  const tracker = dependency(services.tracker, "mutating tracker adapter");
  const recovery = dependency(services.verifyRecovery, "recovery verifier");
  const attention = dependency(services.verifyAttention, "attention verifier");
  return {
    runs: {
      list: defineAction({
        description: "List durable local runs.",
        input: {},
        handler: () => withStore(services, (store) => store.listRuns()),
      }),
      show: defineAction({
        description: "Inspect a durable local run.",
        input: { run },
        handler: (input) => withStore(services, (store) => store.run(runRef(input.run))),
      }),
      export: defineAction({
        description: "Export a run, claim, steps, and recovery evidence.",
        input: { run },
        handler: (input) =>
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
      dependencies: [lifecycle],
      handler: (input) =>
        withAsyncStore(services, (store) =>
          new LifecycleCoordinator(store, undefined, lifecycle.get(), clock).stop(
            runRef(input.run),
          ),
        ),
    }),
    recover: defineAction({
      description: "Recover a run using verified evidence.",
      input: { run, evidence },
      dependencies: [recovery],
      handler: (input) =>
        withAsyncStore(services, (store) =>
          new LifecycleCoordinator(
            store,
            undefined,
            services.lifecycle ?? (() => new ProcessLifecycleAdapter()),
            clock,
          ).recover(runRef(input.run), JSON.parse(input.evidence), recovery.get()),
        ),
    }),
    claim: {
      show: defineAction({
        description: "Inspect a durable claim.",
        input: { claim },
        handler: (input) => withStore(services, (store) => store.claim(claimRef(input.claim))),
      }),
      release: defineAction({
        description: "Release a claim with explicit actor authorization.",
        input: { claim, "authorized-by": text("Authorizing actor.", "ACTOR") },
        dependencies: [tracker],
        handler: (input) =>
          withAsyncStore(services, async (store) => {
            const ref = claimRef(input.claim);
            await new LifecycleCoordinator(
              store,
              tracker.get(),
              services.lifecycle ?? (() => new ProcessLifecycleAdapter()),
              clock,
            ).release(ref, actorRefSchema.parse(input["authorized-by"]));
            return store.claim(ref);
          }),
      }),
    },
    supervisor: {
      status: defineAction({
        description: "Inspect supervisor, active runs, and attention requests.",
        input: {},
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
        dependencies: [tracker, lifecycle],
        handler: () =>
          withAsyncStore(services, (store) =>
            new Supervisor({
              store,
              tracker: tracker.get(),
              lifecycle: lifecycle.get(),
              clock,
            }).tick(),
          ),
      }),
      reconcile: defineAction({
        description: "Reconcile attention using verified observation and claim evidence.",
        input: { run, evidence },
        dependencies: [attention],
        handler: (input) =>
          withAsyncStore(services, async (store) => {
            const ref = runRef(input.run);
            const verified = await attention.get()(store.run(ref), JSON.parse(input.evidence));
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
