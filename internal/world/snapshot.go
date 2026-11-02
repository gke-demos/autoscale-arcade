package world

import (
	"sort"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Snapshot builds the current WorldState from the informer caches.
func (w *World) Snapshot() *WorldState {
	now := time.Now()
	st := &WorldState{Ts: rfc3339(now), Nodes: []Node{}, Pods: []Pod{}, Events: []Event{}}

	k8sNodes := w.k8sNodes()
	k8sPods := w.k8sPods()

	// Requests per node (all pods, not just arcade ones).
	reqCPU := map[string]float64{}
	reqMem := map[string]float64{}
	for _, p := range k8sPods {
		if p.Spec.NodeName == "" || !PodActive(p) {
			continue
		}
		c, m := PodRequests(p)
		reqCPU[p.Spec.NodeName] += c
		reqMem[p.Spec.NodeName] += m
	}

	nodeByName := map[string]*Node{}
	for _, n := range k8sNodes {
		node := NodeFromK8s(n, reqCPU[n.Name], reqMem[n.Name])
		st.Nodes = append(st.Nodes, node)
	}
	for i := range st.Nodes {
		nodeByName[st.Nodes[i].Name] = &st.Nodes[i]
	}

	// Cluster identity.
	st.Cluster = w.clusterInfo(k8sNodes)

	// Cluster autoscaler status + placeholder nodes.
	if cm := w.caStatusConfigMap(); cm != nil {
		poolOf := func(mig string) string {
			prefix := strings.TrimSuffix(mig, "-grp") + "-"
			for _, n := range st.Nodes {
				if strings.HasPrefix(n.Name, prefix) {
					return n.Pool
				}
			}
			// MIG names truncate long NPAC pool names: match a unique pool prefix.
			guess := guessPoolFromMIG(strings.TrimSuffix(mig, "-grp"), st.Cluster.Name)
			match := ""
			for _, n := range st.Nodes {
				if strings.HasPrefix(n.Pool, guess) && n.Pool != match {
					if match != "" {
						return "" // ambiguous
					}
					match = n.Pool
				}
			}
			return match
		}
		if a, err := ParseCAStatus(cm.Data["status"], st.Cluster.Name, poolOf); err == nil {
			st.Cluster.Autoscaler = a
			st.Nodes = append(st.Nodes, PlaceholderNodes(a, st.Nodes)...)
		} else {
			w.log.Warn("parse cluster-autoscaler-status", "err", err)
		}
	}
	if st.Cluster.Autoscaler.NodeGroups == nil {
		st.Cluster.Autoscaler.NodeGroups = []NodeGroup{}
	}

	// Migration jobs (Teleporter) indexed by target pod UID and restored pod UID/name.
	pmjs := w.migrationJobs()
	pmjByTargetUID := map[string]*MigrationJob{}
	pmjByRestoredUID := map[string]*MigrationJob{}
	pmjByRestored := map[string]*MigrationJob{}
	for i := range pmjs {
		j := &pmjs[i]
		if j.TargetUID != "" {
			pmjByTargetUID[j.TargetUID] = j
		}
		if j.RestoredUID != "" {
			pmjByRestoredUID[j.RestoredUID] = j
		}
		if j.RestoredPod != "" {
			if _, exists := pmjByRestored[j.RestoredPod]; !exists {
				pmjByRestored[j.RestoredPod] = j
			}
		}
	}

	// Pending reasons from recent CA events (TriggeredScaleUp etc.).
	pendingReason := map[string]string{}
	k8sEvents := w.k8sEvents()
	for _, e := range k8sEvents {
		if e.InvolvedObject.Kind != "Pod" {
			continue
		}
		switch e.Reason {
		case "TriggeredScaleUp", "NotTriggerScaleUp", "FailedScaleUp", "SchedulingGated":
			key := e.InvolvedObject.Namespace + "/" + e.InvolvedObject.Name
			if prev, ok := pendingReason[key]; !ok || prev == "" || e.Reason == "TriggeredScaleUp" {
				pendingReason[key] = e.Reason
			}
		}
	}

	// Pods (arcade namespaces only; filter to labelled arcade workloads).
	for _, p := range k8sPods {
		if !strings.HasPrefix(p.Namespace, "arcade-") || !isArcadePod(p) {
			continue
		}
		pc := PodContext{PendingReasonFromEvents: pendingReason[p.Namespace+"/"+p.Name]}
		if n, ok := nodeByName[p.Spec.NodeName]; ok {
			s := n.Spot
			pc.NodeSpot = &s
		}
		if j, ok := pmjByTargetUID[string(p.UID)]; ok {
			pc.MigrationJob, pc.MigrationPhase = j.Name, j.Phase
		} else if j, ok := pmjByRestoredUID[string(p.UID)]; ok && p.Namespace == Namespace(CabinetTeleporter) {
			pc.MigrationJob, pc.MigrationPhase = j.Name, j.Phase
		} else if j, ok := pmjByRestored[p.Name]; ok && j.RestoredUID == "" && p.Namespace == Namespace(CabinetTeleporter) {
			pc.MigrationJob, pc.MigrationPhase = j.Name, j.Phase
		} else if name := p.Annotations[AnnotationAssignedPMJ]; name != "" {
			for i := range pmjs {
				if pmjs[i].Name == name {
					pc.MigrationJob, pc.MigrationPhase = name, pmjs[i].Phase
				}
			}
		}
		st.Pods = append(st.Pods, PodFromK8s(p, pc))
	}

	// Cabinets.
	st.Cabinets.Climber = w.climberState(st)
	st.Cabinets.Spot = w.spotState(st)
	st.Cabinets.Teleporter = w.teleporterState(st, pmjs)
	st.Cabinets.Absorber = w.absorberState(st)
	st.Cabinets.Lights = w.lightsState()
	st.Cabinets.Nitro = w.nitroState(st, k8sPods, k8sEvents)

	SortNodes(st.Nodes)
	SortPods(st.Pods)
	st.Events = w.eventList(k8sEvents)
	st.Scenario = w.ScenarioState()
	return st
}

// ---- informer accessors ----

func (w *World) k8sNodes() []*corev1.Node {
	var out []*corev1.Node
	if w.nodes == nil {
		return out
	}
	for _, o := range w.nodes.GetStore().List() {
		if n, ok := o.(*corev1.Node); ok {
			out = append(out, n)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (w *World) k8sPods() []*corev1.Pod {
	var out []*corev1.Pod
	if w.pods == nil {
		return out
	}
	for _, o := range w.pods.GetStore().List() {
		if p, ok := o.(*corev1.Pod); ok {
			out = append(out, p)
		}
	}
	return out
}

func (w *World) k8sEvents() []*corev1.Event {
	var out []*corev1.Event
	if w.events == nil {
		return out
	}
	for _, o := range w.events.GetStore().List() {
		if e, ok := o.(*corev1.Event); ok {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return eventTime(out[i]).After(eventTime(out[j])) })
	return out
}

func eventTime(e *corev1.Event) time.Time {
	if !e.LastTimestamp.IsZero() {
		return e.LastTimestamp.Time
	}
	if !e.EventTime.IsZero() {
		return e.EventTime.Time
	}
	return e.CreationTimestamp.Time
}

func (w *World) deployment(ns, name string) *appsv1.Deployment {
	if w.deployments == nil {
		return nil
	}
	o, ok, _ := w.deployments.GetStore().GetByKey(ns + "/" + name)
	if !ok {
		return nil
	}
	d, _ := o.(*appsv1.Deployment)
	return d
}

// StatefulSet returns a cached StatefulSet (used by actions).
func (w *World) StatefulSet(ns, name string) *appsv1.StatefulSet {
	if w.statefulset == nil {
		return nil
	}
	o, ok, _ := w.statefulset.GetStore().GetByKey(ns + "/" + name)
	if !ok {
		return nil
	}
	s, _ := o.(*appsv1.StatefulSet)
	return s
}

func (w *World) hpa(ns, name string) *autoscalingv2.HorizontalPodAutoscaler {
	if w.hpas == nil {
		return nil
	}
	o, ok, _ := w.hpas.GetStore().GetByKey(ns + "/" + name)
	if !ok {
		return nil
	}
	h, _ := o.(*autoscalingv2.HorizontalPodAutoscaler)
	return h
}

func (w *World) caStatusConfigMap() *corev1.ConfigMap {
	if w.caConfigMap == nil {
		return nil
	}
	o, ok, _ := w.caConfigMap.GetStore().GetByKey("kube-system/cluster-autoscaler-status")
	if !ok {
		return nil
	}
	cm, _ := o.(*corev1.ConfigMap)
	return cm
}

// Pod returns a cached pod (used by actions).
func (w *World) Pod(ns, name string) *corev1.Pod {
	if w.pods == nil {
		return nil
	}
	o, ok, _ := w.pods.GetStore().GetByKey(ns + "/" + name)
	if !ok {
		return nil
	}
	p, _ := o.(*corev1.Pod)
	return p
}

// Nodes returns cached nodes (used by actions).
func (w *World) Nodes() []*corev1.Node { return w.k8sNodes() }

// Pods returns cached pods (used by actions).
func (w *World) Pods() []*corev1.Pod { return w.k8sPods() }

// ---- cluster ----

func (w *World) clusterInfo(nodes []*corev1.Node) Cluster {
	w.mu.RLock()
	version := w.version
	w.mu.RUnlock()
	c := Cluster{Name: w.cfg.Cluster, Project: w.cfg.Project, Region: w.cfg.Region, Version: version}
	for _, n := range nodes {
		if c.Name == "" {
			c.Name = ClusterNameFromNode(n.Name, n.Labels[LabelNodePool])
		}
		if c.Region == "" {
			c.Region = RegionOfZone(n.Labels[LabelZone])
		}
		if c.Project == "" && strings.HasPrefix(n.Spec.ProviderID, "gce://") {
			parts := strings.Split(strings.TrimPrefix(n.Spec.ProviderID, "gce://"), "/")
			if len(parts) > 0 {
				c.Project = parts[0]
			}
		}
		if c.Version == "" {
			c.Version = n.Status.NodeInfo.KubeletVersion
		}
	}
	return c
}

// ---- events ----

func (w *World) eventList(evs []*corev1.Event) []Event {
	out := []Event{}
	for _, e := range evs {
		relevant := strings.HasPrefix(e.Namespace, "arcade-") ||
			e.InvolvedObject.Kind == "Node" ||
			(e.InvolvedObject.Kind == "ConfigMap" && e.InvolvedObject.Name == "cluster-autoscaler-status")
		if !relevant {
			continue
		}
		obj := e.InvolvedObject.Kind + "/" + e.InvolvedObject.Name
		if e.InvolvedObject.Namespace != "" {
			obj = e.InvolvedObject.Kind + "/" + e.InvolvedObject.Namespace + "/" + e.InvolvedObject.Name
		}
		out = append(out, Event{
			Ts:      rfc3339(eventTime(e)),
			Type:    e.Type,
			Reason:  e.Reason,
			Object:  obj,
			Message: e.Message,
			Cabinet: CabinetOf(e.Namespace, nil),
		})
		if len(out) == 50 {
			break
		}
	}
	return out
}

// ---- Capacity Climber ----

func (w *World) climberState(st *WorldState) ClimberState {
	ns := Namespace(CabinetClimber)
	out := ClimberState{Rungs: []Rung{}, ComputeClass: ClimberComputeClass{Name: "arcade-climber", Priorities: []ClimberPriority{}}}
	if d := w.deployment(ns, "climber"); d != nil {
		out.Replicas = int(d.Status.Replicas)
		out.Ready = int(d.Status.ReadyReplicas)
		if d.Spec.Replicas != nil {
			out.Desired = int(*d.Spec.Replicas)
		}
	}
	cc := w.getDyn(GVRComputeClass, "", "arcade-climber")
	for i, p := range slice(cc, "spec", "priorities") {
		pr := ClimberPriority{MachineFamily: mstr(p, "machineFamily"), Spot: mbool(p, "spot")}
		if pr.MachineFamily == "" {
			pr.MachineFamily = strings.SplitN(mstr(p, "machineType"), "-", 2)[0]
		}
		aff := mstr(p, "reservations", "affinity")
		pr.Locked = aff == "Specific" || aff == "AnyThenFail"
		if pr.Locked {
			out.ComputeClass.Locked = true
			if i == 0 {
				// While locked, spot:true is stripped from priorities[0] so
				// GKE accepts the Specific reservation rule; preserve Spot=true
				// in the derived state so rung #1 remains "n4d spot (locked)".
				pr.Spot = true
			}
		}
		out.ComputeClass.Priorities = append(out.ComputeClass.Priorities, pr)
		label := pr.MachineFamily + " on-demand"
		if pr.Spot {
			label = pr.MachineFamily + " spot"
		}
		if pr.Locked {
			label += " (locked)"
		}
		rung := Rung{Index: i, Label: label, Nodes: []string{}}
		for _, n := range st.Nodes {
			if n.ComputeClass == "arcade-climber" && n.MachineFamily == pr.MachineFamily && n.Spot == pr.Spot {
				rung.Nodes = append(rung.Nodes, n.Name)
				for _, pod := range st.Pods {
					if pod.Node == n.Name && pod.Cabinet == CabinetClimber && pod.Workload == "climber" && pod.Phase == "Running" {
						rung.Pods++
					}
				}
			}
		}
		out.Rungs = append(out.Rungs, rung)
	}
	return out
}

// ---- Spot On ----

// List-price estimates (USD per vCPU-hour, us-central1) used for the cost
// meter. Marked as an estimate in the UI.
var vcpuPrice = map[string][2]float64{ // family -> {on-demand, spot}
	"n4":  {0.0349, 0.0140},
	"n4d": {0.0303, 0.0121},
	"n2":  {0.0315, 0.0076},
	"n2d": {0.0274, 0.0066},
	"c3":  {0.0353, 0.0141},
	"c4":  {0.0376, 0.0150},
	"e2":  {0.0219, 0.0066},
	"t2d": {0.0265, 0.0064},
}

func priceFor(family string, spot bool) float64 {
	p, ok := vcpuPrice[family]
	if !ok {
		p = [2]float64{0.033, 0.012}
	}
	if spot {
		return p[1]
	}
	return p[0]
}

func cpuCores(s string) float64 {
	q, err := resource.ParseQuantity(s)
	if err != nil {
		return 0
	}
	return float64(q.MilliValue()) / 1000
}

func (w *World) spotState(st *WorldState) SpotState {
	ns := Namespace(CabinetSpot)
	out := SpotState{Stockout: w.Memory.Stockout(), Action: "FallbackToOnDemand"}
	if w.getDyn(GVRCapacityQuota, "", StockoutQuotaName) != nil {
		out.Stockout = true // the lever's quota exists (survives server restarts)
	}
	if d := w.deployment(ns, "checkout"); d != nil && d.Spec.Replicas != nil {
		out.Replicas = int(*d.Spec.Replicas)
	}
	wc := w.getDyn(GVRWorkloadClass, ns, "checkout")
	if wc != nil {
		out.SpotRatio = ParsePercent(str(wc, "spec", "capacityStrategy", "spotRatio"))
		if a := str(wc, "spec", "capacityStrategy", "action"); a != "" {
			out.Action = a
		}
		out.Validated = condTrue(wc, "Validated")
		out.InFallback = condTrue(wc, "InFallback")
	}
	nodeByName := map[string]Node{}
	for _, n := range st.Nodes {
		nodeByName[n.Name] = n
	}
	for _, p := range st.Pods {
		if p.Cabinet != CabinetSpot || p.Workload != "checkout" || p.Deleting {
			continue
		}
		if p.Node == "" || p.Phase == "Pending" {
			out.Counts.Pending++
			continue
		}
		n := nodeByName[p.Node]
		cores := cpuCores(p.CPU.Request)
		fam := n.MachineFamily
		out.CostPerHr.AllOnDemand += cores * priceFor(fam, false)
		out.CostPerHr.Current += cores * priceFor(fam, n.Spot)
		if n.Spot {
			out.Counts.Spot++
		} else {
			out.Counts.OnDemand++
			if p.Fallback != nil && *p.Fallback {
				out.Counts.Fallback++
			}
		}
	}
	out.CostPerHr.Current = round4(out.CostPerHr.Current)
	out.CostPerHr.AllOnDemand = round4(out.CostPerHr.AllOnDemand)
	if !out.InFallback && out.Counts.Fallback > 0 && wc == nil {
		out.InFallback = true
	}

	// Guardrail: any WorkloadClassGuardrail with gke-spot-placement parameters (prefer "arcade").
	grs := w.listDyn(GVRWorkloadClassGuardrail)
	sort.Slice(grs, func(i, j int) bool { return grs[i].GetName() == "arcade" })
	for _, g := range grs {
		for _, pc := range slice(g, "spec", "pluginConstraints", "placement") {
			if mstr(pc, "name") != "gke-spot-placement" {
				continue
			}
			out.Guardrail.MinSpotRatio = mstr(pc, "parameters", "minSpotRatio")
			out.Guardrail.MaxFallbackRatio = mstr(pc, "parameters", "fallback", "maxFallbackRatio")
		}
		if out.Guardrail.MinSpotRatio != "" || out.Guardrail.MaxFallbackRatio != "" {
			break
		}
	}
	// Placement policy referenced by the WorkloadClass (default arcade-spot).
	polName := str(wc, "spec", "infrastructureProfileRef", "name")
	if polName == "" {
		polName = "arcade-spot"
	}
	if pol := w.getDyn(GVRSpotPlacementPolicy, "", polName); pol != nil {
		out.Policy = SpotPolicy{Name: pol.GetName(), Reversion: str(pol, "spec", "reversion", "action")}
	} else {
		out.Policy = SpotPolicy{Name: polName}
	}
	return out
}

func round4(f float64) float64 { return float64(int64(f*10000+0.5)) / 10000 }

// ---- Pod Teleporter ----

func isArcadePod(p *corev1.Pod) bool {
	if p.Labels[LabelWorkload] != "" || p.Labels[LabelPartOf] == PartOfValue || p.Labels[LabelCabinet] != "" {
		return true
	}
	return false
}

// MigrationJobs returns cached Teleporter PodMigrationJobs, newest first (used by actions).
func (w *World) MigrationJobs() []MigrationJob { return w.migrationJobs() }

func (w *World) migrationJobs() []MigrationJob {
	ns := Namespace(CabinetTeleporter)
	petPod := w.Pod(ns, "pet-0")
	petMem, petConnected := w.Memory.Pet()
	var out []MigrationJob
	for _, u := range w.listDyn(GVRPodMigrationJob) {
		if u.GetNamespace() != ns {
			continue
		}
		j := MigrationJob{
			Name:           u.GetName(),
			Phase:          str(u, "status", "phase"),
			OriginNode:     str(u, "status", "originNodeName"),
			Snapshot:       str(u, "status", "snapshotRef"),
			StartedAt:      rfc3339(u.GetCreationTimestamp().Time),
			SnapshottingAt: normTime(str(u, "status", "snapshottingStartTime")),
			EvictingAt:     normTime(str(u, "status", "evictingStartTime")),
			RestoringAt:    normTime(str(u, "status", "restoringStartTime")),
			CompletedAt:    normTime(str(u, "status", "completionTime")),
			RestoredPod:    str(u, "status", "restoredPodName"),
			RestoredUID:    str(u, "status", "restoredPodUID"),
			TargetUID:      str(u, "spec", "targetPodUID"),
		}
		if j.Phase == "" {
			j.Phase = "Pending"
		}
		_, reason, _ := condition(u, "Restored")
		j.RestoredReason = reason
		// Promote Restoring -> Succeeded as soon as the replacement pet-0 pod is
		// Ready on the destination node or pet telemetry has reported a restore
		// since the migration started (without waiting for the controller's
		// default 30s restore-stabilization-window).
		if j.Phase == "Restoring" {
			started := parseTime(j.StartedAt)
			var readyAt time.Time
			podReady := false
			if petPod != nil && petPod.DeletionTimestamp == nil &&
				petPod.Spec.NodeName != "" && petPod.Spec.NodeName != j.OriginNode &&
				string(petPod.UID) != j.TargetUID {
				for _, c := range petPod.Status.Conditions {
					if c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue {
						podReady = true
						readyAt = c.LastTransitionTime.Time
						break
					}
				}
			}
			petRestored := petConnected && petMem != nil && petMem.RestoredAt != "" &&
				!started.IsZero() && parseTime(petMem.RestoredAt).After(started)
			if podReady || petRestored {
				j.Phase = "Succeeded"
				if j.RestoredReason == "" {
					j.RestoredReason = "RestoreInferred"
				}
				if petPod != nil && string(petPod.UID) != j.TargetUID {
					if j.RestoredPod == "" {
						j.RestoredPod = petPod.Name
					}
					if j.RestoredUID == "" {
						j.RestoredUID = string(petPod.UID)
					}
				}
				if j.CompletedAt == "" {
					if petRestored {
						j.CompletedAt = petMem.RestoredAt
					} else if !readyAt.IsZero() {
						j.CompletedAt = rfc3339(readyAt)
					} else {
						j.CompletedAt = rfc3339(time.Now())
					}
				}
			}
		}
		out = append(out, j)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StartedAt != out[j].StartedAt {
			return out[i].StartedAt > out[j].StartedAt
		}
		ti, tj := IsTerminalPMJ(out[i].Phase), IsTerminalPMJ(out[j].Phase)
		if ti != tj {
			return !ti
		}
		return out[i].Name > out[j].Name
	})
	return out
}

func normTime(s string) string {
	if s == "" {
		return ""
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return rfc3339(t)
	}
	return s
}

func parseTime(s string) time.Time {
	t, _ := time.Parse(time.RFC3339, s)
	return t
}

func (w *World) teleporterState(st *WorldState, jobs []MigrationJob) TeleporterState {
	out := TeleporterState{GvisorNodes: []string{}, Jobs: []MigrationJob{}}
	for _, n := range st.Nodes {
		if n.Gvisor && n.Ready && !n.Unschedulable && !n.Deleting {
			out.GvisorNodes = append(out.GvisorNodes, n.Name)
		}
	}
	_, connected := w.Memory.Pet()
	out.Pet.Connected = connected
	var petPod *Pod
	for i := range st.Pods {
		p := &st.Pods[i]
		if p.Cabinet == CabinetTeleporter && p.Workload == "pet" && !p.Deleting {
			if petPod == nil || p.Created > petPod.Created {
				petPod = p
			}
		}
	}
	if petPod == nil {
		for i := range st.Pods {
			p := &st.Pods[i]
			if p.Cabinet == CabinetTeleporter && p.Workload == "pet" {
				petPod = p
			}
		}
	}
	if petPod != nil {
		out.Pet.Pod, out.Pet.Node, out.Pet.UID = petPod.Name, petPod.Node, petPod.UID
	}
	// Map targetPodUID -> originNodeName so if a restored pod was later migrated
	// again, we still know which node it ran on.
	originByTargetUID := map[string]string{}
	for _, j := range jobs {
		if j.TargetUID != "" && j.OriginNode != "" {
			originByTargetUID[j.TargetUID] = j.OriginNode
		}
	}
	if len(jobs) > 10 {
		jobs = jobs[:10]
	}
	out.Jobs = append(out.Jobs, jobs...)

	// Last completed migration.
	for _, j := range jobs {
		if !IsTerminalPMJ(j.Phase) {
			continue
		}
		lm := &LastMigration{From: j.OriginNode, At: j.CompletedAt}
		if lm.At == "" {
			lm.At = j.StartedAt
		}
		var restoredPod *Pod
		for i := range st.Pods {
			p := &st.Pods[i]
			if p.Namespace != Namespace(CabinetTeleporter) {
				continue
			}
			if j.RestoredUID != "" {
				if p.UID == j.RestoredUID {
					restoredPod = p
					break
				}
			} else if j.RestoredPod != "" && p.Name == j.RestoredPod {
				restoredPod = p
				break
			}
		}
		if restoredPod != nil {
			lm.To = restoredPod.Node
		}
		if lm.To == "" && j.RestoredUID != "" {
			lm.To = originByTargetUID[j.RestoredUID]
		}
		if lm.To == "" && petPod != nil && j.Phase != "Failed" && (j.RestoredUID == "" || petPod.UID == j.RestoredUID) {
			lm.To = petPod.Node
		}
		if lm.To == "" && j.Phase != "Failed" && j.OriginNode != "" {
			for _, gn := range out.GvisorNodes {
				if gn != j.OriginNode {
					lm.To = gn
					break
				}
			}
		}
		switch {
		case j.Phase == "Failed":
			lm.Restored = "failed"
		case j.Phase == "SucceededWithoutRestore":
			lm.Restored = "lost"
		case j.RestoredReason == "RestoreVerified":
			lm.Restored = "verified"
		case j.RestoredReason == "RestoreInferred":
			lm.Restored = "inferred"
		default:
			lm.Restored = "inferred"
		}
		if lm.Restored == "verified" || lm.Restored == "inferred" {
			start := parseTime(j.SnapshottingAt)
			if start.IsZero() {
				start = parseTime(j.StartedAt)
			}
			end := time.Time{}
			comp := parseTime(j.CompletedAt)
			if pet, _ := w.Memory.Pet(); pet != nil && pet.RestoredAt != "" {
				if t := parseTime(pet.RestoredAt); t.After(start) && (comp.IsZero() || !t.After(comp.Add(10*time.Second))) {
					end = t
				}
			}
			if end.IsZero() && restoredPod != nil && restoredPod.ReadyAt != "" {
				end = parseTime(restoredPod.ReadyAt)
			}
			if end.IsZero() {
				end = comp
			}
			if !start.IsZero() && end.After(start) {
				lm.DowntimeMs = end.Sub(start).Milliseconds()
			}
		}
		out.LastMigration = lm
		break
	}
	return out
}

// ---- Shock Absorber ----

func (w *World) absorberState(st *WorldState) AbsorberState {
	ns := Namespace(CabinetAbsorber)
	out := AbsorberState{Preset: "none", Buffers: []BufferState{}, Burst: BurstState{PerPodReadyMs: []int64{}}}
	active, standby := 0, 0
	unitCPU := 0.5
	for _, name := range []string{"absorber-active", "absorber-standby"} {
		u := w.getDyn(GVRCapacityBuffer, ns, name)
		if u == nil {
			continue
		}
		b := BufferState{Name: name, Strategy: "active", Replicas: int(num(u, "spec", "replicas")), StatusReplicas: int(num(u, "status", "replicas"))}
		if strings.Contains(str(u, "spec", "provisioningStrategy"), "standby") {
			b.Strategy = "standby"
		}
		// 1.37.1 exposes ReadyForProvisioning / Provisioning / LimitedByQuotas
		// (no "Ready" type): Provisioning=True means the buffer is up.
		b.Ready = condTrue(u, "Ready") || condTrue(u, "Provisioning")
		b.LimitedByQuota = condTrue(u, "LimitedByQuotas")
		if b.Strategy == "standby" {
			standby += b.Replicas
		} else {
			active += b.Replicas
		}
		out.Buffers = append(out.Buffers, b)
	}
	switch {
	case active == 0 && standby == 0:
		out.Preset = "none"
	case standby > 0 && active == 0:
		out.Preset = "standby8"
	case active <= 4 && standby == 0:
		out.Preset = "active4"
	case standby == 0:
		out.Preset = "active8"
	default:
		out.Preset = "custom"
	}

	// Burst stopwatch.
	started, target, priorUIDs := w.Memory.BurstInfo()
	if d := w.deployment(ns, "burst-worker"); d != nil {
		if d.Spec.Replicas != nil {
			out.Burst.Desired = int(*d.Spec.Replicas)
		}
		out.Burst.Ready = int(d.Status.ReadyReplicas)
	}
	if !started.IsZero() && target > out.Burst.Desired {
		out.Burst.Desired = target
	}
	if !started.IsZero() {
		out.Burst.StartedAt = rfc3339(started)
		var last time.Time
		readyCount := 0
		for _, p := range st.Pods {
			if p.Cabinet != CabinetAbsorber || p.Workload != "burst-worker" || p.Deleting || priorUIDs[p.UID] {
				continue
			}
			created := parseTime(p.Created)
			if created.Before(started.Add(-2 * time.Second)) {
				continue
			}
			if p.ReadyAt != "" {
				ra := parseTime(p.ReadyAt)
				out.Burst.PerPodReadyMs = append(out.Burst.PerPodReadyMs, ra.Sub(started).Milliseconds())
				if ra.After(last) {
					last = ra
				}
				readyCount++
			}
		}
		sort.Slice(out.Burst.PerPodReadyMs, func(i, j int) bool { return out.Burst.PerPodReadyMs[i] < out.Burst.PerPodReadyMs[j] })
		needNew := out.Burst.Desired - len(priorUIDs)
		if needNew < 1 {
			needNew = 1
		}
		if out.Burst.Desired > 0 && readyCount >= needNew {
			out.Burst.AllReadyAt = rfc3339(last)
		}
	}

	// Headroom cost: buffer nodes (fenced by ComputeClass arcade-absorber) that
	// carry no burst pods. Suspended nodes are billed for disk only (~0.1x).
	for _, n := range st.Nodes {
		if n.ComputeClass != "arcade-absorber" || n.Creating {
			continue
		}
		price := n.CPU.Allocatable * priceFor(n.MachineFamily, n.Spot)
		if n.Suspended {
			price *= 0.1
		}
		out.HeadroomCostPerHour += price
	}
	out.HeadroomCostPerHour = round4(out.HeadroomCostPerHour)

	// Ghost pods for buffer headroom: CA simulates placeholder pods, so we
	// synthesise them onto absorber nodes with free capacity (name ghost-<buffer>-<n>).
	for _, b := range out.Buffers {
		if b.StatusReplicas == 0 {
			continue
		}
		free := map[string]float64{}
		var order []string
		for _, n := range st.Nodes {
			if n.ComputeClass == "arcade-absorber" && !n.Creating && (b.Strategy != "standby" || n.Suspended) && (b.Strategy == "standby" || !n.Suspended) {
				free[n.Name] = n.CPU.Allocatable - n.CPU.Requested
				order = append(order, n.Name)
			}
		}
		for i := 1; i <= b.StatusReplicas; i++ {
			g := Pod{
				UID:       "ghost-" + b.Name + "-" + itoa(i),
				Name:      "ghost-" + b.Name + "-" + itoa(i),
				Namespace: ns,
				Cabinet:   CabinetAbsorber,
				Workload:  "burst-unit",
				Phase:     "Pending",
				Buffer:    true,
				CPU:       PodCPU{Request: "500m"},
				Created:   st.Ts,
			}
			for _, name := range order {
				if free[name] >= unitCPU {
					free[name] -= unitCPU
					g.Node = name
					g.Phase = "Running"
					g.Ready = true
					break
				}
			}
			st.Pods = append(st.Pods, g)
		}
	}
	return out
}

// ---- Lights Out ----

func (w *World) lightsState() LightsState {
	ns := Namespace(CabinetLights)
	out := LightsState{MetricName: "autoscaling.gke.io|coin-queue|arcade_queue_depth"}
	out.QueueDepth, out.Processed = w.Memory.QueueDepth()
	h := w.hpa(ns, "coin-worker")
	if h == nil {
		return out
	}
	out.HPA.Current = int(h.Status.CurrentReplicas)
	out.HPA.Desired = int(h.Status.DesiredReplicas)
	out.HPA.Max = int(h.Spec.MaxReplicas)
	if h.Spec.MinReplicas != nil {
		out.HPA.Min = int(*h.Spec.MinReplicas)
	}
	if h.Status.LastScaleTime != nil {
		out.HPA.LastScale = rfc3339(h.Status.LastScaleTime.Time)
	}
	for _, c := range h.Status.Conditions {
		switch string(c.Type) {
		case "ScaledToZero":
			out.HPA.ScaledToZero = c.Status == corev1.ConditionTrue
		case "ScalingActive":
			out.HPA.ScalingActive = c.Status == corev1.ConditionTrue
		}
	}
	if out.HPA.Current > 0 || out.HPA.Desired > 0 || out.QueueDepth > 0 {
		out.HPA.ScaledToZero = false
	}
	for _, m := range h.Spec.Metrics {
		if m.External != nil {
			out.MetricName = m.External.Metric.Name
		}
	}
	for _, m := range h.Status.CurrentMetrics {
		if m.External != nil {
			var q *resource.Quantity
			if m.External.Current.AverageValue != nil {
				q = m.External.Current.AverageValue
			} else if m.External.Current.Value != nil {
				q = m.External.Current.Value
			}
			if q != nil {
				v := float64(q.MilliValue()) / 1000
				// While scaled to zero the HPA reports math.MinInt64 (no
				// pods to average over): that is "no value", not a number.
				if v > -1e15 {
					out.HPA.MetricValue = &v
				}
			}
		}
	}
	if am := w.getDyn(GVRAutoscalingMetric, ns, "coin-queue"); am != nil {
		for _, ms := range slice(am, "status", "metricStatuses") {
			if n := mstr(ms, "hpaName"); n != "" {
				out.MetricName = n
			}
		}
	}
	return out
}

// ---- Nitro ----

func (w *World) nitroState(st *WorldState, k8sPods []*corev1.Pod, evs []*corev1.Event) NitroState {
	ns := Namespace(CabinetNitro)
	out := NitroState{}
	if vpa := w.getDyn(GVRVPA, ns, "nitro"); vpa != nil {
		out.VPA.UpdateMode = str(vpa, "spec", "updatePolicy", "updateMode")
		out.VPA.Factor = num(vpa, "spec", "startupBoost", "cpu", "factor")
		out.VPA.DurationSeconds = int(num(vpa, "spec", "startupBoost", "cpu", "durationSeconds"))
		if out.VPA.Factor == 0 {
			for _, cp := range slice(vpa, "spec", "resourcePolicy", "containerPolicies") {
				if f, ok, _ := unstructured.NestedFieldNoCopy(cp, "startupBoost", "cpu", "factor"); ok {
					switch t := f.(type) {
					case int64:
						out.VPA.Factor = float64(t)
					case float64:
						out.VPA.Factor = t
					}
				}
			}
		}
	}
	started, priorUIDs := w.Memory.RaceInfo()
	if started.IsZero() {
		return out
	}
	race := &Race{StartedAt: rfc3339(started), Lanes: []Lane{}}
	unboostEvents := map[string]time.Time{} // pod name -> InPlaceResizedByVPA time
	for _, e := range evs {
		if e.Namespace == ns && e.InvolvedObject.Kind == "Pod" && (e.Reason == "InPlaceResizedByVPA" || e.Reason == "ResizeCompleted") {
			if t := eventTime(e); t.After(unboostEvents[e.InvolvedObject.Name]) {
				unboostEvents[e.InvolvedObject.Name] = t
			}
		}
	}
	for _, name := range []string{"stock", "nitro"} {
		lane := Lane{Name: name}
		var pick *Pod
		for i := range st.Pods {
			p := &st.Pods[i]
			if p.Cabinet != CabinetNitro || p.Workload != name || p.Buffer || priorUIDs[p.UID] {
				continue
			}
			if parseTime(p.Created).Before(started.Add(-2 * time.Second)) {
				continue
			}
			if pick == nil || p.Created > pick.Created {
				pick = p
			}
		}
		if pick != nil {
			lane.Pod = pick.Name
			lane.CreatedAt = pick.Created
			lane.ReadyAt = pick.ReadyAt
			lane.CPURequest = pick.CPU.Request
			if pick.Boost != nil {
				lane.Boosted = true
				lane.CPUOriginal = pick.Boost.CPUOriginal
				lane.CPURequest = pick.Boost.CPURequest
				if !pick.Boost.Active {
					w.unboostMu.Lock()
					t, ok := w.unboostAt[pick.UID]
					if !ok {
						t = time.Now()
						if et, ok := unboostEvents[pick.Name]; ok {
							t = et
						}
						w.unboostAt[pick.UID] = t
					}
					w.unboostMu.Unlock()
					lane.UnboostedAt = rfc3339(t)
				}
			}
		}
		race.Lanes = append(race.Lanes, lane)
	}
	winner := ""
	var best time.Time
	for _, l := range race.Lanes {
		if l.ReadyAt == "" {
			continue
		}
		t := parseTime(l.ReadyAt)
		if winner == "" || t.Before(best) {
			winner, best = l.Name, t
		}
	}
	if winner != "" {
		allReady := true
		for _, l := range race.Lanes {
			if l.ReadyAt == "" && l.Pod != "" {
				allReady = false
			}
		}
		if allReady {
			race.Winner = winner
		}
	}
	out.Race = race
	return out
}
