package routing

type Execution struct{ Harness, Model, Effort string }

// Resolve applies values from lowest to highest precedence. Empty values do not
// erase a lower-precedence decision.
func Resolve(layers ...Execution) Execution {
	var resolved Execution
	for _, layer := range layers {
		if layer.Harness != "" {
			resolved.Harness = layer.Harness
		}
		if layer.Model != "" {
			resolved.Model = layer.Model
		}
		if layer.Effort != "" {
			resolved.Effort = layer.Effort
		}
	}
	return resolved
}
