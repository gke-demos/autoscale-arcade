package worker

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// CoinConfig configures the Lights Out coin worker.
type CoinConfig struct {
	ServerURL    string        // ARCADE_SERVER_URL
	ClaimPath    string        // default /api/queue/claim
	WorkDuration time.Duration // COIN_WORK_SECONDS
	PollInterval time.Duration // COIN_POLL_SECONDS, how often to poll an empty queue
	Logger       *slog.Logger
	Client       *http.Client
}

// Coin is the body returned by a successful claim: `{"coin": <n>}` (the
// server's sequence number). Every field is optional: a bare 200 is a coin too.
type Coin struct {
	Coin int    `json:"coin,omitempty"`
	ID   string `json:"id,omitempty"`
}

func (c Coin) String() string {
	if c.ID != "" {
		return c.ID
	}
	return strconv.Itoa(c.Coin)
}

// RunCoin polls GET ServerURL/api/queue/claim. 200 = a coin was claimed: work
// on it for WorkDuration; 204 = the queue is empty: back off PollInterval.
// Returns only when ctx is cancelled.
func RunCoin(ctx context.Context, c CoinConfig) error {
	if c.ClaimPath == "" {
		c.ClaimPath = "/api/queue/claim"
	}
	if c.PollInterval <= 0 {
		c.PollInterval = 2 * time.Second
	}
	if c.Logger == nil {
		c.Logger = slog.Default()
	}
	if c.Client == nil {
		c.Client = &http.Client{Timeout: 10 * time.Second}
	}
	url := strings.TrimRight(c.ServerURL, "/") + c.ClaimPath
	log := c.Logger.With("claim", url)
	log.Info("coin worker started", "work", c.WorkDuration, "poll", c.PollInterval)

	processed := 0
	for {
		coin, ok, err := claim(ctx, c.Client, url)
		switch {
		case ctx.Err() != nil:
			log.Info("coin worker stopping", "processed", processed)
			return nil
		case err != nil:
			log.Warn("claim failed", "err", err)
			if !sleep(ctx, c.PollInterval) {
				return nil
			}
		case !ok:
			if !sleep(ctx, c.PollInterval) {
				return nil
			}
		default:
			log.Info("processing coin", "coin", coin.String(), "work", c.WorkDuration)
			if !sleep(ctx, c.WorkDuration) {
				log.Info("interrupted mid-coin", "coin", coin.String())
				return nil
			}
			processed++
			log.Info("coin processed", "coin", coin.String(), "processed", processed)
		}
	}
}

// claim performs one claim request. ok is false on 204 (queue empty).
func claim(ctx context.Context, client *http.Client, url string) (Coin, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Coin{}, false, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return Coin{}, false, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	switch {
	case resp.StatusCode == http.StatusNoContent:
		return Coin{}, false, nil
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		var coin Coin
		if len(body) > 0 {
			_ = json.Unmarshal(body, &coin) // a non-JSON body is still a coin
		}
		return coin, true, nil
	default:
		return Coin{}, false, &statusError{resp.Status, strings.TrimSpace(string(body))}
	}
}

type statusError struct{ status, body string }

func (e *statusError) Error() string {
	if e.body == "" {
		return "unexpected status " + e.status
	}
	return "unexpected status " + e.status + ": " + e.body
}

// sleep waits d or until ctx is done; returns false if cancelled.
func sleep(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
