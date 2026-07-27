package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	mssql "github.com/microsoft/go-mssqldb"
)

// ErrAlreadyInvoiced is returned when a basket has already been invoiced,
// preventing a second invoice for the same basket.
var ErrAlreadyInvoiced = errors.New("basket already invoiced")

// StockFunctionName is the scalar UDF the checkout uses to fetch on-hand stock
// for a scanned item. It is deliberately slow (see EnsureStockFunction) so the
// "software update added a slow per-scan lookup" scenario is real, not faked.
const StockFunctionName = "QUENTRA_GetItemStock"

// Customer is a row sampled from USER_.
type Customer struct {
	Ref  int64  `json:"ref"`
	Name string `json:"name"`
	Code string `json:"code"`
}

// Item is a row sampled from ITEMS with a resolved price.
type Item struct {
	Ref   int64   `json:"ref"`
	Code  string  `json:"code"`
	Name  string  `json:"name"`
	Unit  string  `json:"unit"`
	Price float64 `json:"price"`
}

// BasketLine is a single product line within a customer's basket.
type BasketLine struct {
	ItemRef   int64   `json:"itemRef"`
	ItemCode  string  `json:"itemCode"`
	ItemName  string  `json:"itemName"`
	Unit      string  `json:"unit"`
	Quantity  float64 `json:"quantity"`
	UnitPrice float64 `json:"unitPrice"`
	LineTotal float64 `json:"lineTotal"`
}

// MaxLinkID returns the current maximum link id (e.g. ORDERID) across both the
// INVOICE header table and the detail table, so the engine can allocate new
// link ids strictly above any pre-existing data and avoid collisions.
func (s *Store) MaxLinkID(ctx context.Context) (int64, error) {
	sc := s.Schema
	if sc.LinkColumn == "" {
		return 0, nil
	}
	var maxInv, maxDet sql.NullInt64
	q1 := fmt.Sprintf("SELECT MAX([%s]) FROM dbo.[%s]", sc.LinkColumn, sc.InvoiceTable)
	if err := s.DB.QueryRowContext(ctx, q1).Scan(&maxInv); err != nil {
		return 0, fmt.Errorf("max invoice link id: %w", err)
	}
	if _, ok := sc.DetailCols[strings.ToUpper(sc.LinkColumn)]; ok {
		q2 := fmt.Sprintf("SELECT MAX([%s]) FROM dbo.[%s]", sc.LinkColumn, sc.DetailTable)
		if err := s.DB.QueryRowContext(ctx, q2).Scan(&maxDet); err != nil {
			return 0, fmt.Errorf("max detail link id: %w", err)
		}
	}
	base := maxInv.Int64
	if maxDet.Int64 > base {
		base = maxDet.Int64
	}
	return base, nil
}

// EnsureBasket creates dbo.BASKET (and its indexes) when absent. Key columns
// use INT to match the INT keys of USER_ and ITEMS.
func (s *Store) EnsureBasket(ctx context.Context) (created bool, err error) {
	exists, err := s.tableExists(ctx, "BASKET")
	if err != nil {
		return false, err
	}
	if exists {
		return false, nil
	}

	const ddl = `
CREATE TABLE dbo.BASKET
(
    ID BIGINT IDENTITY(1,1) PRIMARY KEY,
    BASKET_ID UNIQUEIDENTIFIER NOT NULL,
    CUSTOMER_REF INT NOT NULL,
    ITEM_REF INT NOT NULL,
    QUANTITY DECIMAL(18,3) NOT NULL,
    UNIT_PRICE DECIMAL(18,4) NOT NULL,
    LINE_TOTAL AS (QUANTITY * UNIT_PRICE) PERSISTED,
    STATUS VARCHAR(20) NOT NULL CONSTRAINT DF_BASKET_STATUS DEFAULT 'WAITING',
    REGISTER_NO INT NULL,
    CREATED_AT DATETIME2 NOT NULL CONSTRAINT DF_BASKET_CREATED DEFAULT SYSUTCDATETIME(),
    SCANNED_AT DATETIME2 NULL,
    INVOICE_REF BIGINT NULL
);
CREATE INDEX IX_BASKET_BASKET_ID ON dbo.BASKET (BASKET_ID);
CREATE INDEX IX_BASKET_STATUS ON dbo.BASKET (STATUS);
CREATE INDEX IX_BASKET_CUSTOMER_REF ON dbo.BASKET (CUSTOMER_REF);
CREATE INDEX IX_BASKET_REGISTER_NO ON dbo.BASKET (REGISTER_NO);
CREATE INDEX IX_BASKET_CREATED_AT ON dbo.BASKET (CREATED_AT);`

	if _, err := s.DB.ExecContext(ctx, ddl); err != nil {
		return false, fmt.Errorf("create BASKET: %w", err)
	}
	return true, nil
}

// stockDetailInfo resolves the detail table + item/amount columns used by the
// slow stock lookup, falling back to sensible QUENTRA_RETAIL defaults when the
// schema has not been detected yet.
func (s *Store) stockDetailInfo() (table, itemCol, amountCol string) {
	table, itemCol, amountCol = "ORDERDETAIL", "ITEMID", "AMOUNT"
	if s.Schema == nil {
		return
	}
	if s.Schema.DetailTable != "" {
		table = s.Schema.DetailTable
	}
	if s.Schema.DetailItemCol != "" {
		itemCol = s.Schema.DetailItemCol
	}
	// AmountCol may legitimately be empty; the caller handles that.
	amountCol = s.Schema.DetailAmountCol
	return
}

// dbo.QUENTRA_GetItemStock is created and owned in the DATABASE, deliberately
// written to be expensive. This application only calls it — it must never
// create or alter it, or a hand-tuned function would be replaced by a
// generated one and the whole scenario would stop being real.

// itemScanSelect builds the ONE query the register runs for every scanned
// barcode. The application always sends this exact statement, in both modes:
// rewriting it (dropping the UDF call) is the Quentra gateway's job, not the
// application's. That is what makes the comparison honest — the client is
// unchanged and only the connection differs.
func (s *Store) itemScanSelect() string {
	sc := s.Schema
	return fmt.Sprintf("SELECT %s,%s,%s,DBO.%s(%s) AS STOCK FROM dbo.[%s] WHERE [%s] = @p1",
		nz(sc.ItemCode, "ITEMCODE"), nz(sc.ItemName, "ITEMNAME"), nz(sc.ItemPrice, "UNITPRICE"),
		StockFunctionName, nz(sc.ItemCode, "ITEMCODE"),
		nz(sc.ItemTable, "ITEMS"), nz(sc.ItemKey, "ID"))
}

// ItemScanSQL returns the per-scan query for display. `rewrite` selects which
// side of the comparison to show: the statement the application sends, or the
// form Quentra rewrites it into on the way to SQL Server.
func (s *Store) ItemScanSQL(rewrite bool) string {
	sc := s.Schema
	// Kept to the statement itself: the surrounding panel already explains the
	// scenario, and comment lines here only make the box taller.
	if rewrite {
		return fmt.Sprintf("exec sp_executesql\n"+
			"  N'SELECT %s,%s,%s,100 STOCK\n"+
			"    FROM dbo.[%s] WHERE [%s] = @p1',\n"+
			"  N'@p1 bigint', @p1 = 1314",
			nz(sc.ItemCode, "ITEMCODE"), nz(sc.ItemName, "ITEMNAME"), nz(sc.ItemPrice, "UNITPRICE"),
			nz(sc.ItemTable, "ITEMS"), nz(sc.ItemKey, "ID"))
	}
	return fmt.Sprintf("exec sp_executesql\n"+
		"  N'SELECT %s,%s,%s,\n"+
		"      DBO.%s(%s) AS STOCK\n"+
		"    FROM dbo.[%s] WHERE [%s] = @p1',\n"+
		"  N'@p1 bigint', @p1 = 1314",
		nz(sc.ItemCode, "ITEMCODE"), nz(sc.ItemName, "ITEMNAME"), nz(sc.ItemPrice, "UNITPRICE"),
		StockFunctionName, nz(sc.ItemCode, "ITEMCODE"),
		nz(sc.ItemTable, "ITEMS"), nz(sc.ItemKey, "ID"))
}

func nz(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

// ScanItem performs the single per-scanned-item query a register runs for every
// barcode: product columns plus the stock value, in one round trip. It returns
// the stock and the REAL elapsed time.
//
// The statement is identical in both modes — the application never rewrites its
// own SQL. viaQuentra only selects the route: the gateway pool (which rewrites
// the statement in flight) or the direct SQL Server pool. That is the whole
// comparison, and it is why the client-side SQL must stay byte-identical.
func (s *Store) ScanItem(ctx context.Context, itemRef int64, viaQuentra bool) (stock int64, elapsed time.Duration, err error) {
	sc := s.Schema
	if sc.ItemTable == "" || sc.ItemKey == "" {
		return 0, 0, nil // schema cannot support the lookup; treat as zero cost
	}
	q := s.itemScanSelect()
	pool := s.scanPool(viaQuentra)

	start := time.Now()
	var code, name sql.NullString
	var price sql.NullFloat64
	err = pool.QueryRowContext(ctx, q, itemRef).Scan(&code, &name, &price, &stock)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil // missing row is not a failure for timing purposes
	}
	return stock, time.Since(start), err
}

// LoadCustomerPool fetches up to size random customers once, so the engine can
// pick from an in-memory pool with its seeded RNG instead of hitting the DB per
// customer. This keeps DB load bounded at large scale.
func (s *Store) LoadCustomerPool(ctx context.Context, size int) ([]Customer, error) {
	sc := s.Schema
	nameExpr := s.customerNameExpr()
	codeExpr := "''"
	if sc.UserCode != "" {
		codeExpr = fmt.Sprintf("ISNULL(CONVERT(varchar(50),[%s]),'')", sc.UserCode)
	}
	q := fmt.Sprintf(
		"SELECT TOP (@p1) [%s] AS ref, %s AS nm, %s AS cd FROM dbo.[%s] ORDER BY NEWID()",
		sc.UserKey, nameExpr, codeExpr, sc.UserTable)

	rows, err := s.DB.QueryContext(ctx, q, size)
	if err != nil {
		return nil, fmt.Errorf("load customer pool: %w", err)
	}
	defer rows.Close()

	var out []Customer
	for rows.Next() {
		var c Customer
		if err := rows.Scan(&c.Ref, &c.Name, &c.Code); err != nil {
			return nil, err
		}
		if strings.TrimSpace(c.Name) == "" {
			c.Name = fmt.Sprintf("Customer #%d", c.Ref)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) customerNameExpr() string {
	sc := s.Schema
	switch {
	case sc.UserFullName != "":
		return fmt.Sprintf("ISNULL([%s],'')", sc.UserFullName)
	case sc.UserName != "" && sc.UserSurname != "":
		return fmt.Sprintf("LTRIM(RTRIM(ISNULL([%s],'')+' '+ISNULL([%s],'')))", sc.UserName, sc.UserSurname)
	case sc.UserName != "":
		return fmt.Sprintf("ISNULL([%s],'')", sc.UserName)
	default:
		return "''"
	}
}

// LoadItemPool fetches up to size random items with a resolved price.
func (s *Store) LoadItemPool(ctx context.Context, size int) ([]Item, error) {
	sc := s.Schema
	codeExpr := "''"
	if sc.ItemCode != "" {
		codeExpr = fmt.Sprintf("ISNULL(CONVERT(varchar(50),[%s]),'')", sc.ItemCode)
	}
	nameExpr := "''"
	if sc.ItemName != "" {
		nameExpr = fmt.Sprintf("ISNULL([%s],'')", sc.ItemName)
	}
	unitExpr := "''"
	if sc.ItemUnit != "" {
		unitExpr = fmt.Sprintf("ISNULL(CONVERT(varchar(50),[%s]),'')", sc.ItemUnit)
	}

	var priceExpr, from string
	if sc.ItemPrice != "" {
		priceExpr = fmt.Sprintf("ISNULL(CONVERT(float,i.[%s]),0)", sc.ItemPrice)
		from = fmt.Sprintf("dbo.[%s] i", sc.ItemTable)
	} else if strings.HasPrefix(sc.PriceSource, "dbo.ITEMPRICELIST") {
		priceExpr = "ISNULL(pl.UNITPRICE,0)"
		from = fmt.Sprintf(`dbo.[%s] i
			OUTER APPLY (
				SELECT TOP 1 p.UNITPRICE FROM dbo.ITEMPRICELIST p
				WHERE p.ITEMID = i.[%s] ORDER BY p.DATE_ DESC
			) pl`, sc.ItemTable, sc.ItemKey)
	} else {
		priceExpr = "0"
		from = fmt.Sprintf("dbo.[%s] i", sc.ItemTable)
	}

	q := fmt.Sprintf(
		"SELECT TOP (@p1) i.[%s] AS ref, %s AS cd, %s AS nm, %s AS un, %s AS pr FROM %s ORDER BY NEWID()",
		sc.ItemKey,
		strings.ReplaceAll(codeExpr, "[", "i.["),
		strings.ReplaceAll(nameExpr, "[", "i.["),
		strings.ReplaceAll(unitExpr, "[", "i.["),
		priceExpr, from)

	rows, err := s.DB.QueryContext(ctx, q, size)
	if err != nil {
		return nil, fmt.Errorf("load item pool: %w", err)
	}
	defer rows.Close()

	var out []Item
	for rows.Next() {
		var it Item
		if err := rows.Scan(&it.Ref, &it.Code, &it.Name, &it.Unit, &it.Price); err != nil {
			return nil, err
		}
		if strings.TrimSpace(it.Name) == "" {
			it.Name = fmt.Sprintf("Item #%d", it.Ref)
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// InsertBasket writes all lines of a basket with status WAITING in one short
// transaction. The physical item-scan waits happen later, outside any tx.
func (s *Store) InsertBasket(ctx context.Context, basketID string, customerRef int64, lines []BasketLine) error {
	if len(lines) == 0 {
		return errors.New("empty basket")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	const stmt = `INSERT INTO dbo.BASKET (BASKET_ID, CUSTOMER_REF, ITEM_REF, QUANTITY, UNIT_PRICE, STATUS)
		VALUES (@bid, @cust, @item, @qty, @price, 'WAITING')`
	ps, err := tx.PrepareContext(ctx, stmt)
	if err != nil {
		return err
	}
	defer ps.Close()

	for _, ln := range lines {
		if _, err := ps.ExecContext(ctx,
			sql.Named("bid", mssql.UniqueIdentifier(mustUUID(basketID))),
			sql.Named("cust", customerRef),
			sql.Named("item", ln.ItemRef),
			sql.Named("qty", ln.Quantity),
			sql.Named("price", ln.UnitPrice),
		); err != nil {
			return fmt.Errorf("insert basket line: %w", err)
		}
	}
	return tx.Commit()
}

// SetBasketStatus updates the status (and optionally register) for all lines of
// a basket. Used for QUEUED / SCANNING / SCANNED / INVOICING transitions.
func (s *Store) SetBasketStatus(ctx context.Context, basketID, status string, registerNo *int) error {
	q := "UPDATE dbo.BASKET SET STATUS=@st"
	args := []any{sql.Named("st", status), sql.Named("bid", mssql.UniqueIdentifier(mustUUID(basketID)))}
	if registerNo != nil {
		q += ", REGISTER_NO=@reg"
		args = append(args, sql.Named("reg", *registerNo))
	}
	if status == "SCANNED" {
		q += ", SCANNED_AT=SYSUTCDATETIME()"
	}
	q += " WHERE BASKET_ID=@bid"
	_, err := s.DB.ExecContext(ctx, q, args...)
	return err
}

// InvoiceResult reports what CreateInvoice persisted.
type InvoiceResult struct {
	InvoiceRef int64
	InvoiceNo  string
	OrderID    int64
	LineCount  int
	Total      float64
}

// CreateInvoice performs the full invoice write in a single short transaction:
// header insert, detail inserts, and BASKET completion. The BASKET update is
// guarded on STATUS='INVOICING', so a basket can never be invoiced twice.
//
// orderID must be a pre-allocated value that is unique across INVOICE and the
// detail table (see MaxLinkID); it links the header and detail rows when the
// schema uses a shared link column.
func (s *Store) CreateInvoice(ctx context.Context, basketID string, customerRef int64, registerNo int, lines []BasketLine, invoiceNo string, orderID int64) (*InvoiceResult, error) {
	sc := s.Schema
	if sc.DetailTable == "" {
		return nil, errors.New("no invoice detail table configured")
	}

	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	// 2. Insert INVOICE header, returning the identity key.
	invoiceRef, err := s.insertInvoiceHeader(ctx, tx, invoiceNo, orderID)
	if err != nil {
		return nil, err
	}

	// 3. Insert detail rows.
	var total float64
	for _, ln := range lines {
		if err := s.insertDetail(ctx, tx, orderID, invoiceRef, ln); err != nil {
			return nil, err
		}
		total += ln.LineTotal
	}

	// 4. Complete the basket, guarded against double invoicing.
	res, err := tx.ExecContext(ctx,
		`UPDATE dbo.BASKET SET STATUS='COMPLETED', INVOICE_REF=@inv
		 WHERE BASKET_ID=@bid AND STATUS='INVOICING'`,
		sql.Named("inv", invoiceRef),
		sql.Named("bid", mssql.UniqueIdentifier(mustUUID(basketID))))
	if err != nil {
		return nil, fmt.Errorf("complete basket: %w", err)
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		return nil, ErrAlreadyInvoiced
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	committed = true

	return &InvoiceResult{
		InvoiceRef: invoiceRef,
		InvoiceNo:  invoiceNo,
		OrderID:    orderID,
		LineCount:  len(lines),
		Total:      total,
	}, nil
}

func (s *Store) insertInvoiceHeader(ctx context.Context, tx *sql.Tx, invoiceNo string, orderID int64) (int64, error) {
	sc := s.Schema
	var cols []string
	var params []string
	var args []any
	idx := 0
	addParam := func(col string, val any) {
		idx++
		p := fmt.Sprintf("@h%d", idx)
		cols = append(cols, "["+col+"]")
		params = append(params, p)
		args = append(args, sql.Named(fmt.Sprintf("h%d", idx), val))
	}

	if c := pick(sc.InvoiceCols, "INVOICENO", "INVOICENUMBER", "NO"); c != "" {
		addParam(c, invoiceNo)
	}
	if c := pick(sc.InvoiceCols, "DATE_", "DATE", "INVOICEDATE", "CREATED_AT"); c != "" {
		addParam(c, nowUTC())
	}
	if c := pick(sc.InvoiceCols, "STATUS_", "STATUS"); c != "" {
		addParam(c, 1)
	}
	if sc.LinkColumn != "" {
		addParam(sc.LinkColumn, orderID)
	}

	// Fill any remaining NOT NULL, non-identity columns with type defaults so
	// the insert succeeds across schema variations, without inventing meaning.
	for _, c := range sc.InvoiceCols {
		if c.IsIdentity {
			continue
		}
		up := strings.ToUpper(c.Name)
		if containsCol(cols, c.Name) {
			continue
		}
		if !c.IsNullable {
			addParam(c.Name, defaultForType(c.DataType))
			continue
		}
		_ = up
	}

	q := fmt.Sprintf(
		"INSERT INTO dbo.[%s] (%s) OUTPUT INSERTED.[%s] VALUES (%s)",
		sc.InvoiceTable, strings.Join(cols, ","), sc.InvoiceKey, strings.Join(params, ","))

	var key int64
	if err := tx.QueryRowContext(ctx, q, args...).Scan(&key); err != nil {
		return 0, fmt.Errorf("insert invoice header: %w", err)
	}
	return key, nil
}

func (s *Store) insertDetail(ctx context.Context, tx *sql.Tx, orderID, invoiceRef int64, ln BasketLine) error {
	sc := s.Schema
	var cols, params []string
	var args []any
	idx := 0
	add := func(col string, val any) {
		if col == "" {
			return
		}
		idx++
		p := fmt.Sprintf("@d%d", idx)
		cols = append(cols, "["+col+"]")
		params = append(params, p)
		args = append(args, sql.Named(fmt.Sprintf("d%d", idx), val))
	}

	linkCol := pickName(sc.DetailCols, sc.LinkColumn)
	if linkCol != "" {
		add(linkCol, orderID)
	} else if c := pick(sc.DetailCols, "INVOICEID", "INVOICEREF"); c != "" {
		add(c, invoiceRef)
	}
	add(pick(sc.DetailCols, "ITEMID", "ITEMREF", "ITEM_ID", "STOCKREF"), ln.ItemRef)
	add(pick(sc.DetailCols, "AMOUNT", "QUANTITY", "QTY"), ln.Quantity)
	add(pick(sc.DetailCols, "PRICE", "UNITPRICE"), ln.UnitPrice)
	add(pick(sc.DetailCols, "TOTALPRICE", "LINETOTAL", "LINE_TOTAL", "TOTAL"), ln.LineTotal)

	// Remaining NOT NULL columns get type defaults.
	for _, c := range sc.DetailCols {
		if c.IsIdentity || containsCol(cols, c.Name) || c.IsNullable {
			continue
		}
		add(c.Name, defaultForType(c.DataType))
	}

	if len(cols) == 0 {
		return errors.New("no detail columns resolved")
	}
	q := fmt.Sprintf("INSERT INTO dbo.[%s] (%s) VALUES (%s)",
		sc.DetailTable, strings.Join(cols, ","), strings.Join(params, ","))
	if _, err := tx.ExecContext(ctx, q, args...); err != nil {
		return fmt.Errorf("insert detail: %w", err)
	}
	return nil
}

// ResetBasketForRetry moves an errored basket back to a re-processable state.
func (s *Store) ResetBasketForRetry(ctx context.Context, basketID string) error {
	_, err := s.DB.ExecContext(ctx,
		`UPDATE dbo.BASKET SET STATUS='QUEUED' WHERE BASKET_ID=@bid AND INVOICE_REF IS NULL`,
		sql.Named("bid", mssql.UniqueIdentifier(mustUUID(basketID))))
	return err
}

// ReloadBasket reconstructs a basket's lines and customer for retry, joining
// BASKET back to ITEMS and USER_ for display fields.
func (s *Store) ReloadBasket(ctx context.Context, basketID string) ([]BasketLine, Customer, error) {
	sc := s.Schema
	nameExpr := s.customerNameExpr()
	itemCodeExpr := "''"
	if sc.ItemCode != "" {
		itemCodeExpr = fmt.Sprintf("ISNULL(CONVERT(varchar(50),it.[%s]),'')", sc.ItemCode)
	}
	itemNameExpr := "''"
	if sc.ItemName != "" {
		itemNameExpr = fmt.Sprintf("ISNULL(it.[%s],'')", sc.ItemName)
	}
	q := fmt.Sprintf(`SELECT b.ITEM_REF, %s AS code, %s AS name, b.QUANTITY, b.UNIT_PRICE,
			b.CUSTOMER_REF, %s AS custname
		FROM dbo.BASKET b
		LEFT JOIN dbo.[%s] it ON it.[%s] = b.ITEM_REF
		LEFT JOIN dbo.[%s] u ON u.[%s] = b.CUSTOMER_REF
		WHERE b.BASKET_ID = @bid
		ORDER BY b.ID`,
		itemCodeExpr, itemNameExpr,
		strings.ReplaceAll(nameExpr, "[", "u.["),
		sc.ItemTable, sc.ItemKey, sc.UserTable, sc.UserKey)

	rows, err := s.DB.QueryContext(ctx, q,
		sql.Named("bid", mssql.UniqueIdentifier(mustUUID(basketID))))
	if err != nil {
		return nil, Customer{}, err
	}
	defer rows.Close()

	var lines []BasketLine
	var cust Customer
	for rows.Next() {
		var (
			ln   BasketLine
			cRef int64
			cNm  string
		)
		if err := rows.Scan(&ln.ItemRef, &ln.ItemCode, &ln.ItemName, &ln.Quantity, &ln.UnitPrice, &cRef, &cNm); err != nil {
			return nil, Customer{}, err
		}
		ln.LineTotal = ln.Quantity * ln.UnitPrice
		lines = append(lines, ln)
		cust.Ref = cRef
		cust.Name = cNm
	}
	if err := rows.Err(); err != nil {
		return nil, Customer{}, err
	}
	if len(lines) == 0 {
		return nil, Customer{}, errors.New("basket not found or empty")
	}
	return lines, cust, nil
}
