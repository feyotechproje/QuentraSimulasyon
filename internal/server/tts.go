package server

import (
	"bytes"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Story-mode narration: the browser posts a caption's text, the server answers
// with MP3 audio. Every clip is cached on disk keyed by (text, voice, model,
// lang), mirroring the Python booth script's tts_cache — a narration line is
// synthesized (and billed) exactly once; every later request is a file read.

const ttsCacheDir = "tts_cache"

// ttsSpeed is part of the cache key: change it and old clips regenerate.
const ttsSpeed = 1.1

type ttsRequest struct {
	Text string `json:"text"`
	Lang string `json:"lang"`
}

func (s *Server) handleTTS(w http.ResponseWriter, r *http.Request) {
	var req ttsRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	text := strings.TrimSpace(req.Text)
	if text == "" || len(text) > 1500 {
		http.Error(w, "text empty or too long", http.StatusBadRequest)
		return
	}
	lang := normalizeTTSLang(req.Lang)

	// Cache first — even without an API key, previously generated clips play.
	key := fmt.Sprintf("%s|%s|%s|%s|%.2f", text, s.cfg.ElevenVoice, s.cfg.ElevenModel, lang, ttsSpeed)
	sum := md5.Sum([]byte(key))
	path := filepath.Join(ttsCacheDir, hex.EncodeToString(sum[:])+".mp3")
	if b, err := os.ReadFile(path); err == nil && len(b) > 0 {
		serveTTSAudio(w, b)
		return
	}

	if !s.cfg.HasElevenLabs() {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "ELEVENLABS_API_KEY tanımlı değil"})
		return
	}

	payload, _ := json.Marshal(map[string]any{
		"text":     text,
		"model_id": s.cfg.ElevenModel,
		"voice_settings": map[string]any{
			"stability":         0.4,
			"similarity_boost":  0.7,
			"style":             0.0,
			"use_speaker_boost": true,
			"speed":             ttsSpeed,
		},
		"language_code": lang,
	})
	url := fmt.Sprintf("https://api.elevenlabs.io/v1/text-to-speech/%s?output_format=mp3_44100_128", s.cfg.ElevenVoice)
	httpReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		http.Error(w, "request build failed", http.StatusInternalServerError)
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("xi-api-key", s.cfg.ElevenKey)

	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		http.Error(w, "elevenlabs unreachable: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	audio, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		http.Error(w, "elevenlabs read failed", http.StatusBadGateway)
		return
	}
	if resp.StatusCode != http.StatusOK {
		msg := string(audio)
		if len(msg) > 400 {
			msg = msg[:400]
		}
		s.log.Warn("tts synth failed", "status", resp.StatusCode, "body", msg)
		http.Error(w, fmt.Sprintf("elevenlabs %d: %s", resp.StatusCode, msg), http.StatusBadGateway)
		return
	}

	// Write-then-rename so concurrent preloads never serve a half-written file.
	if err := os.MkdirAll(ttsCacheDir, 0o755); err == nil {
		if tmp, err := os.CreateTemp(ttsCacheDir, "clip-*.tmp"); err == nil {
			name := tmp.Name()
			_, werr := tmp.Write(audio)
			cerr := tmp.Close()
			if werr == nil && cerr == nil {
				_ = os.Rename(name, path)
			} else {
				_ = os.Remove(name)
			}
		}
	}
	serveTTSAudio(w, audio)
}

func serveTTSAudio(w http.ResponseWriter, b []byte) {
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Content-Length", fmt.Sprint(len(b)))
	_, _ = w.Write(b)
}

func normalizeTTSLang(lang string) string {
	l := strings.ToLower(strings.TrimSpace(lang))
	switch {
	case strings.HasPrefix(l, "en"):
		return "en"
	default:
		return "tr"
	}
}
