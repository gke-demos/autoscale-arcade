package world

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Small helpers over unstructured objects. They never panic and return zero
// values for missing paths.

func str(u *unstructured.Unstructured, path ...string) string {
	if u == nil {
		return ""
	}
	v, found, _ := unstructured.NestedFieldNoCopy(u.Object, path...)
	if !found || v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	case int64:
		return strconv.FormatInt(t, 10)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	}
	return fmt.Sprint(v)
}

func num(u *unstructured.Unstructured, path ...string) float64 {
	if u == nil {
		return 0
	}
	v, found, _ := unstructured.NestedFieldNoCopy(u.Object, path...)
	if !found || v == nil {
		return 0
	}
	switch t := v.(type) {
	case int64:
		return float64(t)
	case float64:
		return t
	case int:
		return float64(t)
	case string:
		f, _ := strconv.ParseFloat(strings.TrimSuffix(t, "%"), 64)
		return f
	}
	return 0
}

func boolean(u *unstructured.Unstructured, path ...string) bool {
	if u == nil {
		return false
	}
	v, found, _ := unstructured.NestedBool(u.Object, path...)
	return found && v
}

func slice(u *unstructured.Unstructured, path ...string) []map[string]any {
	if u == nil {
		return nil
	}
	v, found, _ := unstructured.NestedSlice(u.Object, path...)
	if !found {
		return nil
	}
	var out []map[string]any
	for _, e := range v {
		if m, ok := e.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func mstr(m map[string]any, path ...string) string {
	v, found, _ := unstructured.NestedFieldNoCopy(m, path...)
	if !found || v == nil {
		return ""
	}
	return fmt.Sprint(v)
}

func mbool(m map[string]any, path ...string) bool {
	v, found, _ := unstructured.NestedBool(m, path...)
	return found && v
}

// condition returns (status, reason, message) of a metav1.Condition-style entry.
func condition(u *unstructured.Unstructured, typ string) (status, reason, message string) {
	for _, c := range slice(u, "status", "conditions") {
		if mstr(c, "type") == typ {
			return mstr(c, "status"), mstr(c, "reason"), mstr(c, "message")
		}
	}
	return "", "", ""
}

func condTrue(u *unstructured.Unstructured, typ string) bool {
	s, _, _ := condition(u, typ)
	return s == "True"
}

// toJSON is used by tests and debugging.
func toJSON(v any) string {
	b, _ := json.MarshalIndent(v, "", "  ")
	return string(b)
}
