// Command arcade is the single entrypoint of the Autoscale Arcade image:
//
//	arcade server   – the arcade-server (WorldState over WebSocket, actions, scenarios, UI)
//	arcade pet      – the migratable in-memory pet (Pod Teleporter)
//	arcade worker   – coin / burst / race workers (Lights Out, Shock Absorber, Nitro)
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/gke-demos/autoscale-arcade/internal/pet"
	"github.com/gke-demos/autoscale-arcade/internal/server"
	"github.com/gke-demos/autoscale-arcade/internal/worker"
)

// version is set with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: logLevel()}))
	slog.SetDefault(log)

	var err error
	switch os.Args[1] {
	case "server":
		err = runServer(ctx, os.Args[2:], log)
	case "pet":
		err = pet.Run(ctx)
	case "worker":
		fs := flag.NewFlagSet("worker", flag.ExitOnError)
		mode := fs.String("mode", os.Getenv("WORKER_MODE"), "coin | burst | race")
		_ = fs.Parse(os.Args[2:])
		err = worker.Run(ctx, *mode)
	case "version", "--version", "-v":
		fmt.Println(version)
	default:
		usage()
		os.Exit(2)
	}
	if err != nil && ctx.Err() == nil {
		log.Error("exit", "cmd", os.Args[1], "err", err)
		os.Exit(1)
	}
}

func runServer(ctx context.Context, args []string, log *slog.Logger) error {
	fs := flag.NewFlagSet("server", flag.ExitOnError)
	cfg := server.Config{Version: version}
	fs.StringVar(&cfg.Addr, "addr", env("ARCADE_ADDR", ":8080"), "listen address")
	fs.StringVar(&cfg.Kubeconfig, "kubeconfig", os.Getenv("KUBECONFIG"), "kubeconfig path (empty = in-cluster)")
	fs.StringVar(&cfg.DevToken, "dev-token", os.Getenv("ARCADE_DEV_TOKEN"), "bearer token accepted for mutating endpoints")
	fs.StringVar(&cfg.IAPAudience, "iap-audience", os.Getenv("IAP_AUDIENCE"), "expected IAP JWT audience")
	fs.StringVar(&cfg.ScenarioDir, "scenarios", env("ARCADE_SCENARIOS", "scenarios"), "directory of scenario YAML files")
	fs.StringVar(&cfg.Cluster, "cluster", os.Getenv("CLUSTER"), "cluster name (derived from nodes if empty)")
	fs.StringVar(&cfg.Project, "project", env("PROJECT_ID", os.Getenv("GOOGLE_CLOUD_PROJECT")), "GCP project (derived from nodes if empty)")
	fs.StringVar(&cfg.Region, "region", os.Getenv("REGION"), "GCP region (derived from nodes if empty)")
	fs.StringVar(&cfg.PetToken, "pet-token", os.Getenv("ARCADE_PET_TOKEN"), "optional bearer token required on /api/pet")
	fs.Float64Var(&cfg.RateLimit, "rate-limit", 5, "mutating requests per second per client")
	if err := fs.Parse(args); err != nil {
		return err
	}
	return server.Run(ctx, cfg, log)
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func logLevel() slog.Level {
	switch os.Getenv("LOG_LEVEL") {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	}
	return slog.LevelInfo
}

func usage() {
	fmt.Fprintf(os.Stderr, "usage: arcade <server|pet|worker --mode=coin|burst|race|version> [flags]\n")
}
