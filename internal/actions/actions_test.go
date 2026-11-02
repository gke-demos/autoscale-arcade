package actions

import (
	"context"
	"encoding/json"
	"log/slog"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	kubefake "k8s.io/client-go/kubernetes/fake"

	"github.com/gke-demos/autoscale-arcade/internal/world"
)

func newTestActions(t *testing.T, objs ...runtime.Object) (*Actions, *dynamicfake.FakeDynamicClient) {
	t.Helper()
	scheme := runtime.NewScheme()
	cc := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "cloud.google.com/v1", "kind": "ComputeClass",
		"metadata": map[string]any{"name": "arcade-climber"},
		"spec": map[string]any{"priorities": []any{
			map[string]any{"machineType": "n4d-standard-2", "spot": true},
			map[string]any{"machineType": "n4-standard-2", "spot": true},
			map[string]any{"machineType": "n4-standard-2"},
		}},
	}}
	wc := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "workloads.gke.io/v1", "kind": "WorkloadClass",
		"metadata": map[string]any{"name": "checkout", "namespace": "arcade-spot"},
		"spec":     map[string]any{"capacityStrategy": map[string]any{"type": "Spot", "spotRatio": "80%"}},
	}}
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, map[schema.GroupVersionResource]string{
		world.GVRComputeClass:  "ComputeClassList",
		world.GVRWorkloadClass: "WorkloadClassList",
		world.GVRCapacityQuota: "CapacityQuotaList",
	}, cc, wc)
	kube := kubefake.NewSimpleClientset(objs...)
	clients := &world.Clients{Kube: kube, Dynamic: dyn, Discovery: kube.Discovery()}
	w := world.New(world.Config{}, clients, slog.Default())
	a := New(w, slog.Default())
	return a, dyn
}

func TestClimberLockUnlock(t *testing.T) {
	a, dyn := newTestActions(t)
	ctx := context.Background()
	if err := a.Do(ctx, "climber.lock", json.RawMessage(`{"locked":true}`)); err != nil {
		t.Fatal(err)
	}
	cc, _ := dyn.Resource(world.GVRComputeClass).Get(ctx, "arcade-climber", metav1.GetOptions{})
	prios, _, _ := unstructured.NestedSlice(cc.Object, "spec", "priorities")
	first := prios[0].(map[string]any)
	if _, hasSpot := first["spot"]; hasSpot {
		t.Errorf("locked rule must drop spot: %v", first)
	}
	if aff, _, _ := unstructured.NestedString(first, "reservations", "affinity"); aff != "Specific" {
		t.Errorf("affinity: %v", first)
	}
	if first["machineType"] != "n4d-standard-2" || len(prios) != 3 {
		t.Errorf("rule shape: %v", prios)
	}
	if cc.GetAnnotations()[annLockedPriority] == "" {
		t.Error("original rule not saved")
	}
	// Locking twice is a no-op.
	if err := a.Do(ctx, "climber.lock", json.RawMessage(`{"locked":true}`)); err != nil {
		t.Fatal(err)
	}
	if err := a.Do(ctx, "climber.lock", json.RawMessage(`{"locked":false}`)); err != nil {
		t.Fatal(err)
	}
	cc, _ = dyn.Resource(world.GVRComputeClass).Get(ctx, "arcade-climber", metav1.GetOptions{})
	prios, _, _ = unstructured.NestedSlice(cc.Object, "spec", "priorities")
	first = prios[0].(map[string]any)
	if first["spot"] != true || first["reservations"] != nil || first["machineType"] != "n4d-standard-2" {
		t.Errorf("unlock must restore: %v", first)
	}
	if _, ok := cc.GetAnnotations()[annLockedPriority]; ok {
		t.Error("annotation should be cleared")
	}
}

func TestSpotRatioAndStockout(t *testing.T) {
	spotNode := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "spot-1", Labels: map[string]string{world.LabelComputeClass: "arcade-spot", world.LabelSpot: "true"}}}
	a, dyn := newTestActions(t, spotNode)
	ctx := context.Background()
	if err := a.Do(ctx, "spot.ratio", json.RawMessage(`{"spotRatio":250}`)); err != nil {
		t.Fatal(err)
	}
	wc, _ := dyn.Resource(world.GVRWorkloadClass).Namespace("arcade-spot").Get(ctx, "checkout", metav1.GetOptions{})
	if r, _, _ := unstructured.NestedString(wc.Object, "spec", "capacityStrategy", "spotRatio"); r != "100%" {
		t.Errorf("ratio clamped: %q", r)
	}
	if err := a.Do(ctx, "spot.ratio", json.RawMessage(`{}`)); err == nil {
		t.Error("spotRatio required")
	}

	// Stockout engages the CapacityQuota (informer caches are empty in this
	// test, so no nodes are cordoned) and the memory flag.
	if err := a.Do(ctx, "spot.stockout", json.RawMessage(`{"enabled":true}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := dyn.Resource(world.GVRCapacityQuota).Get(ctx, world.StockoutQuotaName, metav1.GetOptions{}); err != nil {
		t.Fatalf("quota not created: %v", err)
	}
	if !a.World.Memory.Stockout() {
		t.Error("memory flag")
	}
	// Engaging twice is fine (AlreadyExists ignored).
	if err := a.Do(ctx, "spot.stockout", json.RawMessage(`{"enabled":true}`)); err != nil {
		t.Fatal(err)
	}
	if err := a.Do(ctx, "spot.stockout", json.RawMessage(`{"enabled":false}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := dyn.Resource(world.GVRCapacityQuota).Get(ctx, world.StockoutQuotaName, metav1.GetOptions{}); err == nil {
		t.Error("quota should be deleted")
	}
	if a.World.Memory.Stockout() {
		t.Error("memory flag should be off")
	}
}

func TestScaleAndRace(t *testing.T) {
	one := int32(1)
	deps := []runtime.Object{
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "climber", Namespace: "arcade-climber"}},
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "stock", Namespace: "arcade-nitro"}, Spec: appsv1.DeploymentSpec{Replicas: &one}},
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "nitro", Namespace: "arcade-nitro"}, Spec: appsv1.DeploymentSpec{Replicas: &one}},
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "burst-worker", Namespace: "arcade-absorber"}},
	}
	a, _ := newTestActions(t, deps...)
	ctx := context.Background()
	if err := a.Do(ctx, "climber.scale", json.RawMessage(`{"replicas":24}`)); err != nil {
		t.Fatal(err)
	}
	d, _ := a.World.Clients.Kube.AppsV1().Deployments("arcade-climber").Get(ctx, "climber", metav1.GetOptions{})
	if d.Spec.Replicas == nil || *d.Spec.Replicas != 24 {
		t.Errorf("replicas: %v", d.Spec.Replicas)
	}
	if err := a.Do(ctx, "nitro.race", nil); err != nil {
		t.Fatal(err)
	}
	if a.World.Memory.RaceStarted().IsZero() {
		t.Error("race start not recorded")
	}
	n, _ := a.World.Clients.Kube.AppsV1().Deployments("arcade-nitro").Get(ctx, "nitro", metav1.GetOptions{})
	if n.Spec.Template.Annotations["kubectl.kubernetes.io/restartedAt"] == "" {
		t.Error("rollout restart annotation missing")
	}
	if err := a.Do(ctx, "absorber.burst", json.RawMessage(`{"delta":12}`)); err != nil {
		t.Fatal(err)
	}
	b, _ := a.World.Clients.Kube.AppsV1().Deployments("arcade-absorber").Get(ctx, "burst-worker", metav1.GetOptions{})
	if *b.Spec.Replicas != 12 || a.World.Memory.BurstStarted().IsZero() {
		t.Errorf("burst: %v", b.Spec.Replicas)
	}
	if err := a.Do(ctx, "lights.coin", json.RawMessage(`{"count":7}`)); err != nil {
		t.Fatal(err)
	}
	if d, _ := a.World.Memory.QueueDepth(); d != 7 {
		t.Errorf("queue: %d", d)
	}
	if err := a.Do(ctx, "reset", json.RawMessage(`{"cabinet":"lights"}`)); err != nil {
		t.Fatal(err)
	}
	if d, _ := a.World.Memory.QueueDepth(); d != 0 {
		t.Errorf("queue after reset: %d", d)
	}
	if err := a.Do(ctx, "bogus", nil); err == nil {
		t.Error("unknown action must fail")
	}
}

func TestParseProviderID(t *testing.T) {
	p, z, i, err := parseProviderID("gce://gke-demos-345619/us-central1-f/gke-autoscale-arcade-nap-n4d-503c2061-4gkv")
	if err != nil || p != "gke-demos-345619" || z != "us-central1-f" || i != "gke-autoscale-arcade-nap-n4d-503c2061-4gkv" {
		t.Errorf("%s %s %s %v", p, z, i, err)
	}
	if _, _, _, err := parseProviderID("aws:///x"); err == nil {
		t.Error("non-gce must fail")
	}
}
