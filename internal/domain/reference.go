package domain

import (
	"fmt"
	"strings"
)

type RefKind string

const (
	RefTracker   RefKind = "tracker"
	RefWorkspace RefKind = "workspace"
	RefGroup     RefKind = "group"
	RefMap       RefKind = "map"
	RefTicket    RefKind = "ticket"
	RefRun       RefKind = "run"
	RefClaim     RefKind = "claim"
)

type ParsedRef struct {
	Kind      RefKind
	Adapter   string
	Instance  string
	Workspace string
	NativeID  string
	Raw       string
}

func ParseRef(raw string) (ParsedRef, error) {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "nav-run:") {
		if len(strings.TrimPrefix(raw, "nav-run:")) == 0 {
			return ParsedRef{}, fmt.Errorf("run reference is missing an id")
		}
		return ParsedRef{Kind: RefRun, NativeID: strings.TrimPrefix(raw, "nav-run:"), Raw: raw}, nil
	}
	if strings.HasPrefix(raw, "nav-claim:") {
		if len(strings.TrimPrefix(raw, "nav-claim:")) == 0 {
			return ParsedRef{}, fmt.Errorf("claim reference is missing an id")
		}
		return ParsedRef{Kind: RefClaim, NativeID: strings.TrimPrefix(raw, "nav-claim:"), Raw: raw}, nil
	}
	parts := strings.Split(raw, ":")
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return ParsedRef{}, fmt.Errorf("invalid qualified reference %q", raw)
	}
	ref := ParsedRef{Kind: RefTracker, Adapter: parts[0], Instance: parts[1], Raw: raw}
	if len(parts) == 2 {
		return ref, nil
	}
	if parts[2] == "" {
		return ParsedRef{}, fmt.Errorf("workspace id is empty")
	}
	ref.Kind, ref.Workspace = RefWorkspace, parts[2]
	if len(parts) == 3 {
		return ref, nil
	}
	if len(parts) != 5 {
		return ParsedRef{}, fmt.Errorf("reference must end in group, map, or ticket plus native id")
	}
	switch parts[3] {
	case "group":
		ref.Kind = RefGroup
	case "map":
		ref.Kind = RefMap
	case "ticket":
		ref.Kind = RefTicket
	default:
		return ParsedRef{}, fmt.Errorf("unknown reference kind %q", parts[3])
	}
	if parts[4] == "" {
		return ParsedRef{}, fmt.Errorf("native id is empty")
	}
	ref.NativeID = parts[4]
	return ref, nil
}
