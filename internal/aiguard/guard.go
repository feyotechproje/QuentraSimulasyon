package aiguard

// The two defense layers the simulation demonstrates.
//
// Layer 1 — response side (data -> model). Scan() finds planted instructions in
// row data on its way back from SQL Server and neutralizes them WITHOUT
// changing the field's length, the same constraint Quentra's live TDS masking
// works under: the client's buffers, length prefixes and continuation packets
// must stay byte-consistent or the application breaks.
//
// Layer 2 — request side (model -> data). ClassifyAction() judges the statement
// a hijacked assistant wants to run. This is the "AI hüküm değiştirmez"
// principle made physical: the model may be talked into anything, but its
// action still has to cross a gate that does not read prompts and cannot be
// argued with.

import (
	"regexp"
	"strings"
	"unicode"
)

// Signal is one detection: which technique fired and the text that tripped it.
type Signal struct {
	Technique string `json:"technique"`
	Label     string `json:"label"`
	Match     string `json:"match"`
}

// ScanResult is the verdict on one field of row data.
type ScanResult struct {
	Poisoned bool     `json:"poisoned"`
	Signals  []Signal `json:"signals"`
	// Clean is the field as the model should see it. Same rune count as the
	// input, always — that is the whole constraint.
	Clean string `json:"clean"`
	// Quarantined is how many runes were replaced.
	Quarantined int `json:"quarantined"`
	// Boundary is the rune index where the instruction starts, or -1 when the
	// field is clean. The UI needs it to highlight the payload even on the
	// unprotected path, where no transform happened to diff against.
	Boundary int `json:"boundary"`
}

type detector struct {
	technique injectionTechnique
	label     string
	re        *regexp.Regexp
}

// detectors look for an INSTRUCTION BOUNDARY — the point where a piece of
// stored data stops being data and starts trying to give orders. Patterns run
// against a case- and diacritic-folded copy of the text (see fold), so they are
// written in plain lowercase ASCII and still match "Önceki TÜM talimatları".
var detectors = []detector{
	{techOverride, "Sahte sistem etiketi", regexp.MustCompile(
		`(#{2,}\s*)?\b(sistem|system|assistant|asistan)\s*[:>]|` +
			`\b(system|sistem)\s*override\b|\byonetici direktifi\b|\bdeveloper mode\b`)},

	{techIgnore, "Önceki talimatları geçersiz kılma", regexp.MustCompile(
		`\b(onceki|yukaridaki|bundan onceki)\b[^.!?]{0,30}\b(talimat|yonerge|komut|kural)[^.!?]{0,30}\b(yok say|dikkate alma|gormezden|unut|iptal)|` +
			`\bignore\s+(all\s+)?(previous|prior|above)\b|\bdisregard\s+(all\s+)?(previous|prior)\b`)},

	{techPersona, "Rol değiştirme", regexp.MustCompile(
		`\bsen\s+artik\b|\byou\s+are\s+now\b|\byeni\s+gorevin\b|\byour\s+new\s+task\b|\brolun\s+(artik|su)\b`)},

	{techDelimiter, "Sahte sohbet sınırlayıcısı", regexp.MustCompile(
		`<\|im_(start|end)\|>|\[/?inst\]|<<\s*sys\s*>>|\[/?system\]`)},

	{techTool, "Araç / komut çalıştırma", regexp.MustCompile(
		`\bxp_cmdshell\b|\bsp_configure\b|\bdrop\s+table\b|\bshutdown\b|\bexec(ute)?\s+(master\.)?xp_`)},

	{techExfil, "Veri sızdırma talimatı", regexp.MustCompile(
		`\b(tckn|kart\s*(no|numara)|kart_no|parola|sifre|password|card\s*number)\b[^.!?]{0,40}\b(listele|goster|dondur|ekle|gonder|aktar|raporla|dump|return|send)\b|` +
			`\byanit\w*\s*(in|inin)?\s*(sonuna|basina)\s*(ekle|yaz)\b|` +
			`\bag_customers\b|\bdbo\.\w+`)},

	{techIgnore, "Gizli asistan yönergesi", regexp.MustCompile(
		`\bbu\s+mesaj\w*\s+geri\s+kalani\b|\brest\s+of\s+this\s+message\b|` +
			`\b(kullaniciya|user\w*)\s+(gosterme|dont\s+show|do\s+not\s+show)\b`)},
}

// quarantineMark is what a neutralized span reads as. Padding uses a block
// glyph so an auditor can see at a glance how much text was replaced.
const quarantineMark = "⟦QUENTRA·KARANTİNA⟧"

// Scan finds the earliest instruction boundary in text and quarantines from
// there to the end of the field.
//
// Everything after a boundary is treated as untrusted: an attacker who can get
// one instruction into a field can get ten, and salvaging "the harmless parts"
// after the boundary is how partial sanitizers get bypassed. The legitimate
// text BEFORE the boundary is preserved verbatim, so a real customer message
// with a payload stapled to its end still reaches the model intact.
func Scan(text string) ScanResult {
	src := []rune(text)
	norm, byteToRune := normalize(src)

	first := -1
	var signals []Signal
	seen := map[string]bool{}

	for _, d := range detectors {
		loc := d.re.FindStringIndex(norm)
		if loc == nil {
			continue
		}
		start := byteToRune[loc[0]]
		if first < 0 || start < first {
			first = start
		}
		key := string(d.technique) + "|" + d.label
		if seen[key] {
			continue
		}
		seen[key] = true
		signals = append(signals, Signal{
			Technique: string(d.technique),
			Label:     d.label,
			Match:     excerpt(src, byteToRune[loc[0]], byteToRune[loc[1]]),
		})
	}

	if first < 0 {
		return ScanResult{Clean: text, Boundary: -1}
	}

	span := len(src) - first
	return ScanResult{
		Poisoned:    true,
		Signals:     signals,
		Clean:       string(src[:first]) + filler(span),
		Quarantined: span,
		Boundary:    first,
	}
}

// filler returns exactly n runes of quarantine text. Exactness is the point:
// the replacement has to occupy the same field width as what it replaced.
func filler(n int) string {
	if n <= 0 {
		return ""
	}
	mark := []rune(quarantineMark)
	if n <= len(mark) {
		return strings.Repeat("▒", n)
	}
	return string(mark) + strings.Repeat("▒", n-len(mark))
}

func excerpt(src []rune, start, end int) string {
	if end > len(src) {
		end = len(src)
	}
	if start >= end {
		return ""
	}
	const max = 64
	s := strings.TrimSpace(string(src[start:end]))
	if len([]rune(s)) > max {
		s = string([]rune(s)[:max]) + "…"
	}
	return s
}

// normalize builds a lowercase, diacritic-folded copy of src plus a table
// mapping each byte offset in that copy back to a rune index in src. fold is
// strictly 1 rune -> 1 rune, so rune indices are shared between the two and a
// match found in the folded text can be applied to the original exactly.
func normalize(src []rune) (string, []int) {
	var b strings.Builder
	b.Grow(len(src) * 2)
	idx := make([]int, 0, len(src)*2+1)
	for i, r := range src {
		before := b.Len()
		b.WriteRune(fold(r))
		for j := before; j < b.Len(); j++ {
			idx = append(idx, i)
		}
	}
	idx = append(idx, len(src))
	return b.String(), idx
}

// fold maps Turkish letters onto their ASCII skeletons so one pattern matches
// "GÖSTER", "göster" and "goster" alike.
func fold(r rune) rune {
	switch r {
	case 'ı', 'I', 'İ', 'i':
		return 'i'
	case 'ş', 'Ş':
		return 's'
	case 'ğ', 'Ğ':
		return 'g'
	case 'ü', 'Ü':
		return 'u'
	case 'ö', 'Ö':
		return 'o'
	case 'ç', 'Ç':
		return 'c'
	}
	return unicode.ToLower(r)
}

// ---------------------------------------------------------------- layer 2 ---

// Action verdict kinds.
const (
	ActionNone        = "none"
	ActionBenign      = "benign"
	ActionExfil       = "exfiltration"
	ActionDestructive = "destructive"
)

// ActionVerdict is the gate's judgement on a statement the assistant wants to
// run. Rule names mirror how Quentra's own rule engine reports a decision, so
// the UI can show WHICH rule fired rather than an unexplained refusal.
type ActionVerdict struct {
	Kind    string   `json:"kind"`
	Rule    string   `json:"rule"`
	Reasons []string `json:"reasons"`
	// Executable marks a statement that is safe to actually run against the
	// disposable database when demonstrating the unprotected path. Destructive
	// statements are never executable — classifying them proves the point and
	// running them would only break the demo environment.
	Executable bool `json:"executable"`
}

var (
	destructiveRE = regexp.MustCompile(`(?i)\b(drop|delete|truncate|alter|update|insert|merge|grant|revoke|shutdown|backup|restore)\b|xp_|sp_configure|sp_executesql`)
	sensitiveRE   = regexp.MustCompile(`(?i)\b(tckn|kart_no|kart\s*no|parola|sifre|password|card_number)\b`)
	customersRE   = regexp.MustCompile(`(?i)\bag_customers\b`)
	selectRE      = regexp.MustCompile(`(?i)^\s*(with|select)\b`)
	whereRE       = regexp.MustCompile(`(?i)\bwhere\b`)
)

// scopeTables is what the assistant is authorized to read. Everything else is
// out of scope regardless of how convincingly it was asked for — the gateway
// enforces the assistant's authority, because the assistant cannot be trusted
// to enforce its own.
var scopeTables = []string{"ag_tickets"}

// ClassifyAction judges a statement the assistant produced.
func ClassifyAction(stmt string) ActionVerdict {
	s := strings.TrimSpace(stmt)
	if s == "" {
		return ActionVerdict{Kind: ActionNone}
	}

	v := ActionVerdict{Kind: ActionBenign, Rule: "scope-allow"}

	if destructiveRE.MatchString(s) {
		return ActionVerdict{
			Kind:    ActionDestructive,
			Rule:    "block/destructive-verb",
			Reasons: []string{"Yıkıcı veya sistem düzeyinde ifade (DDL/DML/xp_)"},
		}
	}

	if !selectRE.MatchString(s) {
		return ActionVerdict{
			Kind:    ActionDestructive,
			Rule:    "block/non-select",
			Reasons: []string{"Salt-okunur olmayan ifade"},
		}
	}

	if strings.Count(s, ";") > 1 || (strings.Contains(s, ";") && !strings.HasSuffix(s, ";")) {
		v.Kind = ActionExfil
		v.Rule = "block/multi-statement"
		v.Reasons = append(v.Reasons, "Tek çağrıda birden fazla ifade")
	}

	if customersRE.MatchString(s) {
		v.Kind = ActionExfil
		v.Rule = "block/out-of-scope-table"
		v.Reasons = append(v.Reasons, "Asistan yetkisi dışı tablo: dbo.AG_CUSTOMERS")
	}

	if sensitiveRE.MatchString(s) {
		v.Kind = ActionExfil
		if v.Rule == "scope-allow" {
			v.Rule = "block/sensitive-column"
		}
		v.Reasons = append(v.Reasons, "Hassas kolon talebi (TCKN / KART_NO)")
	}

	if !whereRE.MatchString(s) && v.Kind == ActionExfil {
		v.Reasons = append(v.Reasons, "Filtresiz kütlesel okuma (WHERE yok)")
	}

	if v.Kind == ActionBenign && !inScope(s) {
		v.Kind = ActionExfil
		v.Rule = "block/out-of-scope-table"
		v.Reasons = append(v.Reasons, "Sorgu, asistanın yetkili olduğu tablo kümesi dışında")
	}

	// Read-only statements are safe to run against the synthetic table, which is
	// how the unprotected path produces a MEASURED leak count instead of a
	// guessed one.
	v.Executable = true
	return v
}

func inScope(stmt string) bool {
	low := strings.ToLower(stmt)
	for _, t := range scopeTables {
		if strings.Contains(low, t) {
			return true
		}
	}
	return false
}
