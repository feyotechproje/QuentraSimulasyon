package server

import (
	"bytes"
	"crypto/md5"
	"encoding/base64"
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
	Text  string `json:"text"`
	Lang  string `json:"lang"`
	Voice string `json:"voice"` // logical role: "" (narrator), "manager", "engineer"
}

// ttsVoiceID maps a logical speaker role from the request to a configured
// ElevenLabs voice. Unknown roles fall back to the narrator, so a stale
// client can never make the server synthesize with an arbitrary voice id.
// The factory story's characters reuse the hospital cast where the profile
// matches (Can ≈ engineer, Mehmet ≈ manager) so their clips share the cache.
func (s *Server) ttsVoiceID(role string) string {
	switch role {
	case "manager", "mehmet":
		return s.cfg.ElevenVoiceManager
	case "engineer", "can":
		return s.cfg.ElevenVoiceEngineer
	case "elif":
		return s.cfg.ElevenVoiceElif
	default:
		return s.cfg.ElevenVoice
	}
}

// ttsPaths derives the cache locations for a narration line: the mp3 clip and
// the word-timing sidecar (character start times from /with-timestamps, used
// by the story choreography to sync visuals to the spoken words).
func (s *Server) ttsPaths(text, lang, voiceID string) (mp3Path, alignPath string) {
	key := fmt.Sprintf("%s|%s|%s|%s|%.2f", text, voiceID, s.cfg.ElevenModel, lang, ttsSpeed)
	sum := md5.Sum([]byte(key))
	base := filepath.Join(ttsCacheDir, hex.EncodeToString(sum[:]))
	return base + ".mp3", base + ".align.json"
}

func decodeTTSRequest(r *http.Request) (text, lang, voice string, ok bool) {
	var req ttsRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&req); err != nil {
		return "", "", "", false
	}
	text = strings.TrimSpace(req.Text)
	if text == "" || len(text) > 1500 {
		return "", "", "", false
	}
	return text, normalizeTTSLang(req.Lang), strings.TrimSpace(req.Voice), true
}

func (s *Server) handleTTS(w http.ResponseWriter, r *http.Request) {
	text, lang, voice, ok := decodeTTSRequest(r)
	if !ok {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	voiceID := s.ttsVoiceID(voice)

	// Cache first — even without an API key, previously generated clips play.
	path, alignPath := s.ttsPaths(text, lang, voiceID)
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
	// /with-timestamps returns the audio AND per-character start times; the
	// timings are cached next to the clip so the story can sync visuals to
	// the exact moment a word is spoken.
	url := fmt.Sprintf("https://api.elevenlabs.io/v1/text-to-speech/%s/with-timestamps?output_format=mp3_44100_128", voiceID)
	httpReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		http.Error(w, "request build failed", http.StatusInternalServerError)
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("xi-api-key", s.cfg.ElevenKey)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		http.Error(w, "elevenlabs unreachable: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		http.Error(w, "elevenlabs read failed", http.StatusBadGateway)
		return
	}
	if resp.StatusCode != http.StatusOK {
		msg := string(body)
		if len(msg) > 400 {
			msg = msg[:400]
		}
		s.log.Warn("tts synth failed", "status", resp.StatusCode, "body", msg)
		http.Error(w, fmt.Sprintf("elevenlabs %d: %s", resp.StatusCode, msg), http.StatusBadGateway)
		return
	}

	var out struct {
		AudioBase64 string `json:"audio_base64"`
		Alignment   struct {
			Characters []string  `json:"characters"`
			Starts     []float64 `json:"character_start_times_seconds"`
		} `json:"alignment"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.AudioBase64 == "" {
		http.Error(w, "elevenlabs: unexpected response", http.StatusBadGateway)
		return
	}
	audio, err := base64.StdEncoding.DecodeString(out.AudioBase64)
	if err != nil || len(audio) == 0 {
		http.Error(w, "elevenlabs: bad audio payload", http.StatusBadGateway)
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
		if len(out.Alignment.Characters) > 0 && len(out.Alignment.Characters) == len(out.Alignment.Starts) {
			if aj, err := json.Marshal(map[string]any{
				"chars":  out.Alignment.Characters,
				"starts": out.Alignment.Starts,
			}); err == nil {
				_ = os.WriteFile(alignPath, aj, 0o644)
			}
		}
	}
	serveTTSAudio(w, audio)
}

// handleTTSAlign serves the cached word-timing sidecar for a narration line.
// 404 simply means "no timings" (old clip or failed synth) — the client then
// falls back to proportional pacing.
func (s *Server) handleTTSAlign(w http.ResponseWriter, r *http.Request) {
	text, lang, voice, ok := decodeTTSRequest(r)
	if !ok {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	_, alignPath := s.ttsPaths(text, lang, s.ttsVoiceID(voice))
	b, err := os.ReadFile(alignPath)
	if err != nil || len(b) == 0 {
		http.Error(w, `{"error":"no alignment"}`, http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(b)
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
