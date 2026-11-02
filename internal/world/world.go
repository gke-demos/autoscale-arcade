package world

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/cache"
	"k8s.io/client-go/tools/clientcmd"
)

// GVRs of the custom resources the arcade watches.
var (
	GVRComputeClass           = schema.GroupVersionResource{Group: "cloud.google.com", Version: "v1", Resource: "computeclasses"}
	GVRCapacityBuffer         = schema.GroupVersionResource{Group: "autoscaling.x-k8s.io", Version: "v1beta1", Resource: "capacitybuffers"}
	GVRAutoscalingMetric      = schema.GroupVersionResource{Group: "autoscaling.gke.io", Version: "v1beta1", Resource: "autoscalingmetrics"}
	GVRVPA                    = schema.GroupVersionResource{Group: "autoscaling.k8s.io", Version: "v1", Resource: "verticalpodautoscalers"}
	GVRWorkloadClass          = schema.GroupVersionResource{Group: "workloads.gke.io", Version: "v1", Resource: "workloadclasses"}
	GVRSpotPlacementPolicy    = schema.GroupVersionResource{Group: "workloads.gke.io", Version: "v1", Resource: "gkespotplacementpolicies"}
	GVRWorkloadClassGuardrail = schema.GroupVersionResource{Group: "workloads.gke.io", Version: "v1", Resource: "workloadclassguardrails"}
	GVRPodMigrationJob        = schema.GroupVersionResource{Group: "podmigration.gke.io", Version: "v1alpha1", Resource: "podmigrationjobs"}
	GVRPodSnapshot            = schema.GroupVersionResource{Group: "podsnapshot.gke.io", Version: "v1", Resource: "podsnapshots"}
)

var crdGVRs = []schema.GroupVersionResource{
	GVRComputeClass, GVRCapacityBuffer, GVRAutoscalingMetric, GVRVPA,
	GVRWorkloadClass, GVRSpotPlacementPolicy, GVRWorkloadClassGuardrail,
	GVRPodMigrationJob, GVRPodSnapshot,
}

// Config configures a World.
type Config struct {
	Kubeconfig string // "" = in-cluster
	Cluster    string // overrides derived cluster name
	Project    string
	Region     string
}

// Clients bundles the Kubernetes clients used by world and actions.
type Clients struct {
	Rest      *rest.Config
	Kube      kubernetes.Interface
	Dynamic   dynamic.Interface
	Discovery discovery.DiscoveryInterface
}

// NewClients builds clients from a kubeconfig path or in-cluster config.
func NewClients(kubeconfig string) (*Clients, error) {
	var cfg *rest.Config
	var err error
	if kubeconfig != "" {
		cfg, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
	} else {
		cfg, err = rest.InClusterConfig()
		if err != nil {
			if home, _ := os.UserHomeDir(); home != "" {
				cfg, err = clientcmd.BuildConfigFromFlags("", home+"/.kube/config")
			}
		}
	}
	if err != nil {
		return nil, fmt.Errorf("kube config: %w", err)
	}
	cfg.QPS = 50
	cfg.Burst = 100
	cfg.UserAgent = "arcade-server"
	kube, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	return &Clients{Rest: cfg, Kube: kube, Dynamic: dyn, Discovery: kube.Discovery()}, nil
}

// World owns the informers and produces WorldState snapshots.
type World struct {
	cfg     Config
	Clients *Clients
	Memory  *Memory
	log     *slog.Logger

	factory informers.SharedInformerFactory
	dynFact dynamicinformer.DynamicSharedInformerFactory

	nodes       cache.SharedIndexInformer
	pods        cache.SharedIndexInformer
	events      cache.SharedIndexInformer
	deployments cache.SharedIndexInformer
	statefulset cache.SharedIndexInformer
	hpas        cache.SharedIndexInformer
	caConfigMap cache.SharedIndexInformer

	mu      sync.RWMutex
	dyn     map[schema.GroupVersionResource]cache.SharedIndexInformer
	missing map[schema.GroupVersionResource]bool // CRDs not installed (yet)
	version string

	// Scenario state is owned by the scenario runner and merged into snapshots.
	scenarioMu sync.RWMutex
	scenario   ScenarioState

	changed chan struct{}

	// race bookkeeping: first time a lane's container was seen unboosted
	unboostMu sync.Mutex
	unboostAt map[string]time.Time // pod uid -> time
}

// New creates a World (informers are started by Run).
func New(cfg Config, clients *Clients, log *slog.Logger) *World {
	w := &World{
		cfg:       cfg,
		Clients:   clients,
		log:       log,
		dyn:       map[schema.GroupVersionResource]cache.SharedIndexInformer{},
		missing:   map[schema.GroupVersionResource]bool{},
		changed:   make(chan struct{}, 1),
		unboostAt: map[string]time.Time{},
	}
	w.Memory = NewMemory(w.notify)
	return w
}

// Changed returns a channel that receives a tick whenever the world changed.
// Ticks are coalesced; consumers should debounce further.
func (w *World) Changed() <-chan struct{} { return w.changed }

func (w *World) notify() {
	select {
	case w.changed <- struct{}{}:
	default:
	}
}

// SetScenario publishes the scenario runner's state into snapshots.
func (w *World) SetScenario(s ScenarioState) {
	w.scenarioMu.Lock()
	w.scenario = s
	w.scenarioMu.Unlock()
	w.notify()
}

// ScenarioState returns the current scenario state.
func (w *World) ScenarioState() ScenarioState {
	w.scenarioMu.RLock()
	defer w.scenarioMu.RUnlock()
	return w.scenario
}

var handler = func(w *World) cache.ResourceEventHandler {
	return cache.ResourceEventHandlerFuncs{
		AddFunc:    func(any) { w.notify() },
		UpdateFunc: func(_, _ any) { w.notify() },
		DeleteFunc: func(any) { w.notify() },
	}
}

// Run starts all informers and blocks until ctx is done.
func (w *World) Run(ctx context.Context) error {
	if v, err := w.Clients.Discovery.ServerVersion(); err == nil {
		w.mu.Lock()
		w.version = v.GitVersion
		w.mu.Unlock()
	} else {
		w.log.Warn("server version", "err", err)
	}

	w.factory = informers.NewSharedInformerFactory(w.Clients.Kube, 0)
	w.nodes = w.factory.Core().V1().Nodes().Informer()
	w.pods = w.factory.Core().V1().Pods().Informer()
	w.events = w.factory.Core().V1().Events().Informer()
	w.deployments = w.factory.Apps().V1().Deployments().Informer()
	w.statefulset = w.factory.Apps().V1().StatefulSets().Informer()
	w.hpas = w.factory.Autoscaling().V2().HorizontalPodAutoscalers().Informer()
	cmFactory := informers.NewSharedInformerFactoryWithOptions(w.Clients.Kube, 0,
		informers.WithNamespace("kube-system"),
		informers.WithTweakListOptions(func(o *metav1.ListOptions) { o.FieldSelector = "metadata.name=cluster-autoscaler-status" }))
	w.caConfigMap = cmFactory.Core().V1().ConfigMaps().Informer()

	for _, inf := range []cache.SharedIndexInformer{w.nodes, w.pods, w.events, w.deployments, w.statefulset, w.hpas, w.caConfigMap} {
		_, _ = inf.AddEventHandler(handler(w))
	}
	w.factory.Start(ctx.Done())
	cmFactory.Start(ctx.Done())
	w.factory.WaitForCacheSync(ctx.Done())
	cmFactory.WaitForCacheSync(ctx.Done())
	w.log.Info("core informers synced")

	w.dynFact = dynamicinformer.NewDynamicSharedInformerFactory(w.Clients.Dynamic, 0)
	w.ensureCRDInformers(ctx)
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				w.ensureCRDInformers(ctx)
				w.notify() // keeps pet "connected" / timers fresh
			}
		}
	}()
	go func() {
		t := time.NewTicker(2 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				// Pet connectivity and stopwatch fields depend on wall time.
				w.notify()
			}
		}
	}()
	<-ctx.Done()
	return nil
}

// ensureCRDInformers starts an informer for each CRD GVR that exists on the
// API server and has not been started yet. Missing CRDs are degraded honestly:
// their cabinet state is empty and Missing() reports them.
func (w *World) ensureCRDInformers(ctx context.Context) {
	_, lists, err := w.Clients.Discovery.ServerGroupsAndResources()
	if err != nil && len(lists) == 0 {
		w.log.Warn("discovery", "err", err)
		return
	}
	have := map[schema.GroupVersionResource]bool{}
	for _, l := range lists {
		gv, err := schema.ParseGroupVersion(l.GroupVersion)
		if err != nil {
			continue
		}
		for _, r := range l.APIResources {
			have[gv.WithResource(r.Name)] = true
		}
	}
	var started []cache.SharedIndexInformer
	w.mu.Lock()
	for _, gvr := range crdGVRs {
		if _, ok := w.dyn[gvr]; ok {
			continue
		}
		if !have[gvr] {
			if !w.missing[gvr] {
				w.log.Warn("CRD not installed; cabinet will degrade", "gvr", gvr.String())
			}
			w.missing[gvr] = true
			continue
		}
		inf := w.dynFact.ForResource(gvr).Informer()
		_, _ = inf.AddEventHandler(handler(w))
		w.dyn[gvr] = inf
		delete(w.missing, gvr)
		started = append(started, inf)
		w.log.Info("watching", "gvr", gvr.String())
	}
	w.mu.Unlock()
	if len(started) > 0 {
		w.dynFact.Start(ctx.Done())
		for _, inf := range started {
			cache.WaitForCacheSync(ctx.Done(), inf.HasSynced)
		}
		w.notify()
	}
}

// Missing lists CRDs that are not installed.
func (w *World) Missing() []string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	var out []string
	for gvr := range w.missing {
		out = append(out, gvr.GroupResource().String())
	}
	return out
}

// listDyn returns the unstructured objects of a CRD informer (nil if absent).
func (w *World) listDyn(gvr schema.GroupVersionResource) []*unstructured.Unstructured {
	w.mu.RLock()
	inf, ok := w.dyn[gvr]
	w.mu.RUnlock()
	if !ok {
		return nil
	}
	var out []*unstructured.Unstructured
	for _, o := range inf.GetStore().List() {
		if u, ok := o.(*unstructured.Unstructured); ok {
			out = append(out, u)
		}
	}
	return out
}

// getDyn returns one object (namespace "" for cluster-scoped).
func (w *World) getDyn(gvr schema.GroupVersionResource, namespace, name string) *unstructured.Unstructured {
	for _, u := range w.listDyn(gvr) {
		if u.GetName() == name && (namespace == "" || u.GetNamespace() == namespace) {
			return u
		}
	}
	return nil
}

// HasCRD reports whether the CRD informer is running.
func (w *World) HasCRD(gvr schema.GroupVersionResource) bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	_, ok := w.dyn[gvr]
	return ok
}
