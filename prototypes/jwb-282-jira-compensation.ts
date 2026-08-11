/**
 * PROTOTYPE — JWB-282 disposable Jira claim-compensation probe.
 *
 * Question: after a verified Jira claim and an injected post-claim failure, can
 * compensation restore assignment, status, Jira revision, and Wayfinder
 * metadata to the exact pre-claim snapshot?
 *
 * This deliberately targets only the disposable JWB-301 fixture. It uses the
 * authenticated Atlassian CLI so credentials never enter arguments or output.
 */

const fixture = "JWB-301";
const baselineLabel = "wayfinder-jwb-282-baseline";
const claimLabel = "wayfinder-jwb-282-active-claim";
const receiptPath = "artifacts/JWB-282-live-receipt.json";

type JiraUser = { accountId: string; displayName: string } | null;

interface Snapshot {
  key: string;
  assignee: JiraUser;
  status: string;
  labels: string[];
  updated: string;
}

interface Receipt {
  question: string;
  fixture: string;
  startedAt: string;
  finishedAt?: string;
  states: Array<{ state: string; snapshot?: Snapshot; detail?: string }>;
  verdict?: {
    serverConditionalClaimProven: boolean;
    exactBusinessStateRestored: boolean;
    exactJiraRevisionRestored: boolean;
    answer: "yes" | "no";
    reason: string;
  };
}

async function acli(args: string[]): Promise<string> {
  const child = Bun.spawn(["acli", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`acli ${args.slice(0, 3).join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout;
}

async function snapshot(): Promise<Snapshot> {
  const raw = await acli([
    "jira",
    "workitem",
    "view",
    fixture,
    "--fields",
    "key,assignee,status,labels,updated",
    "--json",
  ]);
  const issue = JSON.parse(raw) as {
    key: string;
    fields: {
      assignee: JiraUser;
      status: { name: string };
      labels: string[];
      updated: string;
    };
  };
  return {
    key: issue.key,
    assignee: issue.fields.assignee
      ? {
          accountId: issue.fields.assignee.accountId,
          displayName: issue.fields.assignee.displayName,
        }
      : null,
    status: issue.fields.status.name,
    labels: [...issue.fields.labels].sort(),
    updated: issue.fields.updated,
  };
}

async function writeReceipt(receipt: Receipt): Promise<void> {
  await Bun.write(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

function sameBusinessState(left: Snapshot, right: Snapshot): boolean {
  return (
    left.assignee?.accountId === right.assignee?.accountId &&
    left.status === right.status &&
    JSON.stringify(left.labels) === JSON.stringify(right.labels)
  );
}

async function main(): Promise<void> {
  if (!Bun.argv.includes("--execute")) {
    console.log(
      `PROTOTYPE JWB-282\nFixture: ${fixture}\nRun with --execute to mutate and compensate.`,
    );
    return;
  }

  const receipt: Receipt = {
    question:
      "Can Jira restore assignment, status, revision, and Wayfinder metadata exactly after an injected post-claim failure?",
    fixture,
    startedAt: new Date().toISOString(),
    states: [],
  };

  const baseline = await snapshot();
  receipt.states.push({ state: "snapshot", snapshot: baseline });
  if (
    baseline.assignee !== null ||
    baseline.status !== "To Do" ||
    JSON.stringify(baseline.labels) !== JSON.stringify([baselineLabel])
  ) {
    throw new Error(
      `Disposable fixture does not match its approved baseline: ${JSON.stringify(baseline)}`,
    );
  }

  // Re-read immediately before mutation. This is a client-side precondition,
  // not a server-enforced compare-and-swap; the distinction is part of the verdict.
  const precondition = await snapshot();
  if (!sameBusinessState(baseline, precondition) || baseline.updated !== precondition.updated) {
    throw new Error("Fixture changed after snapshot; refusing to claim");
  }
  receipt.states.push({ state: "precondition_verified", snapshot: precondition });

  await acli([
    "jira",
    "workitem",
    "edit",
    "--key",
    fixture,
    "--assignee",
    "@me",
    "--remove-labels",
    baselineLabel,
    "--labels",
    claimLabel,
    "--yes",
  ]);
  await acli([
    "jira",
    "workitem",
    "transition",
    "--key",
    fixture,
    "--status",
    "In Progress",
    "--yes",
  ]);
  const claimed = await snapshot();
  receipt.states.push({ state: "claim_verified", snapshot: claimed });
  if (
    claimed.assignee === null ||
    claimed.status !== "In Progress" ||
    !claimed.labels.includes(claimLabel)
  ) {
    throw new Error(`Claim verification failed: ${JSON.stringify(claimed)}`);
  }

  receipt.states.push({
    state: "post_claim_failure_injected",
    detail: "Intentional JWB-282 probe failure",
  });
  receipt.states.push({ state: "compensating" });

  await acli([
    "jira",
    "workitem",
    "transition",
    "--key",
    fixture,
    "--status",
    baseline.status,
    "--yes",
  ]);
  await acli([
    "jira",
    "workitem",
    "edit",
    "--key",
    fixture,
    "--remove-assignee",
    "--remove-labels",
    claimLabel,
    "--labels",
    baselineLabel,
    "--yes",
  ]);

  const restored = await snapshot();
  receipt.states.push({ state: "restoration_verified", snapshot: restored });
  const exactBusinessStateRestored = sameBusinessState(baseline, restored);
  const exactJiraRevisionRestored = baseline.updated === restored.updated;
  receipt.verdict = {
    serverConditionalClaimProven: false,
    exactBusinessStateRestored,
    exactJiraRevisionRestored,
    answer: "no",
    reason:
      "The CLI surface supports only a read/check/write precondition; claim fields and status require separate writes, and compensation advances Jira's revision instead of restoring it.",
  };
  receipt.finishedAt = new Date().toISOString();
  await writeReceipt(receipt);

  console.log(JSON.stringify(receipt, null, 2));
  if (!exactBusinessStateRestored) {
    throw new Error("Compensation did not restore the reversible business state");
  }
}

await main();
