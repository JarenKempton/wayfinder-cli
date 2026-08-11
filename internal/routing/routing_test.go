package routing

import "testing"

func TestResolvePrecedence(t *testing.T) {
	got := Resolve(Execution{Harness: "codex", Model: "default"}, Execution{Model: "map"}, Execution{Harness: "t3"})
	if got.Harness != "t3" || got.Model != "map" {
		t.Fatalf("unexpected routing: %#v", got)
	}
}
