package protocol

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"

	"github.com/JarenKempton/nav/internal/domain"
)

const (
	Version               = "1.0"
	DefaultMaxMessageSize = 1 << 20
)

type Request struct {
	JSONRPC string `json:"jsonrpc"`
	ID      string `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      string          `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type InitializeParams struct {
	ProtocolVersion string `json:"protocol_version"`
	CoreVersion     string `json:"core_version"`
	AdapterKind     string `json:"adapter_kind"`
	Workspace       string `json:"workspace,omitempty"`
}

type AdapterDescription struct {
	Name             string               `json:"name"`
	Version          string               `json:"version"`
	ProtocolVersions []string             `json:"protocol_versions"`
	Capabilities     domain.CapabilitySet `json:"capabilities"`
}

type InitializeResult struct {
	Adapter AdapterDescription `json:"adapter"`
}

type Client struct {
	Path           string
	Timeout        time.Duration
	MaxMessageSize int
}

func (c Client) Initialize(ctx context.Context, kind, workspace, coreVersion string) (AdapterDescription, error) {
	var result InitializeResult
	err := c.Call(ctx, "adapter.initialize", InitializeParams{Version, coreVersion, kind, workspace}, &result)
	if err != nil {
		return AdapterDescription{}, err
	}
	supported := false
	for _, version := range result.Adapter.ProtocolVersions {
		if strings.Split(version, ".")[0] == "1" {
			supported = true
		}
	}
	if !supported {
		return AdapterDescription{}, fmt.Errorf("adapter %s does not support protocol major 1", result.Adapter.Name)
	}
	return result.Adapter, nil
}

func (c Client) Call(ctx context.Context, method string, params, target any) error {
	if c.Path == "" {
		return errors.New("adapter path is required")
	}
	timeout := c.Timeout
	if timeout == 0 {
		timeout = 15 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request := Request{JSONRPC: "2.0", ID: "1", Method: method, Params: params}
	payload, err := json.Marshal(request)
	if err != nil {
		return err
	}
	command := exec.CommandContext(ctx, c.Path)
	stdin, err := command.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return fmt.Errorf("start adapter: %w", err)
	}
	if _, err := stdin.Write(append(payload, '\n')); err != nil {
		_ = command.Process.Kill()
		return err
	}
	_ = stdin.Close()
	max := c.MaxMessageSize
	if max == 0 {
		max = DefaultMaxMessageSize
	}
	reader := bufio.NewReaderSize(stdout, min(max, 64*1024))
	line, err := reader.ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		_ = command.Process.Kill()
		return err
	}
	if len(line) > max {
		_ = command.Process.Kill()
		return fmt.Errorf("adapter response exceeds %d bytes", max)
	}
	if err := command.Wait(); err != nil {
		return fmt.Errorf("adapter exited unsuccessfully: %w", err)
	}
	var response Response
	if err := json.Unmarshal(line, &response); err != nil {
		return fmt.Errorf("decode adapter response: %w", err)
	}
	if response.JSONRPC != "2.0" || response.ID != request.ID {
		return errors.New("invalid JSON-RPC response envelope")
	}
	if response.Error != nil {
		return fmt.Errorf("adapter error %d: %s", response.Error.Code, response.Error.Message)
	}
	if target == nil {
		return nil
	}
	return json.Unmarshal(response.Result, target)
}
