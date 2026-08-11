package contracts

import (
	"context"
	"time"

	"github.com/JarenKempton/nav/internal/domain"
)

type ClaimRequest struct {
	Claim           domain.ClaimRef
	Run             domain.RunRef
	Ticket          domain.TicketRef
	Owner           domain.ActorRef
	LeaseExpiresAt  time.Time
	ExpectedVersion string
}

type Tracker interface {
	Describe(context.Context) (domain.CapabilitySet, error)
	Preflight(context.Context, domain.TicketRef) error
	GetTicket(context.Context, domain.TicketRef) (domain.Ticket, error)
	SnapshotClaimState(context.Context, domain.TicketRef) (domain.TrackerSnapshot, error)
	Claim(context.Context, ClaimRequest) error
	VerifyClaim(context.Context, ClaimRequest) error
	RestoreClaimState(context.Context, domain.TicketRef, domain.TrackerSnapshot) error
	VerifyRestored(context.Context, domain.TicketRef, domain.TrackerSnapshot) error
	RenewLease(context.Context, domain.ClaimRef, time.Time) error
	ReleaseClaim(context.Context, domain.ClaimRef) error
}

type WorkspacePlan struct {
	Ticket domain.TicketRef `json:"ticket"`
	Path   string           `json:"path"`
	Branch string           `json:"branch"`
}

type Workspace interface {
	Preflight(context.Context, domain.Ticket) error
	Plan(context.Context, domain.Ticket) (WorkspacePlan, error)
	Prepare(context.Context, WorkspacePlan) (domain.PreparedWorkspace, error)
}

type LaunchRequest struct {
	Run       domain.RunRef
	Ticket    domain.Ticket
	Workspace domain.PreparedWorkspace
	Model     string
	Effort    string
}

type LaunchReceipt struct {
	SessionID string `json:"session_id,omitempty"`
	PID       int    `json:"pid,omitempty"`
	Tier      string `json:"tier"`
}

type Harness interface {
	Describe(context.Context) (domain.CapabilitySet, error)
	Preflight(context.Context, LaunchRequest) error
	Launch(context.Context, LaunchRequest) (LaunchReceipt, error)
	Stop(context.Context, LaunchReceipt) error
}

type Ledger interface {
	SaveRun(context.Context, domain.Run) error
	RecordStep(context.Context, domain.RunRef, string, any, error) error
}
