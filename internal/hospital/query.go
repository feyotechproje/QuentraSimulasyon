package hospital

// User-authored query support: the demo page's SQL editor sends its text here
// and the SAME statement is executed once on the direct route and once through
// the Quentra gateway. Only single, read-only SELECT statements are accepted —
// the editor is a demo console for a disposable database, not an admin shell.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const (
	maxQueryLen  = 2000
	maxQueryRows = 100
)

// CustomResult is one user query executed on both routes, verbatim.
type CustomResult struct {
	Columns     []string   `json:"columns"`
	DirectRows  [][]string `json:"directRows"`
	QuentraRows [][]string `json:"quentraRows"`
	DirectMs    float64    `json:"directMs"`
	QuentraMs   float64    `json:"quentraMs"`
	Masked      bool       `json:"masked"`
	GatewayUp   bool       `json:"gatewayUp"`
	Error       string     `json:"error,omitempty"`
}

var (
	selectRE = regexp.MustCompile(`(?i)^\s*select\b`)
	// Anything that could write, execute or escalate is rejected outright.
	writeRE = regexp.MustCompile(`(?i)\b(insert|update|delete|drop|alter|exec|execute|merge|truncate|grant|revoke|create|backup|restore|shutdown|waitfor|into|openrowset|opendatasource)\b|xp_|sp_`)
)

// validateQuery accepts exactly one read-only SELECT statement.
func validateQuery(q string) (string, error) {
	s := strings.TrimSpace(q)
	s = strings.TrimSuffix(s, ";")
	if s == "" {
		return "", errors.New("sorgu boş")
	}
	if len(s) > maxQueryLen {
		return "", errors.New("sorgu çok uzun")
	}
	if !selectRE.MatchString(s) {
		return "", errors.New("yalnızca SELECT sorguları çalıştırılabilir")
	}
	if strings.Contains(s, ";") {
		return "", errors.New("tek seferde tek ifade çalıştırılabilir")
	}
	if writeRE.MatchString(s) {
		return "", errors.New("yalnızca okuma (SELECT) sorgularına izin var")
	}
	return s, nil
}

// RunQuery executes the user's SELECT on the direct route, then through the
// gateway, and reports both result sets verbatim. Masked is true only when the
// two routes returned different cells.
func (m *Manager) RunQuery(ctx context.Context, q string) CustomResult {
	out := CustomResult{GatewayUp: m.gatewayUp.Load()}
	if m.db == nil || !m.provisioned.Load() {
		out.Error = "HOSPITALSIM veritabanı henüz hazır değil"
		return out
	}
	stmt, err := validateQuery(q)
	if err != nil {
		out.Error = err.Error()
		return out
	}

	cols, dRows, dMs, err := runGeneric(ctx, m.db, stmt)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	_, qRows, qMs, err := runGeneric(ctx, m.quentraPool(), stmt)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	out.Columns, out.DirectRows, out.QuentraRows = cols, dRows, qRows
	out.DirectMs, out.QuentraMs = dMs, qMs
	out.Masked = cellsDiffer(dRows, qRows)
	return out
}

func runGeneric(ctx context.Context, pool *sql.DB, q string) ([]string, [][]string, float64, error) {
	qctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()
	start := time.Now()
	rs, err := pool.QueryContext(qctx, q)
	if err != nil {
		return nil, nil, 0, err
	}
	defer rs.Close()
	cols, err := rs.Columns()
	if err != nil {
		return nil, nil, 0, err
	}
	vals := make([]any, len(cols))
	for i := range vals {
		vals[i] = new(any)
	}
	var rows [][]string
	for rs.Next() && len(rows) < maxQueryRows {
		if err := rs.Scan(vals...); err != nil {
			return cols, rows, 0, err
		}
		row := make([]string, len(cols))
		for i, v := range vals {
			row[i] = cellString(*(v.(*any)))
		}
		rows = append(rows, row)
	}
	return cols, rows, round2(float64(time.Since(start).Nanoseconds()) / 1e6), rs.Err()
}

func cellString(v any) string {
	switch t := v.(type) {
	case nil:
		return "NULL"
	case []byte:
		return string(t)
	case time.Time:
		return t.Format("2006-01-02 15:04:05")
	default:
		return fmt.Sprint(t)
	}
}

func cellsDiffer(a, b [][]string) bool {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	if len(a) != len(b) {
		return true
	}
	for i := 0; i < n; i++ {
		if len(a[i]) != len(b[i]) {
			return true
		}
		for j := range a[i] {
			if strings.TrimSpace(a[i][j]) != strings.TrimSpace(b[i][j]) {
				return true
			}
		}
	}
	return false
}
