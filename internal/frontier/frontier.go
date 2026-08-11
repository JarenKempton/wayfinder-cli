package frontier

import (
	"fmt"
	"sort"

	"github.com/JarenKempton/nav/internal/domain"
)

type Scope struct {
	Workspace *domain.WorkspaceRef
	Group     *domain.GroupRef
	Map       *domain.MapRef
	Ticket    *domain.TicketRef
}

type Options struct {
	AvailableStatuses  map[string]bool
	IncludeStaleClaims bool
}

func Evaluate(tickets []domain.Ticket, scope Scope, options Options) ([]domain.Ticket, error) {
	byRef := make(map[domain.TicketRef]domain.Ticket, len(tickets))
	for _, ticket := range tickets {
		byRef[ticket.Ref] = ticket
	}
	eligible := make([]domain.Ticket, 0)
	for _, ticket := range tickets {
		if !inScope(ticket, scope) || ticket.State != domain.TicketOpen || !options.AvailableStatuses[ticket.Status] || ticket.Assignee != nil {
			continue
		}
		blocked := false
		for _, dependency := range ticket.Dependencies {
			if dependency.Blocked != ticket.Ref {
				continue
			}
			blocker, ok := byRef[dependency.Blocking]
			if !ok {
				return nil, fmt.Errorf("ticket %s references unknown blocker %s", ticket.Ref, dependency.Blocking)
			}
			if blocker.State != domain.TicketClosed {
				blocked = true
				break
			}
		}
		if !blocked {
			eligible = append(eligible, ticket)
		}
	}
	sort.SliceStable(eligible, func(i, j int) bool {
		if eligible[i].Order == eligible[j].Order {
			return eligible[i].Ref < eligible[j].Ref
		}
		return eligible[i].Order < eligible[j].Order
	})
	return eligible, nil
}

func inScope(ticket domain.Ticket, scope Scope) bool {
	if scope.Ticket != nil {
		return ticket.Ref == *scope.Ticket
	}
	if scope.Map != nil {
		return ticket.Map == *scope.Map
	}
	if scope.Group != nil {
		return ticket.Group != nil && *ticket.Group == *scope.Group
	}
	return true
}

func Select(tickets []domain.Ticket, policy string) (domain.Ticket, error) {
	if len(tickets) == 0 {
		return domain.Ticket{}, fmt.Errorf("frontier is empty")
	}
	switch policy {
	case "first":
		return tickets[0], nil
	case "highest-priority":
		selected := tickets[0]
		for _, ticket := range tickets[1:] {
			if ticket.Priority > selected.Priority {
				selected = ticket
			}
		}
		return selected, nil
	default:
		return domain.Ticket{}, fmt.Errorf("unknown or missing noninteractive selection policy %q", policy)
	}
}
