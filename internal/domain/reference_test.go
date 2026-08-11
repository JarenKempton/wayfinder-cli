package domain

import "testing"

func TestParseRef(t *testing.T) {
	tests := []struct {
		raw  string
		kind RefKind
	}{
		{"jira:responsibid", RefTracker},
		{"jira:responsibid:JWB", RefWorkspace},
		{"jira:responsibid:JWB:group:JWB-150", RefGroup},
		{"jira:responsibid:JWB:map:JWB-239", RefMap},
		{"jira:responsibid:JWB:ticket:JWB-245", RefTicket},
		{"nav-run:018f", RefRun}, {"nav-claim:018f", RefClaim},
	}
	for _, test := range tests {
		parsed, err := ParseRef(test.raw)
		if err != nil {
			t.Fatalf("%s: %v", test.raw, err)
		}
		if parsed.Kind != test.kind {
			t.Errorf("%s: got %s", test.raw, parsed.Kind)
		}
	}
}

func TestParseRefRejectsAmbiguousValues(t *testing.T) {
	for _, raw := range []string{"JWB-245", "jira:", "jira:x:y:map", "jira:x:y:other:z", "nav-run:"} {
		if _, err := ParseRef(raw); err == nil {
			t.Errorf("expected %q to fail", raw)
		}
	}
}

func TestCapabilitiesMissing(t *testing.T) {
	have := NewCapabilities("a", "b")
	missing := have.Missing(NewCapabilities("b", "c"))
	if len(missing) != 1 || missing[0] != "c" {
		t.Fatalf("unexpected missing set: %v", missing)
	}
}
