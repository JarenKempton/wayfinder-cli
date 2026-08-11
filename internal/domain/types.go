package domain

import (
	"encoding/json"
	"time"
)

type TrackerRef string
type WorkspaceRef string
type GroupRef string
type MapRef string
type TicketRef string
type RunRef string
type ClaimRef string
type ActorRef string
type AdapterRef string

type Capability string
type CapabilitySet map[Capability]bool

func NewCapabilities(values ...Capability) CapabilitySet {
	set := make(CapabilitySet, len(values))
	for _, value := range values {
		set[value] = true
	}
	return set
}

func (s CapabilitySet) Has(value Capability) bool { return s[value] }

func (s CapabilitySet) Missing(required CapabilitySet) []Capability {
	missing := make([]Capability, 0)
	for capability := range required {
		if !s.Has(capability) {
			missing = append(missing, capability)
		}
	}
	return missing
}

type RepositorySpec struct {
	Name         string `json:"name"`
	Remote       string `json:"remote"`
	Path         string `json:"path"`
	WorktreeRoot string `json:"worktree_root"`
	BaseBranch   string `json:"base_branch"`
}

type PolicySet map[string]json.RawMessage
type NativeReference struct {
	ID  string `json:"id"`
	URL string `json:"url,omitempty"`
}

type Workspace struct {
	Ref          WorkspaceRef    `json:"ref"`
	Tracker      TrackerRef      `json:"tracker"`
	Repository   *RepositorySpec `json:"repository,omitempty"`
	Policies     PolicySet       `json:"policies,omitempty"`
	Capabilities CapabilitySet   `json:"capabilities"`
}

type WorkGroup struct {
	Ref    GroupRef        `json:"ref"`
	Parent *GroupRef       `json:"parent,omitempty"`
	Maps   []MapRef        `json:"maps"`
	Native NativeReference `json:"native"`
}

type Map struct {
	Ref     MapRef          `json:"ref"`
	Group   *GroupRef       `json:"group,omitempty"`
	Tickets []TicketRef     `json:"tickets"`
	Order   int             `json:"order"`
	Native  NativeReference `json:"native"`
}

type TicketKind string

const (
	TicketTask      TicketKind = "task"
	TicketResearch  TicketKind = "research"
	TicketPrototype TicketKind = "prototype"
	TicketDecision  TicketKind = "decision"
)

type TicketState string

const (
	TicketOpen   TicketState = "open"
	TicketClosed TicketState = "closed"
)

type DependencyKind string

const DependencyBlocks DependencyKind = "blocks"

type Dependency struct {
	Blocking TicketRef      `json:"blocking"`
	Blocked  TicketRef      `json:"blocked"`
	Kind     DependencyKind `json:"kind"`
}

type Ticket struct {
	Ref          TicketRef      `json:"ref"`
	Map          MapRef         `json:"map"`
	Group        *GroupRef      `json:"group,omitempty"`
	Kind         TicketKind     `json:"kind"`
	State        TicketState    `json:"state"`
	Status       string         `json:"status"`
	Assignee     *ActorRef      `json:"assignee,omitempty"`
	Dependencies []Dependency   `json:"dependencies,omitempty"`
	Order        int            `json:"order"`
	Priority     int            `json:"priority,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
}

type TrackerSnapshot struct {
	Version string          `json:"version"`
	Payload json.RawMessage `json:"payload"`
}

type ClaimStatus string

const (
	ClaimActive   ClaimStatus = "active"
	ClaimStale    ClaimStatus = "stale"
	ClaimReleased ClaimStatus = "released"
)

type Claim struct {
	Ref            ClaimRef        `json:"ref"`
	Ticket         TicketRef       `json:"ticket"`
	HumanOwner     ActorRef        `json:"human_owner"`
	Run            RunRef          `json:"run"`
	PreviousState  TrackerSnapshot `json:"previous_state"`
	ClaimedAt      time.Time       `json:"claimed_at"`
	LeaseExpiresAt time.Time       `json:"lease_expires_at"`
	Status         ClaimStatus     `json:"status"`
}

type RunStatus string

const (
	RunPlanning          RunStatus = "planning"
	RunActive            RunStatus = "active"
	RunStopped           RunStatus = "stopped"
	RunAttentionRequired RunStatus = "attention_required"
	RunRecoveryRequired  RunStatus = "recovery_required"
)

type PreparedWorkspace struct {
	Path   string `json:"path"`
	Branch string `json:"branch,omitempty"`
}

type Run struct {
	Ref          RunRef            `json:"ref"`
	Ticket       TicketRef         `json:"ticket"`
	Harness      AdapterRef        `json:"harness"`
	Model        *string           `json:"model,omitempty"`
	Workspace    PreparedWorkspace `json:"workspace"`
	Capabilities CapabilitySet     `json:"capabilities"`
	Status       RunStatus         `json:"status"`
	CreatedAt    time.Time         `json:"created_at"`
	UpdatedAt    time.Time         `json:"updated_at"`
}
