import type { ConfigurationPlatformOptions } from "./configuration/project-files.ts";
import type {
  RecoveryVerification,
  RunLifecycleAdapter,
  TrackerAdapter,
} from "./domain/contracts.ts";
import type { Claim, Run, RunObservation } from "./domain/model.ts";
import type {
  StatusRepairReceiptStore,
  StatusRepairService,
} from "./reconciliation/status-repair.ts";
export interface RuntimeServices {
  configuration?: ConfigurationPlatformOptions;
  tracker?: TrackerAdapter;
  lifecycle?(run: Run): RunLifecycleAdapter;
  statePath?: string;
  now?: () => Date;
  verifyRecovery?(run: Run, evidence: unknown): Promise<RecoveryVerification>;
  verifyAttention?(
    run: Run,
    evidence: unknown,
  ): Promise<{ observation: RunObservation; claim: Claim }>;
  statusRepair?: StatusRepairService;
  statusRepairReceipts?: StatusRepairReceiptStore;
}
