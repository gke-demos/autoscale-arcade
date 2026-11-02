package world

import (
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func q(s string) resource.Quantity { return resource.MustParse(s) }

func TestParseCAStatus(t *testing.T) {
	body := `
time: "2026-11-02 11:00:00.000000000 +0000 UTC"
autoscalerStatus: Running
clusterWide:
  health: {status: Healthy}
  scaleUp: {status: InProgress}
  scaleDown: {status: CandidatesPresent, candidates: 2}
nodeGroups:
- name: https://www.googleapis.com/compute/v1/projects/p/zones/us-central1-a/instanceGroups/gke-autoscale-arcade-default-pool-753b07d3-grp
  health:
    status: Healthy
    nodeCounts: {registered: {total: 1, ready: 1}}
    cloudProviderTarget: 3
    minSize: 0
    maxSize: 10
  scaleUp:
    status: Backoff
    backoffInfo: {errorCode: ZONE_RESOURCE_POOL_EXHAUSTED, errorMessage: "no n4d spot"}
`
	a, err := ParseCAStatus(body, "autoscale-arcade", nil)
	if err != nil {
		t.Fatal(err)
	}
	if a.Status != "Running" || a.ScaleUp != "InProgress" || a.ScaleDown != "CandidatesPresent" || a.ScaleDownCandidates != 2 {
		t.Errorf("cluster-wide: %+v", a)
	}
	if a.Updated != "2026-11-02T11:00:00Z" {
		t.Errorf("updated: %q", a.Updated)
	}
	if len(a.NodeGroups) != 1 {
		t.Fatalf("node groups: %+v", a.NodeGroups)
	}
	g := a.NodeGroups[0]
	if g.Pool != "default-pool" || g.Zone != "us-central1-a" || g.Target != 3 || g.Total != 1 || g.Ready != 1 || g.Max != 10 {
		t.Errorf("group: %+v", g)
	}
	if g.ScaleUp != "Backoff" || g.Backoff != "ZONE_RESOURCE_POOL_EXHAUSTED no n4d spot" {
		t.Errorf("backoff: %+v", g)
	}

	ph := PlaceholderNodes(a, []Node{{Name: "gke-autoscale-arcade-default-pool-753b07d3-mshh", Pool: "default-pool", MachineFamily: "n4", MachineType: "n4-standard-4"}})
	if len(ph) != 2 || ph[0].Name != "pending-default-pool-1" || !ph[0].Creating || ph[1].MachineFamily != "n4" {
		t.Errorf("placeholders: %+v", ph)
	}
}

func TestGuessPoolFromMIG(t *testing.T) {
	cases := map[string]string{
		"gke-autoscale-arcade-default-pool-753b07d3-grp": "default-pool",
		"gke-autoscale-arcade-nap-n4d-spot-1a2b3c4d-grp": "nap-n4d-spot",
		"gke-autoscale-arcade-gvisor-c1425096-grp":       "gvisor",
	}
	for in, want := range cases {
		if got := guessPoolFromMIG(in, "autoscale-arcade"); got != want {
			t.Errorf("%s: got %q want %q", in, got, want)
		}
	}
}

func TestNodeFromK8s(t *testing.T) {
	n := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Name: "gke-autoscale-arcade-nap-x-abc-1", CreationTimestamp: metav1.Time{Time: time.Now().Add(-time.Hour)},
			Labels: map[string]string{
				LabelNodePool: "nap-x", LabelZone: "us-central1-b", LabelInstanceType: "n4d-standard-2",
				LabelSpot: "true", LabelComputeClass: "arcade-spot",
			}},
		Spec: corev1.NodeSpec{Taints: []corev1.Taint{{Key: TaintToBeDeleted, Effect: corev1.TaintEffectNoSchedule}}},
		Status: corev1.NodeStatus{
			Allocatable: corev1.ResourceList{corev1.ResourceCPU: q("1930m"), corev1.ResourceMemory: q("6Gi")},
			Conditions:  []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}},
		},
	}
	got := NodeFromK8s(n, 0.75, 1)
	if !got.Spot || got.MachineFamily != "n4d" || got.ComputeClass != "arcade-spot" || !got.Deleting || !got.Ready || got.Creating {
		t.Errorf("node: %+v", got)
	}
	if got.CPU.Allocatable != 1.93 || got.CPU.Requested != 0.75 || got.Memory.Allocatable != 6 {
		t.Errorf("resources: %+v", got)
	}

	standby := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "s", Labels: map[string]string{LabelInstanceType: "n4-standard-2"}},
		Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}, {Type: ConditionSuspended, Status: corev1.ConditionTrue}}}}
	if s := NodeFromK8s(standby, 0, 0); !s.Suspended || s.Buffer != "standby" || s.MachineFamily != "n4" {
		t.Errorf("standby: %+v", s)
	}
	if c := ClusterNameFromNode("gke-autoscale-arcade-default-pool-753b07d3-mshh", "default-pool"); c != "autoscale-arcade" {
		t.Errorf("cluster name: %q", c)
	}
}

func podWith(mut func(*corev1.Pod)) *corev1.Pod {
	p := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "checkout-abc-1", Namespace: "arcade-spot", UID: "u1",
			Labels:          map[string]string{"pod-template-hash": "abc"},
			OwnerReferences: []metav1.OwnerReference{{Kind: "ReplicaSet", Name: "checkout-abc"}}},
		Spec: corev1.PodSpec{NodeName: "n1", Containers: []corev1.Container{{Name: "app", Resources: corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: q("250m")}}}}},
		Status: corev1.PodStatus{Phase: corev1.PodRunning, Conditions: []corev1.PodCondition{
			{Type: corev1.PodScheduled, Status: corev1.ConditionTrue, LastTransitionTime: metav1.Time{Time: time.Unix(100, 0)}},
			{Type: corev1.PodReady, Status: corev1.ConditionTrue, LastTransitionTime: metav1.Time{Time: time.Unix(130, 0)}},
		}},
	}
	if mut != nil {
		mut(p)
	}
	return p
}

func TestPlacementAndFallback(t *testing.T) {
	spotPref := podWith(func(p *corev1.Pod) {
		p.Spec.Tolerations = []corev1.Toleration{{Key: LabelSpot, Operator: corev1.TolerationOpEqual, Value: "true", Effect: corev1.TaintEffectNoSchedule}}
		p.Spec.Affinity = &corev1.Affinity{NodeAffinity: &corev1.NodeAffinity{PreferredDuringSchedulingIgnoredDuringExecution: []corev1.PreferredSchedulingTerm{{Weight: 100, Preference: corev1.NodeSelectorTerm{MatchExpressions: []corev1.NodeSelectorRequirement{{Key: LabelSpot, Operator: corev1.NodeSelectorOpIn, Values: []string{"true"}}}}}}}}
	})
	if got := Placement(spotPref); got != "spot" {
		t.Errorf("spot placement: %q", got)
	}
	onDemand := podWith(func(p *corev1.Pod) {
		p.Spec.Affinity = &corev1.Affinity{NodeAffinity: &corev1.NodeAffinity{RequiredDuringSchedulingIgnoredDuringExecution: &corev1.NodeSelector{NodeSelectorTerms: []corev1.NodeSelectorTerm{{MatchExpressions: []corev1.NodeSelectorRequirement{{Key: LabelSpot, Operator: corev1.NodeSelectorOpDoesNotExist}}}}}}}
	})
	if got := Placement(onDemand); got != "on-demand" {
		t.Errorf("on-demand placement: %q", got)
	}
	if got := Placement(podWith(nil)); got != "" {
		t.Errorf("no placement: %q", got)
	}

	f := false
	tr := true
	// Spot-targeted pod on an on-demand node = fallback.
	pod := PodFromK8s(spotPref, PodContext{NodeSpot: &f})
	if pod.Placement != "spot" || pod.Fallback == nil || !*pod.Fallback || pod.Spot == nil || *pod.Spot {
		t.Errorf("fallback pod: %+v", pod)
	}
	pod = PodFromK8s(spotPref, PodContext{NodeSpot: &tr})
	if pod.Fallback == nil || *pod.Fallback {
		t.Errorf("not fallback: %+v", pod)
	}
	if pod.Workload != "checkout" || pod.Cabinet != "spot" || pod.CPU.Request != "250m" || !pod.Ready || pod.ReadyAt == "" || pod.ScheduledAt == "" {
		t.Errorf("basics: %+v", pod)
	}
}

func TestPendingReason(t *testing.T) {
	p := podWith(func(p *corev1.Pod) {
		p.Spec.NodeName = ""
		p.Status.Phase = corev1.PodPending
		p.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionFalse, Reason: "Unschedulable"}}
	})
	if got := PodFromK8s(p, PodContext{}); got.PendingReason != "Unschedulable" {
		t.Errorf("pending: %+v", got)
	}
	if got := PodFromK8s(p, PodContext{PendingReasonFromEvents: "TriggeredScaleUp"}); got.PendingReason != "TriggeredScaleUp" {
		t.Errorf("pending from events: %+v", got)
	}
}

func TestBoostFromPod(t *testing.T) {
	boosted := podWith(func(p *corev1.Pod) {
		p.Annotations = map[string]string{"vpaCPUStartupBoost/app": `{"requests":{"cpu":"250m"},"limits":{"cpu":"250m"}}`}
		p.Spec.Containers[0].Resources.Requests[corev1.ResourceCPU] = q("1")
		p.Status.ContainerStatuses = []corev1.ContainerStatus{{Name: "app", Resources: &corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: q("1")}}}}
	})
	b := BoostFromPod(boosted)
	if b == nil || !b.Active || b.CPUOriginal != "250m" || b.CPURequest != "1" {
		t.Fatalf("boosted: %+v", b)
	}
	// In-place unboost: status shows the original again.
	boosted.Status.ContainerStatuses[0].Resources.Requests[corev1.ResourceCPU] = q("250m")
	if b = BoostFromPod(boosted); b == nil || b.Active {
		t.Errorf("unboosted: %+v", b)
	}
	if BoostFromPod(podWith(nil)) != nil {
		t.Error("no annotation should give nil")
	}
	for _, v := range []string{`{"cpu":"500m"}`, `"500m"`, `500m`} {
		if got := parseBoostOriginal(v); got != "500m" {
			t.Errorf("parseBoostOriginal(%s) = %q", v, got)
		}
	}
}

func TestWorkloadOf(t *testing.T) {
	sts := podWith(func(p *corev1.Pod) {
		p.Labels = nil
		p.OwnerReferences = []metav1.OwnerReference{{Kind: "StatefulSet", Name: "pet"}}
	})
	if WorkloadOf(sts) != "pet" {
		t.Error("statefulset owner")
	}
	lab := podWith(func(p *corev1.Pod) { p.Labels[LabelWorkload] = "nitro" })
	if WorkloadOf(lab) != "nitro" {
		t.Error("label wins")
	}
}
