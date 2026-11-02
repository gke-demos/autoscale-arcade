package world

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

// Well-known GKE labels, taints and annotations.
const (
	LabelNodePool      = "cloud.google.com/gke-nodepool"
	LabelZone          = "topology.kubernetes.io/zone"
	LabelInstanceType  = "node.kubernetes.io/instance-type"
	LabelMachineFamily = "cloud.google.com/machine-family"
	LabelSpot          = "cloud.google.com/gke-spot"
	LabelProvisioning  = "cloud.google.com/gke-provisioning"
	LabelComputeClass  = "cloud.google.com/compute-class"
	LabelSandbox       = "sandbox.gke.io/runtime"
	LabelHostname      = "kubernetes.io/hostname"

	TaintToBeDeleted    = "ToBeDeletedByClusterAutoscaler"
	TaintStandbySuspend = "buffer.gke.io/standby-capacity-node-suspended"
	ConditionSuspended  = "Suspended"

	BoostAnnotationPrefix = "vpaCPUStartupBoost/" // GKE writes vpaCPUStartupBoost/<container>; matched case-insensitively
	AnnotationAssignedPMJ = "pod-migration.gke.io/assigned-pmj"
)

func itoa(i int) string { return strconv.Itoa(i) }

// NodeFromK8s derives a contract Node from a corev1.Node. requestedCPU/Mem are
// the sums of pod requests on that node (cores / GiB), computed by the caller.
func NodeFromK8s(n *corev1.Node, requestedCPU, requestedMem float64) Node {
	l := n.Labels
	out := Node{
		Name:          n.Name,
		Pool:          l[LabelNodePool],
		Zone:          l[LabelZone],
		MachineType:   l[LabelInstanceType],
		MachineFamily: l[LabelMachineFamily],
		Spot:          l[LabelSpot] == "true" || l[LabelProvisioning] == "spot",
		ComputeClass:  l[LabelComputeClass],
		Gvisor:        l[LabelSandbox] == "gvisor",
		Unschedulable: n.Spec.Unschedulable,
		Created:       rfc3339(n.CreationTimestamp.Time),
		Deleting:      n.DeletionTimestamp != nil,
	}
	if out.MachineFamily == "" && out.MachineType != "" {
		out.MachineFamily = strings.SplitN(out.MachineType, "-", 2)[0]
	}
	for _, c := range n.Status.Conditions {
		switch c.Type {
		case corev1.NodeReady:
			out.Ready = c.Status == corev1.ConditionTrue
		case ConditionSuspended:
			out.Suspended = c.Status == corev1.ConditionTrue
		}
	}
	for _, t := range n.Spec.Taints {
		switch t.Key {
		case TaintToBeDeleted:
			out.Deleting = true
		case TaintStandbySuspend:
			out.Suspended = true
		}
	}
	if out.Suspended {
		out.Buffer = "standby"
	} else if out.ComputeClass == "arcade-absorber" {
		out.Buffer = "active"
	}
	// Registered but not yet Ready and young: still being created.
	if !out.Ready && !out.Deleting && time.Since(n.CreationTimestamp.Time) < 10*time.Minute {
		out.Creating = true
	}
	out.CPU = Resource{Allocatable: cores(n.Status.Allocatable.Cpu()), Requested: round2(requestedCPU)}
	out.Memory = Resource{Allocatable: gib(n.Status.Allocatable.Memory()), Requested: round2(requestedMem)}
	return out
}

func cores(q *resource.Quantity) float64 {
	if q == nil {
		return 0
	}
	return round2(float64(q.MilliValue()) / 1000)
}

func gib(q *resource.Quantity) float64 {
	if q == nil {
		return 0
	}
	return round2(float64(q.Value()) / (1024 * 1024 * 1024))
}

func round2(f float64) float64 { return float64(int64(f*100+0.5)) / 100 }

// PodRequests sums the effective CPU (cores) and memory (GiB) requests of a pod
// (max of init containers vs sum of containers, like the scheduler).
func PodRequests(p *corev1.Pod) (cpu, mem float64) {
	var c, m int64
	for _, ctr := range p.Spec.Containers {
		c += ctr.Resources.Requests.Cpu().MilliValue()
		m += ctr.Resources.Requests.Memory().Value()
	}
	for _, ctr := range p.Spec.InitContainers {
		if v := ctr.Resources.Requests.Cpu().MilliValue(); v > c {
			c = v
		}
		if v := ctr.Resources.Requests.Memory().Value(); v > m {
			m = v
		}
	}
	return float64(c) / 1000, float64(m) / (1024 * 1024 * 1024)
}

// PodActive reports whether the pod still occupies capacity.
func PodActive(p *corev1.Pod) bool {
	return p.Status.Phase != corev1.PodSucceeded && p.Status.Phase != corev1.PodFailed
}

// CabinetOf returns the cabinet id for a namespaced object (label first, then
// the arcade-<cabinet> namespace convention). "" for non-arcade objects.
func CabinetOf(namespace string, labels map[string]string) string {
	if c := labels[LabelCabinet]; c != "" {
		return c
	}
	if strings.HasPrefix(namespace, "arcade-") && namespace != NamespaceSystem {
		return strings.TrimPrefix(namespace, "arcade-")
	}
	return ""
}

// WorkloadOf returns the workload name: the arcade.gke.io/workload label, else
// the owner name with the ReplicaSet hash stripped.
func WorkloadOf(p *corev1.Pod) string {
	if w := p.Labels[LabelWorkload]; w != "" {
		return w
	}
	for _, o := range p.OwnerReferences {
		switch o.Kind {
		case "ReplicaSet":
			if h := p.Labels["pod-template-hash"]; h != "" {
				return strings.TrimSuffix(o.Name, "-"+h)
			}
			if i := strings.LastIndex(o.Name, "-"); i > 0 {
				return o.Name[:i]
			}
			return o.Name
		case "StatefulSet", "DaemonSet", "Job":
			return o.Name
		}
	}
	if a := p.Labels["app"]; a != "" {
		return a
	}
	return p.Name
}

// PodContext is the extra information PodFromK8s needs beyond the pod itself.
type PodContext struct {
	NodeSpot    *bool  // nil when the node is unknown / pod unscheduled
	MigrationJob string // PMJ name targeting or restoring this pod
	MigrationPhase string
	PendingReasonFromEvents string // e.g. TriggeredScaleUp
}

// PodFromK8s derives a contract Pod.
func PodFromK8s(p *corev1.Pod, ctx PodContext) Pod {
	out := Pod{
		UID:       string(p.UID),
		Name:      p.Name,
		Namespace: p.Namespace,
		Cabinet:   CabinetOf(p.Namespace, p.Labels),
		Workload:  WorkloadOf(p),
		Node:      p.Spec.NodeName,
		Phase:     string(p.Status.Phase),
		Deleting:  p.DeletionTimestamp != nil,
		Created:   rfc3339(p.CreationTimestamp.Time),
	}
	if out.Phase == "" {
		out.Phase = "Unknown"
	}
	for _, c := range p.Status.Conditions {
		switch c.Type {
		case corev1.PodScheduled:
			if c.Status == corev1.ConditionTrue {
				out.ScheduledAt = rfc3339(c.LastTransitionTime.Time)
			} else if c.Reason != "" {
				out.PendingReason = c.Reason
			}
		case corev1.PodReady:
			if c.Status == corev1.ConditionTrue {
				out.Ready = true
				out.ReadyAt = rfc3339(c.LastTransitionTime.Time)
			}
		}
	}
	if p.Status.Phase == corev1.PodPending && ctx.PendingReasonFromEvents != "" && (out.PendingReason == "" || out.PendingReason == "Unschedulable") {
		out.PendingReason = ctx.PendingReasonFromEvents
	}
	if p.Status.Phase != corev1.PodPending {
		out.PendingReason = ""
	}

	// CPU request (sum over containers) and actual (from containerStatuses[].resources).
	var req, actual int64
	haveActual := false
	for _, c := range p.Spec.Containers {
		req += c.Resources.Requests.Cpu().MilliValue()
	}
	for _, cs := range p.Status.ContainerStatuses {
		if cs.Resources != nil && cs.Resources.Requests != nil {
			haveActual = true
			actual += cs.Resources.Requests.Cpu().MilliValue()
		}
	}
	out.CPU.Request = milli(req)
	if haveActual {
		out.CPU.Actual = milli(actual)
	}

	// Spot / placement / fallback (Spot On).
	if ctx.NodeSpot != nil {
		s := *ctx.NodeSpot
		out.Spot = &s
	}
	out.Placement = Placement(p)
	if out.Placement == "spot" && ctx.NodeSpot != nil {
		fb := !*ctx.NodeSpot
		out.Fallback = &fb
	}

	// Nitro boost.
	if b := BoostFromPod(p); b != nil {
		out.Boost = b
	}

	if ctx.MigrationJob != "" {
		out.Migration = &PodMigrationRef{Job: ctx.MigrationJob, Phase: ctx.MigrationPhase}
	}
	return out
}

func milli(m int64) string {
	if m == 0 {
		return "0"
	}
	if m%1000 == 0 {
		return strconv.FormatInt(m/1000, 10)
	}
	return strconv.FormatInt(m, 10) + "m"
}

// Placement derives the Spot On intent the workload-class webhook injected:
//   - "spot": nodeSelector gke-spot=true, a gke-spot toleration, or a preferred
//     affinity term requiring gke-spot In [true];
//   - "on-demand": a required affinity term with gke-spot DoesNotExist (and no
//     spot signals);
//   - "" otherwise.
func Placement(p *corev1.Pod) string {
	if p.Spec.NodeSelector[LabelSpot] == "true" {
		return "spot"
	}
	for _, t := range p.Spec.Tolerations {
		if t.Key == LabelSpot && t.Value == "true" && t.Effect == corev1.TaintEffectNoSchedule {
			return "spot"
		}
	}
	na := nodeAffinity(p)
	if na == nil {
		return ""
	}
	for _, pt := range na.PreferredDuringSchedulingIgnoredDuringExecution {
		for _, r := range pt.Preference.MatchExpressions {
			if r.Key == LabelSpot && r.Operator == corev1.NodeSelectorOpIn && contains(r.Values, "true") {
				return "spot"
			}
		}
	}
	if req := na.RequiredDuringSchedulingIgnoredDuringExecution; req != nil {
		for _, term := range req.NodeSelectorTerms {
			for _, r := range term.MatchExpressions {
				if r.Key == LabelSpot && r.Operator == corev1.NodeSelectorOpIn && contains(r.Values, "true") {
					return "spot"
				}
			}
		}
		for _, term := range req.NodeSelectorTerms {
			for _, r := range term.MatchExpressions {
				if r.Key == LabelSpot && r.Operator == corev1.NodeSelectorOpDoesNotExist {
					return "on-demand"
				}
			}
		}
	}
	return ""
}

func nodeAffinity(p *corev1.Pod) *corev1.NodeAffinity {
	if p.Spec.Affinity == nil {
		return nil
	}
	return p.Spec.Affinity.NodeAffinity
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

// BoostFromPod reads the vpaCpuStartupBoost/<container> annotation the VPA
// admission webhook writes (JSON of the original requests/limits). The boost is
// active while the container's actual (or, lacking status, spec) CPU request
// is still above the original.
func BoostFromPod(p *corev1.Pod) *Boost {
	for k, v := range p.Annotations {
		if len(k) <= len(BoostAnnotationPrefix) || !strings.EqualFold(k[:len(BoostAnnotationPrefix)], BoostAnnotationPrefix) {
			continue
		}
		container := k[len(BoostAnnotationPrefix):]
		orig := parseBoostOriginal(v)
		var spec, actual string
		for _, c := range p.Spec.Containers {
			if c.Name == container {
				spec = c.Resources.Requests.Cpu().String()
			}
		}
		for _, cs := range p.Status.ContainerStatuses {
			if cs.Name == container && cs.Resources != nil && cs.Resources.Requests != nil {
				actual = cs.Resources.Requests.Cpu().String()
			}
		}
		current := spec
		if actual != "" {
			current = actual
		}
		b := &Boost{CPURequest: current, CPUOriginal: orig}
		if orig != "" {
			oq, err1 := resource.ParseQuantity(orig)
			cq, err2 := resource.ParseQuantity(current)
			if err1 == nil && err2 == nil {
				b.Active = cq.Cmp(oq) > 0
			}
		}
		return b
	}
	return nil
}

// parseBoostOriginal is tolerant about the annotation's shape:
// {"requests":{"cpu":"250m"},...}, {"cpu":"250m"} or a bare quantity.
func parseBoostOriginal(v string) string {
	var withReq struct {
		Requests map[string]string `json:"requests"`
		Limits   map[string]string `json:"limits"`
	}
	if err := json.Unmarshal([]byte(v), &withReq); err == nil && withReq.Requests["cpu"] != "" {
		return withReq.Requests["cpu"]
	}
	var flat map[string]json.RawMessage
	if err := json.Unmarshal([]byte(v), &flat); err == nil {
		if raw, ok := flat["cpu"]; ok {
			var s string
			if json.Unmarshal(raw, &s) == nil {
				return s
			}
			return strings.Trim(string(raw), `"`)
		}
		if raw, ok := flat["requests"]; ok {
			var m map[string]string
			if json.Unmarshal(raw, &m) == nil && m["cpu"] != "" {
				return m["cpu"]
			}
		}
	}
	var s string
	if err := json.Unmarshal([]byte(v), &s); err == nil {
		return s
	}
	if _, err := resource.ParseQuantity(strings.TrimSpace(v)); err == nil {
		return strings.TrimSpace(v)
	}
	return ""
}

// SortNodes orders nodes by pool then name; SortPods by namespace, workload, name.
func SortNodes(ns []Node) {
	sort.Slice(ns, func(i, j int) bool {
		if ns[i].Pool != ns[j].Pool {
			return ns[i].Pool < ns[j].Pool
		}
		return ns[i].Name < ns[j].Name
	})
}

func SortPods(ps []Pod) {
	sort.Slice(ps, func(i, j int) bool {
		if ps[i].Namespace != ps[j].Namespace {
			return ps[i].Namespace < ps[j].Namespace
		}
		if ps[i].Workload != ps[j].Workload {
			return ps[i].Workload < ps[j].Workload
		}
		return ps[i].Name < ps[j].Name
	})
}

// ParsePercent parses "80%" or "80" into 80.
func ParsePercent(s string) int {
	s = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s), "%"))
	n, _ := strconv.Atoi(s)
	return n
}

// ClusterNameFromNode derives the GKE cluster name from a node named
// gke-<cluster>-<pool>-<hash>-<id> with the given pool label.
func ClusterNameFromNode(nodeName, pool string) string {
	if !strings.HasPrefix(nodeName, "gke-") || pool == "" {
		return ""
	}
	s := strings.TrimPrefix(nodeName, "gke-")
	if i := strings.Index(s, "-"+pool+"-"); i > 0 {
		return s[:i]
	}
	return ""
}

// RegionOfZone trims the zone suffix: us-central1-a -> us-central1.
func RegionOfZone(zone string) string {
	if i := strings.LastIndex(zone, "-"); i > 0 {
		return zone[:i]
	}
	return zone
}
