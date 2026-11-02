// Package world turns live cluster objects into the WorldState described in
// docs/contracts.md. Nothing in here is simulated: every field is derived from
// a real Kubernetes object (or from the arcade server's own bookkeeping, which
// is flagged as such, e.g. the stockout lever and the coin queue).
package world

import "time"

// WorldState is the full snapshot streamed to the UI. Field names and shapes
// are the binding contract in docs/contracts.md.
type WorldState struct {
	Ts       string        `json:"ts"`
	Cluster  Cluster       `json:"cluster"`
	Nodes    []Node        `json:"nodes"`
	Pods     []Pod         `json:"pods"`
	Cabinets Cabinets      `json:"cabinets"`
	Scenario ScenarioState `json:"scenario"`
	Events   []Event       `json:"events"`
}

type Cluster struct {
	Name       string     `json:"name"`
	Version    string     `json:"version"`
	Project    string     `json:"project"`
	Region     string     `json:"region"`
	Autoscaler Autoscaler `json:"autoscaler"`
}

type Autoscaler struct {
	Status              string      `json:"status"`
	ScaleUp             string      `json:"scaleUp"`
	ScaleDown           string      `json:"scaleDown"`
	ScaleDownCandidates int         `json:"scaleDownCandidates"`
	NodeGroups          []NodeGroup `json:"nodeGroups"`
	Updated             string      `json:"updated"`
}

type NodeGroup struct {
	Name    string `json:"name"`
	Pool    string `json:"pool"`
	Zone    string `json:"zone"`
	Ready   int    `json:"ready"`
	Total   int    `json:"total"`
	Target  int    `json:"target"`
	Min     int    `json:"min"`
	Max     int    `json:"max"`
	ScaleUp string `json:"scaleUp"`
	Backoff string `json:"backoff,omitempty"`
}

type Resource struct {
	Allocatable float64 `json:"allocatable"`
	Requested   float64 `json:"requested"`
}

type Node struct {
	Name          string   `json:"name"`
	Pool          string   `json:"pool"`
	Zone          string   `json:"zone"`
	MachineType   string   `json:"machineType"`
	MachineFamily string   `json:"machineFamily"`
	Spot          bool     `json:"spot"`
	ComputeClass  string   `json:"computeClass,omitempty"`
	Gvisor        bool     `json:"gvisor"`
	Buffer        string   `json:"buffer,omitempty"` // "active" | "standby"
	Ready         bool     `json:"ready"`
	Unschedulable bool     `json:"unschedulable"`
	Suspended     bool     `json:"suspended"`
	Creating      bool     `json:"creating"`
	Deleting      bool     `json:"deleting"`
	Created       string   `json:"created"`
	CPU           Resource `json:"cpu"`
	Memory        Resource `json:"memory"`
}

type PodCPU struct {
	Request string `json:"request"`
	Actual  string `json:"actual,omitempty"`
}

type Boost struct {
	Active      bool   `json:"active"`
	CPURequest  string `json:"cpuRequest"`
	CPUOriginal string `json:"cpuOriginal"`
}

type PodMigrationRef struct {
	Job   string `json:"job"`
	Phase string `json:"phase"`
}

type Pod struct {
	UID           string           `json:"uid"`
	Name          string           `json:"name"`
	Namespace     string           `json:"namespace"`
	Cabinet       string           `json:"cabinet"`
	Workload      string           `json:"workload"`
	Node          string           `json:"node,omitempty"`
	Phase         string           `json:"phase"`
	Ready         bool             `json:"ready"`
	Deleting      bool             `json:"deleting"`
	PendingReason string           `json:"pendingReason,omitempty"`
	Created       string           `json:"created"`
	ScheduledAt   string           `json:"scheduledAt,omitempty"`
	ReadyAt       string           `json:"readyAt,omitempty"`
	Spot          *bool            `json:"spot,omitempty"`
	Placement     string           `json:"placement,omitempty"` // "spot" | "on-demand"
	Fallback      *bool            `json:"fallback,omitempty"`
	Boost         *Boost           `json:"boost,omitempty"`
	CPU           PodCPU           `json:"cpu"`
	Migration     *PodMigrationRef `json:"migration,omitempty"`
	Buffer        bool             `json:"buffer,omitempty"`
}

type Event struct {
	Ts      string `json:"ts"`
	Type    string `json:"type"`
	Reason  string `json:"reason"`
	Object  string `json:"object"`
	Message string `json:"message"`
	Cabinet string `json:"cabinet,omitempty"`
}

type Cabinets struct {
	Climber    ClimberState    `json:"climber"`
	Spot       SpotState       `json:"spot"`
	Teleporter TeleporterState `json:"teleporter"`
	Absorber   AbsorberState   `json:"absorber"`
	Lights     LightsState     `json:"lights"`
	Nitro      NitroState      `json:"nitro"`
}

// --- Capacity Climber ---

type ClimberPriority struct {
	MachineFamily string `json:"machineFamily"`
	Spot          bool   `json:"spot"`
	Locked        bool   `json:"locked"`
}

type ClimberComputeClass struct {
	Name       string            `json:"name"`
	Locked     bool              `json:"locked"`
	Priorities []ClimberPriority `json:"priorities"`
}

type Rung struct {
	Index int      `json:"index"`
	Label string   `json:"label"`
	Nodes []string `json:"nodes"`
	Pods  int      `json:"pods"`
}

type ClimberState struct {
	Replicas     int                 `json:"replicas"`
	Desired      int                 `json:"desired"`
	Ready        int                 `json:"ready"`
	ComputeClass ClimberComputeClass `json:"computeClass"`
	Rungs        []Rung              `json:"rungs"`
}

// --- Spot On ---

type SpotCounts struct {
	Spot     int `json:"spot"`
	OnDemand int `json:"onDemand"`
	Fallback int `json:"fallback"`
	Pending  int `json:"pending"`
}

type SpotCost struct {
	Current     float64 `json:"current"`
	AllOnDemand float64 `json:"allOnDemand"`
}

type SpotGuardrail struct {
	MinSpotRatio     string `json:"minSpotRatio"`
	MaxFallbackRatio string `json:"maxFallbackRatio"`
}

type SpotPolicy struct {
	Name      string `json:"name"`
	Reversion string `json:"reversion"`
}

type SpotState struct {
	Replicas   int           `json:"replicas"`
	SpotRatio  int           `json:"spotRatio"`
	Action     string        `json:"action"`
	Validated  bool          `json:"validated"`
	InFallback bool          `json:"inFallback"`
	Counts     SpotCounts    `json:"counts"`
	Stockout   bool          `json:"stockout"`
	CostPerHr  SpotCost      `json:"costPerHour"`
	Guardrail  SpotGuardrail `json:"guardrail"`
	Policy     SpotPolicy    `json:"policy"`
}

// --- Pod Teleporter ---

type PetRef struct {
	Pod       string `json:"pod,omitempty"`
	Node      string `json:"node,omitempty"`
	Connected bool   `json:"connected"`
	UID       string `json:"uid,omitempty"`
}

type MigrationJob struct {
	Name           string `json:"name"`
	Phase          string `json:"phase"`
	OriginNode     string `json:"originNode,omitempty"`
	Snapshot       string `json:"snapshot,omitempty"`
	StartedAt      string `json:"startedAt"`
	SnapshottingAt string `json:"snapshottingAt,omitempty"`
	EvictingAt     string `json:"evictingAt,omitempty"`
	RestoringAt    string `json:"restoringAt,omitempty"`
	CompletedAt    string `json:"completedAt,omitempty"`
	RestoredReason string `json:"restoredReason,omitempty"`
	RestoredPod    string `json:"restoredPod,omitempty"`
}

type LastMigration struct {
	From       string `json:"from"`
	To         string `json:"to"`
	DowntimeMs int64  `json:"downtimeMs"`
	Restored   string `json:"restored"` // verified | inferred | lost | failed
	At         string `json:"at"`
}

type TeleporterState struct {
	Pet           PetRef         `json:"pet"`
	GvisorNodes   []string       `json:"gvisorNodes"`
	Jobs          []MigrationJob `json:"jobs"`
	LastMigration *LastMigration `json:"lastMigration,omitempty"`
}

// PetState is the telemetry the pet process streams to the server (POST /api/pet
// or WebSocket /api/pet/ws). The server relays it to the UI as {type:"pet"}.
type PetState struct {
	Pod        string  `json:"pod"`
	Node       string  `json:"node"`
	Ticks      int64   `json:"ticks"`
	Score      int64   `json:"score"`
	Lives      int     `json:"lives"`
	UptimeSec  float64 `json:"uptimeSec"`
	Ball       Ball    `json:"ball"`
	RestoredAt string  `json:"restoredAt,omitempty"`
	BornAt     string  `json:"bornAt"`
}

type Ball struct {
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
	VX float64 `json:"vx"`
	VY float64 `json:"vy"`
}

// --- Shock Absorber ---

type BufferState struct {
	Name           string `json:"name"`
	Strategy       string `json:"strategy"` // active | standby
	Replicas       int    `json:"replicas"`
	StatusReplicas int    `json:"statusReplicas"`
	Ready          bool   `json:"ready"`
	LimitedByQuota bool   `json:"limitedByQuota"`
}

type BurstState struct {
	Desired       int     `json:"desired"`
	Ready         int     `json:"ready"`
	StartedAt     string  `json:"startedAt,omitempty"`
	AllReadyAt    string  `json:"allReadyAt,omitempty"`
	PerPodReadyMs []int64 `json:"perPodReadyMs"`
}

type AbsorberState struct {
	Preset             string        `json:"preset"`
	Buffers            []BufferState `json:"buffers"`
	Burst              BurstState    `json:"burst"`
	HeadroomCostPerHour float64      `json:"headroomCostPerHour"`
}

// --- Lights Out ---

type HPAState struct {
	Current       int      `json:"current"`
	Desired       int      `json:"desired"`
	Min           int      `json:"min"`
	Max           int      `json:"max"`
	ScaledToZero  bool     `json:"scaledToZero"`
	ScalingActive bool     `json:"scalingActive"`
	MetricValue   *float64 `json:"metricValue,omitempty"`
	LastScale     string   `json:"lastScale,omitempty"`
}

type LightsState struct {
	QueueDepth int      `json:"queueDepth"`
	Processed  int      `json:"processed"`
	HPA        HPAState `json:"hpa"`
	MetricName string   `json:"metricName"`
}

// --- Nitro ---

type Lane struct {
	Name        string `json:"name"` // stock | nitro
	Boosted     bool   `json:"boosted"`
	Pod         string `json:"pod,omitempty"`
	CreatedAt   string `json:"createdAt,omitempty"`
	ReadyAt     string `json:"readyAt,omitempty"`
	CPURequest  string `json:"cpuRequest,omitempty"`
	CPUOriginal string `json:"cpuOriginal,omitempty"`
	UnboostedAt string `json:"unboostedAt,omitempty"`
}

type Race struct {
	StartedAt string `json:"startedAt"`
	Lanes     []Lane `json:"lanes"`
	Winner    string `json:"winner,omitempty"`
}

type VPAState struct {
	Factor          float64 `json:"factor"`
	DurationSeconds int     `json:"durationSeconds"`
	UpdateMode      string  `json:"updateMode"`
}

type NitroState struct {
	Race *Race    `json:"race,omitempty"`
	VPA  VPAState `json:"vpa"`
}

// --- Scenario ---

type ScenarioState struct {
	Running   bool   `json:"running"`
	Name      string `json:"name,omitempty"`
	Cabinet   string `json:"cabinet,omitempty"`
	Step      int    `json:"step"`
	Steps     int    `json:"steps"`
	Caption   string `json:"caption,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`
	Error     string `json:"error,omitempty"`
	Attract   bool   `json:"attract"`
}

// Cabinet ids, namespaces and label keys per docs/contracts.md.
const (
	CabinetClimber    = "climber"
	CabinetSpot       = "spot"
	CabinetTeleporter = "teleporter"
	CabinetAbsorber   = "absorber"
	CabinetLights     = "lights"
	CabinetNitro      = "nitro"

	NamespaceSystem = "arcade-system"

	LabelPartOf   = "app.kubernetes.io/part-of"
	LabelCabinet  = "arcade.gke.io/cabinet"
	LabelWorkload = "arcade.gke.io/workload"
	PartOfValue   = "autoscale-arcade"
)

// CabinetIDs in lobby order.
var CabinetIDs = []string{CabinetClimber, CabinetSpot, CabinetTeleporter, CabinetAbsorber, CabinetLights, CabinetNitro}

// Namespace returns the workload namespace of a cabinet.
func Namespace(cabinet string) string { return "arcade-" + cabinet }

func rfc3339(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
