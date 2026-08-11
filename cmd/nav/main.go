package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/JarenKempton/nav/internal/adapters"
	"github.com/JarenKempton/nav/internal/app"
	"github.com/JarenKempton/nav/internal/domain"
	"github.com/JarenKempton/nav/internal/frontier"
	"github.com/JarenKempton/nav/internal/protocol"
	"github.com/JarenKempton/nav/internal/state"
)

const version = "0.1.0-dev"

func main() {
	if err := run(context.Background(), os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "nav:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		usage(stdout)
		return nil
	}
	switch args[0] {
	case "help", "--help", "-h":
		usage(stdout)
		return nil
	case "version", "--version":
		fmt.Fprintln(stdout, version)
		return nil
	case "doctor":
		return doctor(stdout)
	case "resolve":
		return resolve(args[1:], stdout)
	case "frontier":
		return frontierCommand(args[1:], stdout)
	case "adapter":
		return adapterCommand(ctx, args[1:], stdout)
	case "runs":
		return runsCommand(ctx, args[1:], stdout)
	case "pickup", "claim", "recover", "resume", "stop", "workspace", "supervisor", "init", "config":
		return fmt.Errorf("%s is reserved by the stable contract but is not implemented safely in this pre-release", args[0])
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func usage(w io.Writer) {
	fmt.Fprintln(w, `Nav — portable work orchestration for agents

Usage:
  nav doctor
  nav resolve <qualified-reference>
  nav frontier --input <tickets.json> [--scope <ref>] [--available "To Do,Open"] [--json]
  nav adapter list [--json]
  nav adapter describe <name> [--json]
  nav adapter test <executable>
  nav runs list [--json]
  nav runs show <run-id>
  nav runs export <run-id>
  nav version`)
}

func doctor(w io.Writer) error {
	path, err := app.DatabasePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	store, err := state.Open(path)
	if err != nil {
		return err
	}
	defer store.Close()
	report := map[string]any{"ok": true, "version": version, "protocol_version": protocol.Version, "database": path, "adapters": len(adapters.Builtins())}
	return writeJSON(w, report)
}

func resolve(args []string, w io.Writer) error {
	if len(args) != 1 {
		return errors.New("resolve requires exactly one reference")
	}
	ref, err := domain.ParseRef(args[0])
	if err != nil {
		return err
	}
	return writeJSON(w, ref)
}

func frontierCommand(args []string, w io.Writer) error {
	set := flag.NewFlagSet("frontier", flag.ContinueOnError)
	set.SetOutput(io.Discard)
	input := set.String("input", "", "ticket input JSON")
	scopeValue := set.String("scope", "", "qualified scope")
	available := set.String("available", "To Do,Open", "available statuses")
	jsonOutput := set.Bool("json", false, "JSON output")
	if err := set.Parse(args); err != nil {
		return err
	}
	if *input == "" {
		return errors.New("frontier currently requires --input with normalized ticket JSON")
	}
	payload, err := os.ReadFile(filepath.Clean(*input))
	if err != nil {
		return err
	}
	var tickets []domain.Ticket
	if err := json.Unmarshal(payload, &tickets); err != nil {
		return fmt.Errorf("decode tickets: %w", err)
	}
	scope, err := parseScope(*scopeValue)
	if err != nil {
		return err
	}
	statuses := map[string]bool{}
	for _, value := range strings.Split(*available, ",") {
		statuses[strings.TrimSpace(value)] = true
	}
	result, err := frontier.Evaluate(tickets, scope, frontier.Options{AvailableStatuses: statuses})
	if err != nil {
		return err
	}
	if *jsonOutput {
		return writeJSON(w, map[string]any{"tickets": result, "count": len(result)})
	}
	for _, ticket := range result {
		fmt.Fprintf(w, "%s\t%s\t%s\n", ticket.Ref, ticket.Kind, ticket.Status)
	}
	return nil
}

func parseScope(raw string) (frontier.Scope, error) {
	var scope frontier.Scope
	if raw == "" {
		return scope, nil
	}
	parsed, err := domain.ParseRef(raw)
	if err != nil {
		return scope, err
	}
	switch parsed.Kind {
	case domain.RefWorkspace:
		value := domain.WorkspaceRef(raw)
		scope.Workspace = &value
	case domain.RefGroup:
		value := domain.GroupRef(raw)
		scope.Group = &value
	case domain.RefMap:
		value := domain.MapRef(raw)
		scope.Map = &value
	case domain.RefTicket:
		value := domain.TicketRef(raw)
		scope.Ticket = &value
	default:
		return scope, fmt.Errorf("%s is not a frontier scope", raw)
	}
	return scope, nil
}

func adapterCommand(ctx context.Context, args []string, w io.Writer) error {
	if len(args) == 0 {
		return errors.New("adapter requires list, describe, or test")
	}
	switch args[0] {
	case "list":
		return writeJSON(w, adapters.Builtins())
	case "describe":
		if len(args) != 2 {
			return errors.New("adapter describe requires a name")
		}
		descriptor, err := adapters.Find(args[1])
		if err != nil {
			return err
		}
		return writeJSON(w, descriptor)
	case "test":
		if len(args) != 2 {
			return errors.New("adapter test requires an executable path")
		}
		description, err := (protocol.Client{Path: args[1]}).Initialize(ctx, "tracker", "conformance:test", version)
		if err != nil {
			return err
		}
		return writeJSON(w, map[string]any{"ok": true, "adapter": description})
	default:
		return fmt.Errorf("unknown adapter command %q", args[0])
	}
}

func runsCommand(ctx context.Context, args []string, w io.Writer) error {
	if len(args) == 0 {
		return errors.New("runs requires list, show, or export")
	}
	path, err := app.DatabasePath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	store, err := state.Open(path)
	if err != nil {
		return err
	}
	defer store.Close()
	switch args[0] {
	case "list":
		runs, err := store.ListRuns(ctx)
		if err != nil {
			return err
		}
		return writeJSON(w, runs)
	case "show", "export":
		if len(args) != 2 {
			return fmt.Errorf("runs %s requires a run reference", args[0])
		}
		ref := args[1]
		if !strings.HasPrefix(ref, "nav-run:") {
			ref = "nav-run:" + ref
		}
		run, err := store.Run(ctx, domain.RunRef(ref))
		if err != nil {
			return err
		}
		return writeJSON(w, run)
	default:
		return fmt.Errorf("unknown runs command %q", args[0])
	}
}

func writeJSON(w io.Writer, value any) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
