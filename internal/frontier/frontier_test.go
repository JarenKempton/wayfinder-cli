package frontier

import (
	"github.com/JarenKempton/nav/internal/domain"
	"testing"
)

func ref(value string) domain.TicketRef { return domain.TicketRef(value) }

func TestEvaluateCrossMapDependenciesAndOrder(t *testing.T) {
	a := domain.Ticket{Ref: ref("jira:x:W:ticket:A"), Map: "jira:x:W:map:M1", State: domain.TicketOpen, Status: "To Do", Order: 2}
	b := domain.Ticket{Ref: ref("jira:x:W:ticket:B"), Map: "jira:x:W:map:M2", State: domain.TicketOpen, Status: "To Do", Order: 1, Dependencies: []domain.Dependency{{Blocking: a.Ref, Blocked: ref("jira:x:W:ticket:B"), Kind: domain.DependencyBlocks}}}
	c := domain.Ticket{Ref: ref("jira:x:W:ticket:C"), Map: "jira:x:W:map:M2", State: domain.TicketOpen, Status: "To Do", Order: 0}
	result, err := Evaluate([]domain.Ticket{a, b, c}, Scope{}, Options{AvailableStatuses: map[string]bool{"To Do": true}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 2 || result[0].Ref != c.Ref || result[1].Ref != a.Ref {
		t.Fatalf("unexpected frontier: %#v", result)
	}
}

func TestClosedBlockerUnblocksAndAssigneeExcludes(t *testing.T) {
	owner := domain.ActorRef("human")
	a := domain.Ticket{Ref: ref("jira:x:W:ticket:A"), State: domain.TicketClosed, Status: "Done"}
	b := domain.Ticket{Ref: ref("jira:x:W:ticket:B"), State: domain.TicketOpen, Status: "To Do", Dependencies: []domain.Dependency{{Blocking: a.Ref, Blocked: ref("jira:x:W:ticket:B")}}}
	c := domain.Ticket{Ref: ref("jira:x:W:ticket:C"), State: domain.TicketOpen, Status: "To Do", Assignee: &owner}
	result, err := Evaluate([]domain.Ticket{a, b, c}, Scope{}, Options{AvailableStatuses: map[string]bool{"To Do": true}})
	if err != nil || len(result) != 1 || result[0].Ref != b.Ref {
		t.Fatalf("result=%v err=%v", result, err)
	}
}

func TestUnknownBlockerFailsClosed(t *testing.T) {
	ticket := domain.Ticket{Ref: ref("jira:x:W:ticket:B"), State: domain.TicketOpen, Status: "To Do", Dependencies: []domain.Dependency{{Blocking: ref("jira:x:W:ticket:A"), Blocked: ref("jira:x:W:ticket:B")}}}
	if _, err := Evaluate([]domain.Ticket{ticket}, Scope{}, Options{AvailableStatuses: map[string]bool{"To Do": true}}); err == nil {
		t.Fatal("expected missing blocker error")
	}
}

func TestSelectRequiresExplicitPolicy(t *testing.T) {
	tickets := []domain.Ticket{{Ref: "a", Priority: 1}, {Ref: "b", Priority: 5}}
	if _, err := Select(tickets, ""); err == nil {
		t.Fatal("expected policy error")
	}
	selected, err := Select(tickets, "highest-priority")
	if err != nil || selected.Ref != "b" {
		t.Fatalf("selected=%v err=%v", selected, err)
	}
}
