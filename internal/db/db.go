package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	_ "github.com/microsoft/go-mssqldb"

	"supermarketsim/internal/config"
)

// Store wraps the SQL Server connection pool plus the detected schema mapping.
//
// Quentra is a second pool pointing at the Quentra gateway rather than SQL
// Server directly. The application sends byte-identical SQL down either pool;
// only the route differs, which is what makes the direct-vs-Quentra comparison
// meaningful. It is nil when the gateway was unreachable at startup.
type Store struct {
	DB      *sql.DB
	Quentra *sql.DB
	Schema  *Schema
}

// scanPool returns the pool a per-scan query should travel over. Falls back to
// the direct connection when the gateway is not available, so live mode still
// runs (as baseline) instead of failing.
func (s *Store) scanPool(viaQuentra bool) *sql.DB {
	if viaQuentra && s.Quentra != nil {
		return s.Quentra
	}
	return s.DB
}

// HasQuentraGateway reports whether the gateway pool was established.
func (s *Store) HasQuentraGateway() bool { return s.Quentra != nil }

// ColumnInfo describes a single column discovered via metadata.
type ColumnInfo struct {
	Name       string
	DataType   string
	IsNullable bool
	IsIdentity bool
	MaxLen     int
}

// Open creates the connection pool with conservative pool limits so the
// simulation cannot exhaust the server with unbounded connections.
func Open(cfg *config.Config) (*Store, error) {
	pool, err := sql.Open("sqlserver", cfg.DSN())
	if err != nil {
		return nil, fmt.Errorf("open sqlserver: %w", err)
	}
	pool.SetMaxOpenConns(24)
	pool.SetMaxIdleConns(8)
	pool.SetConnMaxLifetime(30 * time.Minute)
	pool.SetConnMaxIdleTime(5 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := pool.PingContext(ctx); err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("ping sqlserver: %w", err)
	}

	st := &Store{DB: pool}

	// Second pool via the Quentra gateway. Best-effort: if it is not up, live
	// mode simply runs everything as baseline rather than refusing to start.
	if gw, err := sql.Open("sqlserver", cfg.QuentraDSNFor(cfg.DBDatabase, config.AppRetail)); err == nil {
		gw.SetMaxOpenConns(24)
		gw.SetMaxIdleConns(8)
		gw.SetConnMaxLifetime(30 * time.Minute)
		gw.SetConnMaxIdleTime(5 * time.Minute)
		gctx, gcancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := gw.PingContext(gctx); err == nil {
			st.Quentra = gw
		} else {
			_ = gw.Close()
		}
		gcancel()
	}
	return st, nil
}

// Close releases both connection pools.
func (s *Store) Close() error {
	if s.Quentra != nil {
		_ = s.Quentra.Close()
	}
	if s.DB == nil {
		return nil
	}
	return s.DB.Close()
}

// tableExists reports whether dbo.<name> exists using sys.tables.
func (s *Store) tableExists(ctx context.Context, name string) (bool, error) {
	const q = `SELECT COUNT(*) FROM sys.tables t
		JOIN sys.schemas sc ON sc.schema_id = t.schema_id
		WHERE sc.name = 'dbo' AND t.name = @p1`
	var n int
	if err := s.DB.QueryRowContext(ctx, q, name).Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

// columns returns metadata for all columns of dbo.<name>.
func (s *Store) columns(ctx context.Context, name string) ([]ColumnInfo, error) {
	const q = `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE,
		ISNULL(COLUMNPROPERTY(OBJECT_ID('dbo.'+TABLE_NAME), COLUMN_NAME, 'IsIdentity'),0) AS IsIdent,
		ISNULL(CHARACTER_MAXIMUM_LENGTH,0) AS MaxLen
		FROM INFORMATION_SCHEMA.COLUMNS
		WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @p1
		ORDER BY ORDINAL_POSITION`
	rows, err := s.DB.QueryContext(ctx, q, name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []ColumnInfo
	for rows.Next() {
		var (
			c        ColumnInfo
			nullable string
			ident    int
		)
		if err := rows.Scan(&c.Name, &c.DataType, &nullable, &ident, &c.MaxLen); err != nil {
			return nil, err
		}
		c.IsNullable = strings.EqualFold(nullable, "YES")
		c.IsIdentity = ident == 1
		out = append(out, c)
	}
	return out, rows.Err()
}

// count returns row count for dbo.<name>. Uses a fast metadata estimate is
// avoided intentionally; an exact count keeps environment checks trustworthy.
func (s *Store) count(ctx context.Context, name string) (int64, error) {
	var n int64
	q := fmt.Sprintf("SELECT COUNT_BIG(*) FROM dbo.[%s]", name)
	if err := s.DB.QueryRowContext(ctx, q).Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}
