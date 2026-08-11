package pickup

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/JarenKempton/nav/internal/contracts"
	"github.com/JarenKempton/nav/internal/domain"
)

type ids struct{}

func (ids) Run() domain.RunRef     { return "nav-run:test" }
func (ids) Claim() domain.ClaimRef { return "nav-claim:test" }

type clock struct{}

func (clock) Now() time.Time { return time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC) }

type ledger struct {
	failOn string
	steps  []string
}

func (l *ledger) SaveRun(context.Context, domain.Run) error {
	if l.failOn == "save" {
		return errors.New("save failed")
	}
	return nil
}
func (l *ledger) RecordStep(_ context.Context, _ domain.RunRef, state string, _ any, _ error) error {
	l.steps = append(l.steps, state)
	if l.failOn == state {
		return errors.New("step failed")
	}
	return nil
}

type tracker struct {
	restoreErr, verifyRestoreErr error
	restored                     bool
}

func (*tracker) Describe(context.Context) (domain.CapabilitySet, error) {
	return domain.NewCapabilities("conditional_update"), nil
}
func (*tracker) Preflight(context.Context, domain.TicketRef) error { return nil }
func (*tracker) GetTicket(context.Context, domain.TicketRef) (domain.Ticket, error) {
	return domain.Ticket{Ref: "jira:x:W:ticket:A", State: domain.TicketOpen, Status: "To Do"}, nil
}
func (*tracker) SnapshotClaimState(context.Context, domain.TicketRef) (domain.TrackerSnapshot, error) {
	return domain.TrackerSnapshot{Version: "1", Payload: []byte(`{}`)}, nil
}
func (*tracker) Claim(context.Context, contracts.ClaimRequest) error       { return nil }
func (*tracker) VerifyClaim(context.Context, contracts.ClaimRequest) error { return nil }
func (t *tracker) RestoreClaimState(context.Context, domain.TicketRef, domain.TrackerSnapshot) error {
	t.restored = true
	return t.restoreErr
}
func (t *tracker) VerifyRestored(context.Context, domain.TicketRef, domain.TrackerSnapshot) error {
	return t.verifyRestoreErr
}
func (*tracker) RenewLease(context.Context, domain.ClaimRef, time.Time) error { return nil }
func (*tracker) ReleaseClaim(context.Context, domain.ClaimRef) error          { return nil }

type workspace struct{ prepareErr error }

func (*workspace) Preflight(context.Context, domain.Ticket) error { return nil }
func (*workspace) Plan(context.Context, domain.Ticket) (contracts.WorkspacePlan, error) {
	return contracts.WorkspacePlan{Path: "/work", Branch: "task/A"}, nil
}
func (w *workspace) Prepare(context.Context, contracts.WorkspacePlan) (domain.PreparedWorkspace, error) {
	return domain.PreparedWorkspace{Path: "/work", Branch: "task/A"}, w.prepareErr
}

type harness struct {
	launchErr error
	stopped   bool
}

func (*harness) Describe(context.Context) (domain.CapabilitySet, error) {
	return domain.NewCapabilities("process_launch"), nil
}
func (*harness) Preflight(context.Context, contracts.LaunchRequest) error { return nil }
func (h *harness) Launch(context.Context, contracts.LaunchRequest) (contracts.LaunchReceipt, error) {
	return contracts.LaunchReceipt{SessionID: "s", Tier: "launch"}, h.launchErr
}
func (h *harness) Stop(context.Context, contracts.LaunchReceipt) error { h.stopped = true; return nil }

func coordinator(tk *tracker, ws *workspace, h *harness, l *ledger) Coordinator {
	return Coordinator{Tracker: tk, Workspace: ws, Harness: h, Ledger: l, IDs: ids{}, Clock: clock{}}
}

func TestExecuteCommits(t *testing.T) {
	receipt, err := coordinator(&tracker{}, &workspace{}, &harness{}, &ledger{}).Execute(context.Background(), Request{Ticket: "jira:x:W:ticket:A", Owner: "human", Harness: "codex"})
	if err != nil || !receipt.OK || receipt.State != StateCommitted {
		t.Fatalf("receipt=%#v err=%v", receipt, err)
	}
}

func TestWorkspaceFailureCompensates(t *testing.T) {
	tk := &tracker{}
	receipt, err := coordinator(tk, &workspace{prepareErr: errors.New("prepare failed")}, &harness{}, &ledger{}).Execute(context.Background(), Request{Ticket: "jira:x:W:ticket:A", Owner: "human", Harness: "codex"})
	if err == nil || receipt.State != StateCompensated || !tk.restored {
		t.Fatalf("receipt=%#v err=%v", receipt, err)
	}
}

func TestAmbiguousRestoreRequiresRecovery(t *testing.T) {
	tk := &tracker{verifyRestoreErr: errors.New("cannot verify")}
	receipt, err := coordinator(tk, &workspace{prepareErr: errors.New("prepare failed")}, &harness{}, &ledger{}).Execute(context.Background(), Request{Ticket: "jira:x:W:ticket:A", Owner: "human", Harness: "codex"})
	if err == nil || receipt.State != StateRecoveryRequired || receipt.RecoveryCommand != "nav recover nav-run:test" {
		t.Fatalf("receipt=%#v err=%v", receipt, err)
	}
}

func TestLaunchFailureStopsPartialSessionAndCompensates(t *testing.T) {
	h := &harness{launchErr: errors.New("launch failed")}
	tk := &tracker{}
	receipt, err := coordinator(tk, &workspace{}, h, &ledger{}).Execute(context.Background(), Request{Ticket: "jira:x:W:ticket:A", Owner: "human", Harness: "codex"})
	if err == nil || receipt.State != StateCompensated || !h.stopped || !tk.restored {
		t.Fatalf("receipt=%#v stopped=%v err=%v", receipt, h.stopped, err)
	}
}
