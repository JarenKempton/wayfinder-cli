package state

import (
	"context"
	"github.com/JarenKempton/nav/internal/domain"
	"path/filepath"
	"testing"
	"time"
)

func TestStoreRunRoundTrip(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "nav.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Now().UTC().Round(0)
	model := "gpt"
	run := domain.Run{Ref: "nav-run:test", Ticket: "jira:x:W:ticket:A", Harness: "codex", Model: &model, Workspace: domain.PreparedWorkspace{Path: "/tmp/work", Branch: "task/A"}, Capabilities: domain.NewCapabilities("process_launch"), Status: domain.RunActive, CreatedAt: now, UpdatedAt: now}
	if err := store.SaveRun(context.Background(), run); err != nil {
		t.Fatal(err)
	}
	got, err := store.Run(context.Background(), run.Ref)
	if err != nil {
		t.Fatal(err)
	}
	if got.Ref != run.Ref || got.Workspace.Branch != run.Workspace.Branch || got.Model == nil || *got.Model != model {
		t.Fatalf("unexpected run: %#v", got)
	}
}
