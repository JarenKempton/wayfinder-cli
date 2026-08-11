package state

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"time"

	"github.com/JarenKempton/nav/internal/domain"
	_ "modernc.org/sqlite"
)

type Store struct{ db *sql.DB }

func Open(path string) (*Store, error) {
	if path == "" {
		return nil, fmt.Errorf("database path is required")
	}
	db, err := sql.Open("sqlite", filepath.Clean(path))
	if err != nil {
		return nil, err
	}
	for _, statement := range []string{"PRAGMA journal_mode=WAL", "PRAGMA foreign_keys=ON", schema} {
		if _, err := db.Exec(statement); err != nil {
			_ = db.Close()
			return nil, err
		}
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

const schema = `
CREATE TABLE IF NOT EXISTS runs (
  ref TEXT PRIMARY KEY,
  ticket TEXT NOT NULL,
  harness TEXT NOT NULL,
  model TEXT,
  workspace_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (
  ref TEXT PRIMARY KEY,
  ticket TEXT NOT NULL,
  human_owner TEXT NOT NULL,
  run_ref TEXT NOT NULL REFERENCES runs(ref),
  previous_state_json TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transaction_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_ref TEXT NOT NULL REFERENCES runs(ref),
  state TEXT NOT NULL,
  receipt_json TEXT,
  error_text TEXT,
  occurred_at TEXT NOT NULL
);`

func (s *Store) SaveRun(ctx context.Context, run domain.Run) error {
	workspace, _ := json.Marshal(run.Workspace)
	capabilities, _ := json.Marshal(run.Capabilities)
	_, err := s.db.ExecContext(ctx, `INSERT INTO runs(ref,ticket,harness,model,workspace_json,capabilities_json,status,created_at,updated_at)
VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET model=excluded.model,workspace_json=excluded.workspace_json,capabilities_json=excluded.capabilities_json,status=excluded.status,updated_at=excluded.updated_at`, run.Ref, run.Ticket, run.Harness, run.Model, workspace, capabilities, run.Status, run.CreatedAt.Format(time.RFC3339Nano), run.UpdatedAt.Format(time.RFC3339Nano))
	return err
}

func (s *Store) Run(ctx context.Context, ref domain.RunRef) (domain.Run, error) {
	var run domain.Run
	var model sql.NullString
	var workspace, capabilities, created, updated string
	err := s.db.QueryRowContext(ctx, `SELECT ticket,harness,model,workspace_json,capabilities_json,status,created_at,updated_at FROM runs WHERE ref=?`, ref).Scan(&run.Ticket, &run.Harness, &model, &workspace, &capabilities, &run.Status, &created, &updated)
	if err != nil {
		return run, err
	}
	run.Ref = ref
	if model.Valid {
		run.Model = &model.String
	}
	if err := json.Unmarshal([]byte(workspace), &run.Workspace); err != nil {
		return run, err
	}
	if err := json.Unmarshal([]byte(capabilities), &run.Capabilities); err != nil {
		return run, err
	}
	run.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
	run.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updated)
	return run, nil
}

func (s *Store) ListRuns(ctx context.Context) ([]domain.Run, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT ref FROM runs ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []domain.Run
	for rows.Next() {
		var ref domain.RunRef
		if err := rows.Scan(&ref); err != nil {
			return nil, err
		}
		run, err := s.Run(ctx, ref)
		if err != nil {
			return nil, err
		}
		result = append(result, run)
	}
	return result, rows.Err()
}

func (s *Store) RecordStep(ctx context.Context, run domain.RunRef, status string, receipt any, stepErr error) error {
	var payload []byte
	if receipt != nil {
		payload, _ = json.Marshal(receipt)
	}
	var message string
	if stepErr != nil {
		message = stepErr.Error()
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO transaction_steps(run_ref,state,receipt_json,error_text,occurred_at) VALUES(?,?,?,?,?)`, run, status, payload, message, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}
