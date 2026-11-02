package actions

import (
	"context"
	"fmt"
	"sync"

	compute "google.golang.org/api/compute/v1"
)

// gcePreempter calls compute.instances.simulateMaintenanceEvent, which on a
// Spot VM is a real preemption. Credentials come from ADC / Workload Identity.
type gcePreempter struct {
	once sync.Once
	svc  *compute.Service
	err  error
}

func (g *gcePreempter) SimulateMaintenance(ctx context.Context, project, zone, instance string) error {
	g.once.Do(func() { g.svc, g.err = compute.NewService(ctx) })
	if g.err != nil {
		return fmt.Errorf("compute client: %w", g.err)
	}
	op, err := g.svc.Instances.SimulateMaintenanceEvent(project, zone, instance).Context(ctx).Do()
	if err != nil {
		return fmt.Errorf("simulateMaintenanceEvent %s/%s/%s: %w", project, zone, instance, err)
	}
	if op.Error != nil && len(op.Error.Errors) > 0 {
		return fmt.Errorf("simulateMaintenanceEvent: %s", op.Error.Errors[0].Message)
	}
	return nil
}
