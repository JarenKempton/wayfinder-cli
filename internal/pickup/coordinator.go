package pickup

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/JarenKempton/nav/internal/contracts"
	"github.com/JarenKempton/nav/internal/domain"
)

type State string

const (
	StatePlanning          State = "planning"
	StateClaimed           State = "claimed"
	StateWorkspacePrepared State = "workspace_prepared"
	StateLaunched          State = "launched"
	StateCommitted         State = "committed"
	StateCompensating      State = "compensating"
	StateCompensated       State = "compensated"
	StateRecoveryRequired  State = "recovery_required"
)

type IDFactory interface {
	Run() domain.RunRef
	Claim() domain.ClaimRef
}
type Clock interface{ Now() time.Time }

type Coordinator struct {
	Tracker       contracts.Tracker
	Workspace     contracts.Workspace
	Harness       contracts.Harness
	Ledger        contracts.Ledger
	IDs           IDFactory
	Clock         Clock
	LeaseDuration time.Duration
}

type Request struct {
	Ticket  domain.TicketRef
	Owner   domain.ActorRef
	Harness domain.AdapterRef
	Model   string
	Effort  string
}

type Receipt struct {
	OK              bool                     `json:"ok"`
	State           State                    `json:"state"`
	Run             domain.RunRef            `json:"run"`
	Claim           domain.ClaimRef          `json:"claim"`
	Ticket          domain.TicketRef         `json:"ticket"`
	Workspace       domain.PreparedWorkspace `json:"workspace,omitempty"`
	Launch          contracts.LaunchReceipt  `json:"launch,omitempty"`
	RecoveryCommand string                   `json:"recovery_command,omitempty"`
}

type ResultError struct {
	Receipt Receipt
	Cause   error
}

func (e *ResultError) Error() string {
	return fmt.Sprintf("pickup ended in %s: %v", e.Receipt.State, e.Cause)
}
func (e *ResultError) Unwrap() error { return e.Cause }

func (c Coordinator) Execute(ctx context.Context, request Request) (Receipt, error) {
	if c.Tracker == nil || c.Workspace == nil || c.Harness == nil || c.Ledger == nil || c.IDs == nil || c.Clock == nil {
		return Receipt{}, errors.New("pickup coordinator is incomplete")
	}
	if request.Ticket == "" || request.Owner == "" || request.Harness == "" {
		return Receipt{}, errors.New("ticket, owner, and harness are required")
	}
	leaseDuration := c.LeaseDuration
	if leaseDuration == 0 {
		leaseDuration = 15 * time.Minute
	}
	runRef, claimRef := c.IDs.Run(), c.IDs.Claim()
	receipt := Receipt{State: StatePlanning, Run: runRef, Claim: claimRef, Ticket: request.Ticket}
	now := c.Clock.Now().UTC()
	run := domain.Run{Ref: runRef, Ticket: request.Ticket, Harness: request.Harness, Status: domain.RunPlanning, CreatedAt: now, UpdatedAt: now, Capabilities: domain.NewCapabilities()}
	if err := c.Ledger.SaveRun(ctx, run); err != nil {
		return receipt, err
	}
	if err := c.Ledger.RecordStep(ctx, runRef, string(StatePlanning), receipt, nil); err != nil {
		return receipt, err
	}

	ticket, err := c.Tracker.GetTicket(ctx, request.Ticket)
	if err != nil {
		return receipt, err
	}
	if ticket.State != domain.TicketOpen || ticket.Assignee != nil {
		return receipt, errors.New("ticket is not claimable")
	}
	if _, err := c.Tracker.Describe(ctx); err != nil {
		return receipt, err
	}
	if err := c.Tracker.Preflight(ctx, request.Ticket); err != nil {
		return receipt, err
	}
	if err := c.Workspace.Preflight(ctx, ticket); err != nil {
		return receipt, err
	}
	plan, err := c.Workspace.Plan(ctx, ticket)
	if err != nil {
		return receipt, err
	}
	launchRequest := contracts.LaunchRequest{Run: runRef, Ticket: ticket, Workspace: domain.PreparedWorkspace{Path: plan.Path, Branch: plan.Branch}, Model: request.Model, Effort: request.Effort}
	if _, err := c.Harness.Describe(ctx); err != nil {
		return receipt, err
	}
	if err := c.Harness.Preflight(ctx, launchRequest); err != nil {
		return receipt, err
	}

	snapshot, err := c.Tracker.SnapshotClaimState(ctx, request.Ticket)
	if err != nil {
		return receipt, err
	}
	claimRequest := contracts.ClaimRequest{Claim: claimRef, Run: runRef, Ticket: request.Ticket, Owner: request.Owner, LeaseExpiresAt: now.Add(leaseDuration), ExpectedVersion: snapshot.Version}
	if err := c.Tracker.Claim(ctx, claimRequest); err != nil {
		return receipt, err
	}
	if err := c.Tracker.VerifyClaim(ctx, claimRequest); err != nil {
		return c.compensate(ctx, receipt, snapshot, contracts.LaunchReceipt{}, err)
	}
	receipt.State = StateClaimed
	if err := c.Ledger.RecordStep(ctx, runRef, string(StateClaimed), receipt, nil); err != nil {
		return c.compensate(ctx, receipt, snapshot, contracts.LaunchReceipt{}, err)
	}

	prepared, err := c.Workspace.Prepare(ctx, plan)
	if err != nil {
		return c.compensate(ctx, receipt, snapshot, contracts.LaunchReceipt{}, err)
	}
	receipt.State, receipt.Workspace = StateWorkspacePrepared, prepared
	if err := c.Ledger.RecordStep(ctx, runRef, string(StateWorkspacePrepared), receipt, nil); err != nil {
		return c.compensate(ctx, receipt, snapshot, contracts.LaunchReceipt{}, err)
	}
	launchRequest.Workspace = prepared
	launchReceipt, err := c.Harness.Launch(ctx, launchRequest)
	if err != nil {
		return c.compensate(ctx, receipt, snapshot, launchReceipt, err)
	}
	receipt.State, receipt.Launch = StateLaunched, launchReceipt
	if err := c.Ledger.RecordStep(ctx, runRef, string(StateLaunched), receipt, nil); err != nil {
		return c.compensate(ctx, receipt, snapshot, launchReceipt, err)
	}

	run.Workspace, run.Status, run.UpdatedAt = prepared, domain.RunActive, c.Clock.Now().UTC()
	if request.Model != "" {
		run.Model = &request.Model
	}
	if err := c.Ledger.SaveRun(ctx, run); err != nil {
		return c.compensate(ctx, receipt, snapshot, launchReceipt, err)
	}
	receipt.OK, receipt.State = true, StateCommitted
	if err := c.Ledger.RecordStep(ctx, runRef, string(StateCommitted), receipt, nil); err != nil {
		return c.compensate(ctx, receipt, snapshot, launchReceipt, err)
	}
	return receipt, nil
}

func (c Coordinator) compensate(ctx context.Context, receipt Receipt, snapshot domain.TrackerSnapshot, launch contracts.LaunchReceipt, cause error) (Receipt, error) {
	receipt.OK, receipt.State = false, StateCompensating
	_ = c.Ledger.RecordStep(ctx, receipt.Run, string(StateCompensating), receipt, cause)
	if launch.SessionID != "" || launch.PID != 0 {
		_ = c.Harness.Stop(ctx, launch)
	}
	restoreErr := c.Tracker.RestoreClaimState(ctx, receipt.Ticket, snapshot)
	verifyErr := error(nil)
	if restoreErr == nil {
		verifyErr = c.Tracker.VerifyRestored(ctx, receipt.Ticket, snapshot)
	}
	if restoreErr == nil && verifyErr == nil {
		receipt.State = StateCompensated
		_ = c.Ledger.RecordStep(ctx, receipt.Run, string(StateCompensated), receipt, cause)
		return receipt, &ResultError{Receipt: receipt, Cause: cause}
	}
	receipt.State = StateRecoveryRequired
	receipt.RecoveryCommand = "nav recover " + string(receipt.Run)
	combined := errors.Join(cause, restoreErr, verifyErr)
	_ = c.Ledger.RecordStep(ctx, receipt.Run, string(StateRecoveryRequired), receipt, combined)
	return receipt, &ResultError{Receipt: receipt, Cause: combined}
}
