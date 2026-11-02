package world

import (
	"strings"
	"time"

	"sigs.k8s.io/yaml"
)

// caStatus mirrors the upstream cluster-autoscaler status YAML
// (cluster-autoscaler/clusterstate/api/types.go) as published in
// kube-system/cluster-autoscaler-status data.status.
type caStatus struct {
	Time             string        `json:"time"`
	AutoscalerStatus string        `json:"autoscalerStatus"`
	Message          string        `json:"message"`
	ClusterWide      caClusterWide `json:"clusterWide"`
	NodeGroups       []caNodeGroup `json:"nodeGroups"`
}

type caClusterWide struct {
	Health    caHealth    `json:"health"`
	ScaleUp   caScaleUp   `json:"scaleUp"`
	ScaleDown caScaleDown `json:"scaleDown"`
}

type caHealth struct {
	Status              string       `json:"status"`
	NodeCounts          caNodeCounts `json:"nodeCounts"`
	CloudProviderTarget int          `json:"cloudProviderTarget"`
	MinSize             int          `json:"minSize"`
	MaxSize             int          `json:"maxSize"`
	LastProbeTime       string       `json:"lastProbeTime"`
}

type caNodeCounts struct {
	Registered struct {
		Total        int `json:"total"`
		Ready        int `json:"ready"`
		NotStarted   int `json:"notStarted"`
		BeingDeleted int `json:"beingDeleted"`
		Unready      struct {
			Total           int `json:"total"`
			ResourceUnready int `json:"resourceUnready"`
		} `json:"unready"`
	} `json:"registered"`
	LongUnregistered int `json:"longUnregistered"`
	Unregistered     int `json:"unregistered"`
}

type caScaleUp struct {
	Status      string `json:"status"`
	BackoffInfo struct {
		ErrorCode    string `json:"errorCode"`
		ErrorMessage string `json:"errorMessage"`
	} `json:"backoffInfo"`
	LastProbeTime      string `json:"lastProbeTime"`
	LastTransitionTime string `json:"lastTransitionTime"`
}

type caScaleDown struct {
	Status     string `json:"status"`
	Candidates int    `json:"candidates"`
}

type caNodeGroup struct {
	Name      string      `json:"name"`
	Health    caHealth    `json:"health"`
	ScaleUp   caScaleUp   `json:"scaleUp"`
	ScaleDown caScaleDown `json:"scaleDown"`
}

// ParseCAStatus parses the YAML body of the cluster-autoscaler-status ConfigMap.
// poolOf maps a MIG name (last URL segment, e.g. gke-c-pool-abc123-grp) to a
// node pool name; it may return "" when unknown, in which case the pool is
// guessed from the MIG name.
func ParseCAStatus(body string, cluster string, poolOf func(mig string) string) (Autoscaler, error) {
	var st caStatus
	if err := yaml.Unmarshal([]byte(body), &st); err != nil {
		return Autoscaler{}, err
	}
	out := Autoscaler{
		Status:              st.AutoscalerStatus,
		ScaleUp:             st.ClusterWide.ScaleUp.Status,
		ScaleDown:           st.ClusterWide.ScaleDown.Status,
		ScaleDownCandidates: st.ClusterWide.ScaleDown.Candidates,
		Updated:             parseCATime(st.Time),
		NodeGroups:          []NodeGroup{},
	}
	for _, ng := range st.NodeGroups {
		mig, zone := splitMIGURL(ng.Name)
		pool := ""
		if poolOf != nil {
			pool = poolOf(mig)
		}
		if pool == "" {
			pool = guessPoolFromMIG(mig, cluster)
		}
		g := NodeGroup{
			Name:    mig,
			Pool:    pool,
			Zone:    zone,
			Ready:   ng.Health.NodeCounts.Registered.Ready,
			Total:   ng.Health.NodeCounts.Registered.Total,
			Target:  ng.Health.CloudProviderTarget,
			Min:     ng.Health.MinSize,
			Max:     ng.Health.MaxSize,
			ScaleUp: ng.ScaleUp.Status,
		}
		if ng.ScaleUp.Status == "Backoff" {
			g.Backoff = strings.TrimSpace(ng.ScaleUp.BackoffInfo.ErrorCode + " " + ng.ScaleUp.BackoffInfo.ErrorMessage)
		}
		out.NodeGroups = append(out.NodeGroups, g)
	}
	return out, nil
}

// splitMIGURL turns https://www.googleapis.com/compute/v1/projects/P/zones/Z/instanceGroups/NAME
// into (NAME, Z). Bare names are returned unchanged with an empty zone.
func splitMIGURL(u string) (name, zone string) {
	parts := strings.Split(u, "/")
	name = parts[len(parts)-1]
	for i := 0; i+1 < len(parts); i++ {
		if parts[i] == "zones" {
			zone = parts[i+1]
		}
	}
	return name, zone
}

// guessPoolFromMIG strips the gke-<cluster>- prefix and the -<hash>-grp suffix
// from a GKE MIG name.
func guessPoolFromMIG(mig, cluster string) string {
	s := strings.TrimSuffix(mig, "-grp")
	if cluster != "" {
		s = strings.TrimPrefix(s, "gke-"+cluster+"-")
	} else {
		s = strings.TrimPrefix(s, "gke-")
	}
	if i := strings.LastIndex(s, "-"); i > 0 && len(s)-i-1 == 8 {
		s = s[:i]
	}
	return strings.TrimSuffix(s, "-")
}

// familyFromPool guesses machine family and spot-ness from an auto-created
// pool name such as nap-n4d-standard-2-spot-1q5307s5 (used only for
// placeholder nodes of pools that have no registered node yet).
func familyFromPool(pool string) (family string, spot bool) {
	parts := strings.Split(pool, "-")
	for i, p := range parts {
		if p == "nap" && i+1 < len(parts) {
			family = parts[i+1]
		}
		if p == "spot" {
			spot = true
		}
	}
	return family, spot
}

// parseCATime accepts the CA's "2006-01-02 15:04:05.999999999 -0700 MST" format
// and RFC3339, returning RFC3339 (or the raw string when unparseable).
func parseCATime(s string) string {
	if s == "" {
		return ""
	}
	for _, layout := range []string{"2006-01-02 15:04:05.999999999 -0700 MST", "2006-01-02 15:04:05.999999999 -0700 -0700", time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			return rfc3339(t)
		}
	}
	return s
}

// PlaceholderNodes synthesises "pending-<pool>-<n>" nodes for node groups whose
// cloud-provider target exceeds the registered node count, so the UI can show
// capacity that is being created before the kubelet registers. knownPending is
// the number of registered-but-not-ready nodes already visible in the pool
// (those are real objects and must not be double counted).
func PlaceholderNodes(a Autoscaler, nodes []Node) []Node {
	var out []Node
	for _, g := range a.NodeGroups {
		missing := g.Target - g.Total
		if missing <= 0 {
			continue
		}
		family := ""
		machine := ""
		spot := false
		cc := ""
		for _, n := range nodes {
			if n.Pool == g.Pool && !n.Creating {
				family, machine, spot, cc = n.MachineFamily, n.MachineType, n.Spot, n.ComputeClass
				break
			}
		}
		if family == "" {
			family, spot = familyFromPool(g.Pool)
		}
		for i := 1; i <= missing; i++ {
			out = append(out, Node{
				Name:          "pending-" + g.Pool + "-" + itoa(i),
				Pool:          g.Pool,
				Zone:          g.Zone,
				MachineType:   machine,
				MachineFamily: family,
				Spot:          spot,
				ComputeClass:  cc,
				Creating:      true,
				Created:       a.Updated,
			})
		}
	}
	return out
}
