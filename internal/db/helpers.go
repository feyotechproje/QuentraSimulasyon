package db

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// NewBasketID returns a random RFC-4122 style UUID string used as BASKET_ID.
func NewBasketID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]),
		hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]),
		hex.EncodeToString(b[8:10]),
		hex.EncodeToString(b[10:16]))
}

// mustUUID parses a UUID string into the 16-byte form used by the driver.
func mustUUID(s string) [16]byte {
	var out [16]byte
	clean := strings.ReplaceAll(s, "-", "")
	if len(clean) != 32 {
		return out
	}
	raw, err := hex.DecodeString(clean)
	if err != nil {
		return out
	}
	copy(out[:], raw)
	return out
}

func nowUTC() time.Time { return time.Now().UTC() }

// pickName returns the actual-cased column name if present (case-insensitive).
func pickName(m map[string]ColumnInfo, name string) string {
	if name == "" {
		return ""
	}
	if c, ok := m[strings.ToUpper(name)]; ok {
		return c.Name
	}
	return ""
}

func containsCol(cols []string, name string) bool {
	target := "[" + strings.ToUpper(name) + "]"
	for _, c := range cols {
		if strings.ToUpper(c) == target {
			return true
		}
	}
	return false
}

// defaultForType returns a benign zero value appropriate for a SQL type, used
// only to satisfy NOT NULL columns we do not otherwise populate.
func defaultForType(dataType string) any {
	switch strings.ToLower(dataType) {
	case "int", "bigint", "smallint", "tinyint", "bit":
		return 0
	case "decimal", "numeric", "float", "real", "money", "smallmoney":
		return 0.0
	case "date", "datetime", "datetime2", "smalldatetime", "datetimeoffset":
		return nowUTC()
	case "uniqueidentifier":
		return mustUUID(NewBasketID())
	default:
		return ""
	}
}
