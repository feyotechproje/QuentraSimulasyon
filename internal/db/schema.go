package db

import (
	"context"
	"fmt"
	"strings"
)

// Schema holds the auto-detected column mapping for the QUENTRA_RETAIL tables.
// The simulation never hard-codes column names; everything is resolved from
// live metadata so it adapts to schema variations.
type Schema struct {
	// Customer source (USER_)
	UserTable    string
	UserKey      string
	UserName     string
	UserSurname  string
	UserFullName string
	UserCode     string

	// Product source (ITEMS)
	ItemTable   string
	ItemKey     string
	ItemCode    string
	ItemName    string
	ItemUnit    string
	ItemPrice   string // column on ITEMS holding price, or "" if none
	PriceSource string // human-readable description of where price comes from
	PriceWarn   string // non-empty when price could not be resolved

	// Invoice header
	InvoiceTable string
	InvoiceKey   string
	InvoiceCols  map[string]ColumnInfo

	// Invoice detail (INVOICEDETAIL if present, else ORDERDETAIL)
	DetailTable string
	DetailCols  map[string]ColumnInfo

	// Detail columns used by the slow per-scan stock lookup scenario.
	DetailItemCol   string // item foreign key on the detail table (e.g. ITEMID)
	DetailAmountCol string // sold quantity column on the detail table (e.g. AMOUNT)

	// Linking strategy between header and detail.
	LinkColumn string // e.g. "ORDERID"; empty => link by InvoiceKey directly
}

// CheckResult is a single environment-check outcome for the UI.
type CheckResult struct {
	Name    string `json:"name"`
	Status  string `json:"status"` // "ready" | "warning" | "failed"
	Message string `json:"message"`
}

// EnvironmentReport aggregates all checks plus the resolved schema summary.
type EnvironmentReport struct {
	Overall     string        `json:"overall"` // ready | warning | failed
	Checks      []CheckResult `json:"checks"`
	CanRun      bool          `json:"canRun"`
	Currency    string        `json:"currency"`
	CustomerCnt int64         `json:"customerCount"`
	ProductCnt  int64         `json:"productCount"`
}

func colMap(cols []ColumnInfo) map[string]ColumnInfo {
	m := make(map[string]ColumnInfo, len(cols))
	for _, c := range cols {
		m[strings.ToUpper(c.Name)] = c
	}
	return m
}

// pick returns the first candidate column (case-insensitive) that exists.
func pick(m map[string]ColumnInfo, candidates ...string) string {
	for _, cand := range candidates {
		if c, ok := m[strings.ToUpper(cand)]; ok {
			return c.Name
		}
	}
	return ""
}

// pickContains returns the first column whose name contains any of the tokens.
func pickContains(cols []ColumnInfo, tokens ...string) string {
	for _, c := range cols {
		up := strings.ToUpper(c.Name)
		for _, t := range tokens {
			if strings.Contains(up, strings.ToUpper(t)) {
				return c.Name
			}
		}
	}
	return ""
}

// DetectSchema resolves the schema mapping from live metadata. It returns an
// error only for problems that make detection impossible; missing optional
// columns are reported as warnings by EnvironmentCheck instead.
func (s *Store) DetectSchema(ctx context.Context) (*Schema, error) {
	sc := &Schema{
		UserTable:    "USER_",
		ItemTable:    "ITEMS",
		InvoiceTable: "INVOICE",
	}

	// USER_ mapping
	userCols, err := s.columns(ctx, "USER_")
	if err != nil {
		return nil, fmt.Errorf("read USER_ columns: %w", err)
	}
	if len(userCols) == 0 {
		return nil, fmt.Errorf("table dbo.USER_ not found")
	}
	um := colMap(userCols)
	sc.UserKey = pick(um, "ID", "LOGICALREF", "USERID", "REF")
	if sc.UserKey == "" {
		sc.UserKey = firstIdentity(userCols, userCols[0].Name)
	}
	sc.UserName = pick(um, "NAME_", "NAME", "FIRSTNAME", "AD")
	sc.UserSurname = pick(um, "SURNAME", "LASTNAME", "SOYAD")
	sc.UserFullName = pick(um, "NAMESURNAME", "FULLNAME", "ADSOYAD", "DISPLAYNAME")
	sc.UserCode = pick(um, "CODE", "USERCODE", "CUSTOMERCODE", "CARDNO", "TCNUMBER")

	// ITEMS mapping
	itemCols, err := s.columns(ctx, "ITEMS")
	if err != nil {
		return nil, fmt.Errorf("read ITEMS columns: %w", err)
	}
	if len(itemCols) == 0 {
		return nil, fmt.Errorf("table dbo.ITEMS not found")
	}
	im := colMap(itemCols)
	sc.ItemKey = pick(im, "ID", "LOGICALREF", "ITEMID", "REF")
	if sc.ItemKey == "" {
		sc.ItemKey = itemCols[0].Name
	}
	sc.ItemCode = pick(im, "ITEMCODE", "CODE", "BARCODE", "PRODUCTCODE")
	sc.ItemName = pick(im, "ITEMNAME", "NAME_", "NAME", "PRODUCTNAME", "DESCRIPTION")
	sc.ItemUnit = pick(im, "UNIT", "UNITNAME", "UOM", "UNITCODE")
	sc.ItemPrice = pick(im, "UNITPRICE", "PRICE", "SALESPRICE", "SELLPRICE", "LISTPRICE")

	if err := s.resolvePrice(ctx, sc); err != nil {
		return nil, err
	}

	// INVOICE mapping
	invCols, err := s.columns(ctx, "INVOICE")
	if err != nil {
		return nil, fmt.Errorf("read INVOICE columns: %w", err)
	}
	sc.InvoiceCols = colMap(invCols)
	sc.InvoiceKey = firstIdentity(invCols, pick(sc.InvoiceCols, "ID", "LOGICALREF"))

	// Detail table: prefer INVOICEDETAIL, fall back to ORDERDETAIL.
	sc.DetailTable, err = s.resolveDetailTable(ctx)
	if err != nil {
		return nil, err
	}
	if sc.DetailTable != "" {
		detCols, err := s.columns(ctx, sc.DetailTable)
		if err != nil {
			return nil, fmt.Errorf("read %s columns: %w", sc.DetailTable, err)
		}
		sc.DetailCols = colMap(detCols)
		// Columns used by the slow per-scan stock lookup scenario.
		sc.DetailItemCol = pick(sc.DetailCols, "ITEMID", "ITEM_REF", "ITEMREF", "ITEM_ID", "ITEM")
		sc.DetailAmountCol = pick(sc.DetailCols, "AMOUNT", "QUANTITY", "QTY", "AMOUNT_")
		// Determine linking column shared between header and detail.
		if _, ok := sc.InvoiceCols["ORDERID"]; ok {
			if _, ok := sc.DetailCols["ORDERID"]; ok {
				sc.LinkColumn = "ORDERID"
			}
		}
		if sc.LinkColumn == "" {
			// Try a shared *ID column present on both sides other than the key.
			for name := range sc.DetailCols {
				if _, ok := sc.InvoiceCols[name]; ok && strings.HasSuffix(name, "ID") &&
					!strings.EqualFold(name, sc.InvoiceKey) {
					sc.LinkColumn = sc.DetailCols[name].Name
					break
				}
			}
		}
	}

	s.Schema = sc
	return sc, nil
}

func (s *Store) resolvePrice(ctx context.Context, sc *Schema) error {
	if sc.ItemPrice != "" {
		sc.PriceSource = fmt.Sprintf("dbo.ITEMS.%s", sc.ItemPrice)
		return nil
	}
	// Fallback: a dedicated price-list table.
	exists, err := s.tableExists(ctx, "ITEMPRICELIST")
	if err != nil {
		return err
	}
	if exists {
		plCols, err := s.columns(ctx, "ITEMPRICELIST")
		if err != nil {
			return err
		}
		pm := colMap(plCols)
		priceCol := pick(pm, "UNITPRICE", "PRICE", "AMOUNT")
		itemRef := pick(pm, "ITEMID", "ITEMREF", "ITEM_ID")
		if priceCol != "" && itemRef != "" {
			sc.PriceSource = fmt.Sprintf("dbo.ITEMPRICELIST.%s (latest by date)", priceCol)
			return nil
		}
	}
	sc.PriceWarn = "Product price column could not be resolved on ITEMS or ITEMPRICELIST. Prices will be 0 until configured."
	sc.PriceSource = "unresolved"
	return nil
}

func (s *Store) resolveDetailTable(ctx context.Context) (string, error) {
	for _, cand := range []string{"INVOICEDETAIL", "ORDERDETAIL"} {
		exists, err := s.tableExists(ctx, cand)
		if err != nil {
			return "", err
		}
		if exists {
			return cand, nil
		}
	}
	return "", nil
}

func firstIdentity(cols []ColumnInfo, fallback string) string {
	for _, c := range cols {
		if c.IsIdentity {
			return c.Name
		}
	}
	if fallback != "" {
		return fallback
	}
	if len(cols) > 0 {
		return cols[0].Name
	}
	return ""
}

// EnvironmentCheck runs the pre-flight validation surfaced on the UI.
func (s *Store) EnvironmentCheck(ctx context.Context, sc *Schema) EnvironmentReport {
	rep := EnvironmentReport{Overall: "ready", CanRun: true, Currency: "TRY"}
	add := func(name, status, msg string) {
		rep.Checks = append(rep.Checks, CheckResult{Name: name, Status: status, Message: msg})
		switch status {
		case "failed":
			rep.Overall = "failed"
			rep.CanRun = false
		case "warning":
			if rep.Overall != "failed" {
				rep.Overall = "warning"
			}
		}
	}

	add("Database connection", "ready", "Connected to QUENTRA_RETAIL")

	// Required tables.
	for _, t := range []string{"USER_", "ITEMS", "INVOICE"} {
		ok, err := s.tableExists(ctx, t)
		switch {
		case err != nil:
			add(fmt.Sprintf("Table dbo.%s", t), "failed", err.Error())
		case ok:
			add(fmt.Sprintf("Table dbo.%s", t), "ready", "present")
		default:
			add(fmt.Sprintf("Table dbo.%s", t), "failed", "missing")
		}
	}

	// Detail table (must exist; never auto-created).
	if sc.DetailTable == "" {
		add("Invoice detail table", "failed",
			"Neither dbo.INVOICEDETAIL nor dbo.ORDERDETAIL found; refusing to fabricate one")
	} else {
		add("Invoice detail table", "ready", "using dbo."+sc.DetailTable)
	}

	// BASKET (auto-created if absent).
	basketExists, err := s.tableExists(ctx, "BASKET")
	if err != nil {
		add("Table dbo.BASKET", "failed", err.Error())
	} else if basketExists {
		add("Table dbo.BASKET", "ready", "present")
	} else {
		add("Table dbo.BASKET", "warning", "not found; will be created on start")
	}

	// Data volume.
	if uc, err := s.count(ctx, "USER_"); err != nil {
		add("Customer data", "failed", err.Error())
	} else {
		rep.CustomerCnt = uc
		if uc == 0 {
			add("Customer data", "failed", "USER_ has no rows")
		} else {
			add("Customer data", "ready", fmt.Sprintf("%d customers available", uc))
		}
	}
	if pc, err := s.count(ctx, "ITEMS"); err != nil {
		add("Product data", "failed", err.Error())
	} else {
		rep.ProductCnt = pc
		if pc == 0 {
			add("Product data", "failed", "ITEMS has no rows")
		} else {
			add("Product data", "ready", fmt.Sprintf("%d products available", pc))
		}
	}

	// Price resolution.
	if sc.PriceWarn != "" {
		add("Product pricing", "warning", sc.PriceWarn)
	} else {
		add("Product pricing", "ready", "price source: "+sc.PriceSource)
	}

	// Insert permission probe (rolled back).
	if err := s.probeInsertPermission(ctx); err != nil {
		add("Insert permissions", "failed", err.Error())
	} else {
		add("Insert permissions", "ready", "INSERT permitted")
	}

	return rep
}

// probeInsertPermission verifies INSERT rights without leaving data behind.
func (s *Store) probeInsertPermission(ctx context.Context) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	const q = `SELECT HAS_PERMS_BY_NAME('dbo.INVOICE', 'OBJECT', 'INSERT')`
	var granted int
	if err := tx.QueryRowContext(ctx, q).Scan(&granted); err != nil {
		return err
	}
	if granted != 1 {
		return fmt.Errorf("INSERT permission on dbo.INVOICE is not granted")
	}
	return nil
}
