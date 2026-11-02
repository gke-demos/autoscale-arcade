package server

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// The web UI (web/dist) is copied into internal/server/dist at build time
// (Dockerfile / `make build`). A placeholder index.html is committed so the
// server builds before the UI exists.
//
//go:embed all:dist
var distFS embed.FS

// UIHandler serves the embedded single-page app with history fallback.
func UIHandler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err)
	}
	files := http.FS(sub)
	fileServer := http.FileServer(files)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := path.Clean("/" + r.URL.Path)
		if strings.HasPrefix(p, "/api/") || p == "/ws" {
			http.NotFound(w, r)
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
