// Package actions implements every POST /api/actions/<name> from
// docs/contracts.md against the real cluster.
package actions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"

	"github.com/gke-demos/autoscale-arcade/internal/world"
)

// ErrUnknown is returned for an action name that does not exist.
var ErrUnknown = errors.New("unknown action")

// ScenarioController is implemented by the scenario runner (scenario.run / scenario.stop).
type ScenarioController interface {
	Run(name string) error
	Stop()
}

// StockoutFunc engages (enabled=true) or releases the Spot stockout lever.
// It is pluggable because the platform owner decides the cheapest
// deterministic lever (see docs/cabinets/spot-on.md).
type StockoutFunc func(ctx context.Context, a *Actions, enabled bool) error

// Preempter triggers a real Spot preemption of a VM.
type Preempter interface {
	SimulateMaintenance(ctx context.Context, project, zone, instance string) error
}

// Actions dispatches arcade actions.
type Actions struct {
	World     *world.World
	Log       *slog.Logger
	Scenario  ScenarioController
	Stockout  StockoutFunc
	Preempter Preempter
	Rand      *rand.Rand
}

// New returns an Actions with the default stockout lever and GCE preempter.
func New(w *world.World, log *slog.Logger) *Actions {
	return &Actions{
		World:     w,
		Log:       log,
		Stockout:  DefaultStockout,
		Preempter: &gcePreempter{},
		Rand:      rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

// Names lists every supported action.
var Names = []string{
	"climber.scale", "climber.lock",
	"spot.scale", "spot.ratio", "spot.preempt", "spot.stockout",
	"teleporter.migrate", "teleporter.random",
	"absorber.preset", "absorber.burst", "absorber.reset",
	"lights.coin", "nitro.race", "reset", "scenario.run", "scenario.stop",
}

// Do runs one action. body is the JSON request body (may be empty).
func (a *Actions) Do(ctx context.Context, name string, body json.RawMessage) error {
	if len(body) == 0 {
		body = json.RawMessage("{}")
	}
	var p struct {
		Replicas  *int   `json:"replicas"`
		Locked    *bool  `json:"locked"`
		SpotRatio *int   `json:"spotRatio"`
		Node      string `json:"node"`
		Enabled   *bool  `json:"enabled"`
		ToNode    string `json:"toNode"`
		Preset    string `json:"preset"`
		Delta     *int   `json:"delta"`
		Count     *int   `json:"count"`
		Cabinet   string `json:"cabinet"`
		Name      string `json:"name"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return fmt.Errorf("bad body: %w", err)
	}
	log := a.Log.With("action", name)
	log.Info("action", "body", string(body))
	ns := world.Namespace
	switch name {
	case "climber.scale":
		return a.scale(ctx, ns(world.CabinetClimber), "climber", need(p.Replicas, 0, 48))
	case "climber.lock":
		return a.climberLock(ctx, p.Locked != nil && *p.Locked)
	case "spot.scale":
		return a.scale(ctx, ns(world.CabinetSpot), "checkout", need(p.Replicas, 0, 48))
	case "spot.ratio":
		if p.SpotRatio == nil {
			return errors.New("spotRatio required")
		}
		return a.spotRatio(ctx, clamp(*p.SpotRatio, 0, 100))
	case "spot.preempt":
		return a.preempt(ctx, p.Node)
	case "spot.stockout":
		if a.Stockout == nil {
			return errors.New("stockout lever not configured")
		}
		enabled := p.Enabled != nil && *p.Enabled
		if err := a.Stockout(ctx, a, enabled); err != nil {
			return err
		}
		a.World.Memory.SetStockout(enabled)
		return nil
	case "teleporter.migrate":
		return a.migrate(ctx, p.ToNode)
	case "teleporter.random":
		return a.migrate(ctx, "")
	case "absorber.preset":
		return a.absorberPreset(ctx, p.Preset)
	case "absorber.burst":
		d := 12
		if p.Delta != nil {
			d = *p.Delta
		}
		return a.burst(ctx, d)
	case "absorber.reset":
		a.World.Memory.SetBurstStarted(time.Time{})
		return a.scale(ctx, ns(world.CabinetAbsorber), "burst-worker", 0)
	case "lights.coin":
		n := 1
		if p.Count != nil {
			n = clamp(*p.Count, 1, 500)
		}
		a.World.Memory.Enqueue(n)
		return nil
	case "nitro.race":
		return a.race(ctx)
	case "reset":
		return a.Reset(ctx, p.Cabinet)
	case "scenario.run":
		if a.Scenario == nil {
			return errors.New("scenario runner not configured")
		}
		return a.Scenario.Run(p.Name)
	case "scenario.stop":
		if a.Scenario == nil {
			return errors.New("scenario runner not configured")
		}
		a.Scenario.Stop()
		return nil
	}
	return fmt.Errorf("%w: %s", ErrUnknown, name)
}

func need(v *int, lo, hi int) int {
	if v == nil {
		return lo
	}
	return clamp(*v, lo, hi)
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// ---- generic helpers ----

func (a *Actions) scale(ctx context.Context, ns, name string, replicas int) error {
	patch := fmt.Sprintf(`{"spec":{"replicas":%d}}`, replicas)
	_, err := a.World.Clients.Kube.AppsV1().Deployments(ns).Patch(ctx, name, types.MergePatchType, []byte(patch), metav1.PatchOptions{FieldManager: "arcade"})
	if err != nil {
		return fmt.Errorf("scale %s/%s: %w", ns, name, err)
	}
	return nil
}

func (a *Actions) mergePatchDyn(ctx context.Context, g schema.GroupVersionResource, ns, name string, patch any) error {
	b, err := json.Marshal(patch)
	if err != nil {
		return err
	}
	_, err = a.World.Clients.Dynamic.Resource(g).Namespace(ns).Patch(ctx, name, types.MergePatchType, b, metav1.PatchOptions{FieldManager: "arcade"})
	if err != nil {
		return fmt.Errorf("patch %s %s/%s: %w", g.Resource, ns, name, err)
	}
	return nil
}

// ---- Capacity Climber ----

const (
	annLockedPriority = "arcade.gke.io/locked-priority"
	// LockedReservationName is the (deliberately non-existent) reservation
	// rung #1 is pinned to while locked.
	LockedReservationName = "arcade-locked"
)

// climberLock makes rung #1 unobtainable by pointing it at a reservation that
// does not exist (affinity Specific, name arcade-locked); unlock restores the
// saved rule from the arcade.gke.io/locked-priority annotation.
func (a *Actions) climberLock(ctx context.Context, locked bool) error {
	cc := a.World.Clients.Dynamic.Resource(world.GVRComputeClass)
	obj, err := cc.Get(ctx, "arcade-climber", metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("get ComputeClass/arcade-climber: %w", err)
	}
	prios, _, _ := unstructured.NestedSlice(obj.Object, "spec", "priorities")
	if len(prios) == 0 {
		return errors.New("ComputeClass/arcade-climber has no priorities")
	}
	first, _ := prios[0].(map[string]any)
	ann := obj.GetAnnotations()
	if ann == nil {
		ann = map[string]string{}
	}
	if locked {
		if _, already := first["reservations"]; already {
			return nil
		}
		saved, _ := json.Marshal(first)
		ann[annLockedPriority] = string(saved)
		lockedRule := map[string]any{}
		for k, v := range first {
			if k == "spot" || k == "flexStart" {
				continue // reservations and Spot are mutually exclusive
			}
			lockedRule[k] = v
		}
		// A specific reservation that does not exist makes the rung
		// unobtainable: GKE skips it and pods land on rung #2.
		lockedRule["reservations"] = map[string]any{"affinity": "Specific", "specific": []any{map[string]any{"name": LockedReservationName}}}
		prios[0] = lockedRule
	} else {
		if s := ann[annLockedPriority]; s != "" {
			var orig map[string]any
			if json.Unmarshal([]byte(s), &orig) == nil {
				prios[0] = orig
			}
			delete(ann, annLockedPriority)
		} else {
			delete(first, "reservations")
			first["spot"] = true
			prios[0] = first
		}
	}
	patch := map[string]any{
		"metadata": map[string]any{"annotations": annotationsPatch(ann, annLockedPriority, locked)},
		"spec":     map[string]any{"priorities": prios},
	}
	b, _ := json.Marshal(patch)
	if _, err := cc.Patch(ctx, "arcade-climber", types.MergePatchType, b, metav1.PatchOptions{FieldManager: "arcade"}); err != nil {
		return fmt.Errorf("patch ComputeClass/arcade-climber: %w", err)
	}
	return nil
}

// annotationsPatch returns a merge-patch annotations map that sets key when
// keep is true and deletes it (null) otherwise.
func annotationsPatch(ann map[string]string, key string, keep bool) map[string]any {
	out := map[string]any{}
	if keep {
		out[key] = ann[key]
	} else {
		out[key] = nil
	}
	return out
}

// ---- Spot On ----

func (a *Actions) spotRatio(ctx context.Context, ratio int) error {
	patch := map[string]any{"spec": map[string]any{"capacityStrategy": map[string]any{"spotRatio": fmt.Sprintf("%d%%", ratio)}}}
	return a.mergePatchDyn(ctx, world.GVRWorkloadClass, world.Namespace(world.CabinetSpot), "checkout", patch)
}

func (a *Actions) preempt(ctx context.Context, nodeName string) error {
	var node *corev1.Node
	for _, n := range a.World.Nodes() {
		if n.Name == nodeName {
			node = n
		}
	}
	if node == nil {
		// Pick any Spot node of the Spot On class when none given.
		for _, n := range a.World.Nodes() {
			if n.Labels[world.LabelSpot] == "true" && (nodeName == "" || nodeName == "any") && n.Labels[world.LabelComputeClass] == "arcade-spot" {
				node = n
				break
			}
		}
	}
	if node == nil {
		return fmt.Errorf("node %q not found", nodeName)
	}
	if node.Labels[world.LabelSpot] != "true" && node.Labels[world.LabelProvisioning] != "spot" {
		return fmt.Errorf("node %s is not a Spot node", node.Name)
	}
	project, zone, instance, err := parseProviderID(node.Spec.ProviderID)
	if err != nil {
		return err
	}
	if a.Preempter == nil {
		return errors.New("preempter not configured")
	}
	return a.Preempter.SimulateMaintenance(ctx, project, zone, instance)
}

func parseProviderID(id string) (project, zone, instance string, err error) {
	s := strings.TrimPrefix(id, "gce://")
	parts := strings.Split(s, "/")
	if !strings.HasPrefix(id, "gce://") || len(parts) != 3 {
		return "", "", "", fmt.Errorf("unexpected providerID %q", id)
	}
	return parts[0], parts[1], parts[2], nil
}

// GVRCapacityQuota / StockoutQuotaName identify the stockout lever's object
// (docs/cabinets/spot-on.md); the world package also watches it so the
// SpotState.stockout flag reflects the cluster, not just server memory.
var GVRCapacityQuota = world.GVRCapacityQuota

const StockoutQuotaName = world.StockoutQuotaName

// DefaultStockout is the lever chosen by the platform owner: a cluster-scoped
// CapacityQuota selecting compute-class=arcade-spot + gke-spot=true with
// limits.resources.nodes "0" (CA then skips every Spot rung and NPAC creates
// on-demand capacity), plus cordon + evict of the class's existing Spot nodes
// so the checkout pods fall back. Disengage = delete the quota + uncordon;
// active migration / Active reversion move the pods back to Spot.
func DefaultStockout(ctx context.Context, a *Actions, enabled bool) error {
	quotas := a.World.Clients.Dynamic.Resource(GVRCapacityQuota)
	if enabled {
		q := &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": GVRCapacityQuota.GroupVersion().String(),
			"kind":       "CapacityQuota",
			"metadata": map[string]any{
				"name":   StockoutQuotaName,
				"labels": map[string]any{world.LabelPartOf: world.PartOfValue, world.LabelCabinet: world.CabinetSpot},
			},
			"spec": map[string]any{
				"selector": map[string]any{"matchLabels": map[string]any{
					world.LabelComputeClass: "arcade-spot",
					world.LabelSpot:         "true",
				}},
				"limits": map[string]any{"resources": map[string]any{"nodes": "0"}},
			},
		}}
		if _, err := quotas.Create(ctx, q, metav1.CreateOptions{FieldManager: "arcade"}); err != nil && !apierrors.IsAlreadyExists(err) {
			return fmt.Errorf("create CapacityQuota/%s: %w", StockoutQuotaName, err)
		}
		for _, n := range a.World.Nodes() {
			if n.Labels[world.LabelComputeClass] != "arcade-spot" || n.Labels[world.LabelSpot] != "true" {
				continue
			}
			if err := a.cordon(ctx, n.Name, true); err != nil {
				return err
			}
			if err := a.drain(ctx, n.Name); err != nil {
				return err
			}
		}
		return nil
	}
	if err := quotas.Delete(ctx, StockoutQuotaName, metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete CapacityQuota/%s: %w", StockoutQuotaName, err)
	}
	for _, n := range a.World.Nodes() {
		if n.Labels[world.LabelComputeClass] == "arcade-spot" && n.Spec.Unschedulable {
			if err := a.cordon(ctx, n.Name, false); err != nil {
				return err
			}
		}
	}
	return nil
}

func (a *Actions) cordon(ctx context.Context, node string, on bool) error {
	patch := fmt.Sprintf(`{"spec":{"unschedulable":%t}}`, on)
	_, err := a.World.Clients.Kube.CoreV1().Nodes().Patch(ctx, node, types.MergePatchType, []byte(patch), metav1.PatchOptions{FieldManager: "arcade"})
	if err != nil {
		return fmt.Errorf("cordon %s: %w", node, err)
	}
	return nil
}

// drain evicts every arcade pod on the node (DaemonSet pods are left alone).
func (a *Actions) drain(ctx context.Context, node string) error {
	for _, p := range a.World.Pods() {
		if p.Spec.NodeName != node || !strings.HasPrefix(p.Namespace, "arcade-") || p.DeletionTimestamp != nil {
			continue
		}
		if ownedByDaemonSet(p) {
			continue
		}
		if err := a.evict(ctx, p.Namespace, p.Name); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	return nil
}

func ownedByDaemonSet(p *corev1.Pod) bool {
	for _, o := range p.OwnerReferences {
		if o.Kind == "DaemonSet" {
			return true
		}
	}
	return false
}

func (a *Actions) evict(ctx context.Context, ns, name string) error {
	ev := &policyv1.Eviction{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}}
	err := a.World.Clients.Kube.PolicyV1().Evictions(ns).Evict(ctx, ev)
	if err != nil && apierrors.IsTooManyRequests(err) {
		// The pod-migration webhook answers 429 while it takes over the
		// eviction (PMJ created); a PDB can also say "not now". Either way
		// the request was accepted by the cluster.
		a.Log.Info("eviction deferred (429)", "pod", ns+"/"+name, "msg", err.Error())
		return nil
	}
	if err != nil {
		return fmt.Errorf("evict %s/%s: %w", ns, name, err)
	}
	return nil
}

// ---- Pod Teleporter ----

// migrate pins StatefulSet/pet to toNode (random other gVisor node when empty)
// and evicts pet-0 so the pod-migration webhook turns it into a live migration.
func (a *Actions) migrate(ctx context.Context, toNode string) error {
	ns := world.Namespace(world.CabinetTeleporter)
	pet := a.World.Pod(ns, "pet-0")
	current := ""
	if pet != nil {
		current = pet.Spec.NodeName
	}
	var candidates []string
	for _, n := range a.World.Nodes() {
		ready := false
		for _, c := range n.Status.Conditions {
			if c.Type == corev1.NodeReady && c.Status == corev1.ConditionTrue {
				ready = true
			}
		}
		if n.Labels[world.LabelSandbox] == "gvisor" && ready && !n.Spec.Unschedulable && n.DeletionTimestamp == nil && n.Name != current {
			candidates = append(candidates, n.Name)
		}
	}
	if toNode == "" {
		if len(candidates) == 0 {
			return errors.New("no other ready gVisor node to teleport to")
		}
		toNode = candidates[a.Rand.Intn(len(candidates))]
	} else {
		ok := false
		for _, c := range candidates {
			if c == toNode {
				ok = true
			}
		}
		if !ok {
			if toNode == current {
				return fmt.Errorf("pet is already on %s", toNode)
			}
			return fmt.Errorf("%s is not a ready gVisor node", toNode)
		}
	}
	patch := fmt.Sprintf(`{"spec":{"template":{"spec":{"nodeSelector":{"kubernetes.io/hostname":%q}}}}}`, toNode)
	if _, err := a.World.Clients.Kube.AppsV1().StatefulSets(ns).Patch(ctx, "pet", types.StrategicMergePatchType, []byte(patch), metav1.PatchOptions{FieldManager: "arcade"}); err != nil {
		return fmt.Errorf("pin StatefulSet/pet to %s: %w", toNode, err)
	}
	if pet == nil {
		return nil // the StatefulSet will create pet-0 on the target node
	}
	return a.evict(ctx, ns, "pet-0")
}

// unpinPet removes the hostname pin (reset).
func (a *Actions) unpinPet(ctx context.Context) error {
	ns := world.Namespace(world.CabinetTeleporter)
	patch := `{"spec":{"template":{"spec":{"nodeSelector":{"kubernetes.io/hostname":null}}}}}`
	_, err := a.World.Clients.Kube.AppsV1().StatefulSets(ns).Patch(ctx, "pet", types.StrategicMergePatchType, []byte(patch), metav1.PatchOptions{FieldManager: "arcade"})
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("unpin StatefulSet/pet: %w", err)
	}
	return nil
}

// ---- Shock Absorber ----

var presets = map[string][2]int{"none": {0, 0}, "active4": {4, 0}, "active8": {8, 0}, "standby8": {0, 8}}

func (a *Actions) absorberPreset(ctx context.Context, preset string) error {
	p, ok := presets[preset]
	if !ok {
		return fmt.Errorf("unknown preset %q (none|active4|active8|standby8)", preset)
	}
	ns := world.Namespace(world.CabinetAbsorber)
	for i, name := range []string{"absorber-active", "absorber-standby"} {
		patch := map[string]any{"spec": map[string]any{"replicas": p[i]}}
		if err := a.mergePatchDyn(ctx, world.GVRCapacityBuffer, ns, name, patch); err != nil {
			return err
		}
	}
	return nil
}

func (a *Actions) burst(ctx context.Context, delta int) error {
	ns := world.Namespace(world.CabinetAbsorber)
	d, err := a.World.Clients.Kube.AppsV1().Deployments(ns).Get(ctx, "burst-worker", metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("get burst-worker: %w", err)
	}
	cur := 0
	if d.Spec.Replicas != nil {
		cur = int(*d.Spec.Replicas)
	}
	a.World.Memory.SetBurstStarted(time.Now())
	return a.scale(ctx, ns, "burst-worker", clamp(cur+delta, 0, 64))
}

// ---- Nitro ----

func (a *Actions) race(ctx context.Context) error {
	ns := world.Namespace(world.CabinetNitro)
	now := time.Now()
	for _, name := range []string{"stock", "nitro"} {
		patch := fmt.Sprintf(`{"spec":{"replicas":1,"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":%q,"arcade.gke.io/race":%q}}}}}`, now.Format(time.RFC3339), now.Format(time.RFC3339Nano))
		if _, err := a.World.Clients.Kube.AppsV1().Deployments(ns).Patch(ctx, name, types.StrategicMergePatchType, []byte(patch), metav1.PatchOptions{FieldManager: "arcade"}); err != nil {
			return fmt.Errorf("restart %s: %w", name, err)
		}
	}
	a.World.Memory.SetRaceStarted(now)
	return nil
}

// ---- reset ----

// Reset returns one cabinet ("" = all) to its start state (contracts.md).
func (a *Actions) Reset(ctx context.Context, cabinet string) error {
	ids := world.CabinetIDs
	if cabinet != "" && cabinet != "all" {
		ids = []string{cabinet}
	}
	var errs []error
	for _, id := range ids {
		var err error
		switch id {
		case world.CabinetClimber:
			err = errors.Join(a.scale(ctx, world.Namespace(id), "climber", 0), a.climberLock(ctx, false))
		case world.CabinetSpot:
			if a.Stockout != nil { // idempotent: deletes the quota if present, uncordons
				err = a.Stockout(ctx, a, false)
				a.World.Memory.SetStockout(false)
			}
			err = errors.Join(err, a.scale(ctx, world.Namespace(id), "checkout", 6), a.spotRatio(ctx, 80))
		case world.CabinetTeleporter:
			err = a.unpinPet(ctx)
		case world.CabinetAbsorber:
			a.World.Memory.SetBurstStarted(time.Time{})
			err = errors.Join(a.absorberPreset(ctx, "none"), a.scale(ctx, world.Namespace(id), "burst-worker", 0))
		case world.CabinetLights:
			a.World.Memory.DrainQueue()
		case world.CabinetNitro:
			a.World.Memory.SetRaceStarted(time.Time{})
			err = errors.Join(a.scale(ctx, world.Namespace(id), "stock", 1), a.scale(ctx, world.Namespace(id), "nitro", 1))
		default:
			err = fmt.Errorf("unknown cabinet %q", id)
		}
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", id, err))
		}
	}
	return errors.Join(errs...)
}
