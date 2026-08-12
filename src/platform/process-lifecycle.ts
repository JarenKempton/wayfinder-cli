import type { RunLifecycleAdapter } from "../contracts.ts";
import type { Run, RunObservation } from "../domain.ts";
import { capabilities, UnsupportedCapabilityError } from "../domain.ts";

/**
 * Bare PIDs are not stable process identities and may be reused by the OS.
 * Until a platform adapter can verify an adapter-owned identity token, this
 * fallback advertises no lifecycle capability and never probes or signals.
 */
export class ProcessLifecycleAdapter implements RunLifecycleAdapter {
  readonly capabilities = capabilities();

  async observe(_run: Run): Promise<RunObservation> {
    throw new UnsupportedCapabilityError(["session_status"]);
  }

  async stop(_run: Run): Promise<void> {
    throw new UnsupportedCapabilityError(["session_interrupt"]);
  }
}
