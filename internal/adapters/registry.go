package adapters

import (
	"fmt"
	"os/exec"
	"sort"

	"github.com/JarenKempton/nav/internal/domain"
)

type Kind string

const (
	Tracker   Kind = "tracker"
	Harness   Kind = "harness"
	Workspace Kind = "workspace"
)

type Descriptor struct {
	Name         string               `json:"name"`
	Kind         Kind                 `json:"kind"`
	Bundled      bool                 `json:"bundled"`
	Available    bool                 `json:"available"`
	Executable   string               `json:"executable,omitempty"`
	Capabilities domain.CapabilitySet `json:"capabilities"`
}

func Builtins() []Descriptor {
	trackers := []string{"jira", "linear", "github", "markdown"}
	harnesses := []string{"t3", "pi", "claude", "codex", "cursor", "opencode", "command"}
	result := make([]Descriptor, 0, len(trackers)+len(harnesses)+1)
	for _, name := range trackers {
		result = append(result, Descriptor{Name: name, Kind: Tracker, Bundled: true, Capabilities: domain.NewCapabilities()})
	}
	for _, name := range harnesses {
		executable := map[string]string{"claude": "claude", "codex": "codex", "cursor": "cursor", "opencode": "opencode", "pi": "pi"}[name]
		available := name == "command"
		if executable != "" {
			_, err := exec.LookPath(executable)
			available = err == nil
		}
		caps := domain.NewCapabilities("prompt_generation")
		if available {
			caps["process_launch"] = true
		}
		result = append(result, Descriptor{Name: name, Kind: Harness, Bundled: true, Available: available, Executable: executable, Capabilities: caps})
	}
	result = append(result, Descriptor{Name: "git", Kind: Workspace, Bundled: true, Available: true, Capabilities: domain.NewCapabilities("workspace_prepare")})
	sort.Slice(result, func(i, j int) bool {
		if result[i].Kind == result[j].Kind {
			return result[i].Name < result[j].Name
		}
		return result[i].Kind < result[j].Kind
	})
	return result
}

func Find(name string) (Descriptor, error) {
	for _, descriptor := range Builtins() {
		if descriptor.Name == name {
			return descriptor, nil
		}
	}
	path, err := exec.LookPath("nav-adapter-" + name)
	if err != nil {
		return Descriptor{}, fmt.Errorf("adapter %q not found", name)
	}
	return Descriptor{Name: name, Executable: path, Available: true}, nil
}
