package server

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// The web UI (web/dist) is copied into internal/server/dist at build time
// (Dockerfile / `make build`). Only a .gitkeep is tracked there, so a build
// without the UI serves placeholder.html instead.
//
//go:embed all:dist
var distFS embed.FS

//go:embed placeholder.html
var placeholderHTML []byte

// UIHandler serves the embedded single-page app with history fallback.
func UIHandler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err)
	}
	files := http.FS(sub)
	fileServer := http.FileServer(files)
	hasIndex := false
	if f, err := files.Open("/index.html"); err == nil {
		f.Close()
		hasIndex = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := path.Clean("/" + r.URL.Path)
		if strings.HasPrefix(p, "/api/") || p == "/ws" {
			http.NotFound(w, r)
			return
		}
		if !hasIndex {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(placeholderHTML)
			return
		}
		if p != "/" {
			if f, err := files.Open(p); err == nil {
				f.Close()
				if strings.HasPrefix(p, "/assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		// SPA fallback.
		w.Header().Set("Cache-Control", "no-cache")
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})
}
