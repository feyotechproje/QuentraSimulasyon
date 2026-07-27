package dashboard

import (
	"context"
	"math"
	"strings"
)

// MockRepository serves deterministic demo data for the SALES100K scenario.
// Numbers are internally consistent: the Marmara slice of the full data set
// equals the values returned when the Marmara master-filter is applied.
type MockRepository struct{}

// NewMockRepository builds the in-memory demo repository.
func NewMockRepository() *MockRepository { return &MockRepository{} }

var monthNames = []string{
	"Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
}

// fullRegions is the canonical region breakdown of the whole SALES100K table.
var fullRegions = []RegionRow{
	{Region: "Marmara", Sales: 8_200_000, Orders: 32_400},
	{Region: "İç Anadolu", Sales: 5_100_000, Orders: 20_100},
	{Region: "Ege", Sales: 4_300_000, Orders: 17_000},
	{Region: "Akdeniz", Sales: 2_900_000, Orders: 11_500},
	{Region: "Karadeniz", Sales: 1_850_000, Orders: 7_300},
	{Region: "Güneydoğu Anadolu", Sales: 1_250_000, Orders: 4_900},
	{Region: "Doğu Anadolu", Sales: 900_000, Orders: 3_600},
}

// GetDashboard returns the full dashboard or a region-filtered slice.
func (m *MockRepository) GetDashboard(_ context.Context, filter DashboardFilter) (DashboardData, error) {
	region := strings.TrimSpace(filter.Region)
	if region == "" {
		return fullDashboard(), nil
	}
	if strings.EqualFold(region, "Marmara") {
		return marmaraDashboard(), nil
	}
	for _, r := range fullRegions {
		if strings.EqualFold(r.Region, region) {
			return regionDashboard(r), nil
		}
	}
	return fullDashboard(), nil
}

// regionCities lists representative cities for each region, used to build a
// plausible per-region "Top Cities" breakdown in the filtered dashboards.
var regionCities = map[string][]string{
	"Marmara":           {"İstanbul", "Bursa", "Kocaeli", "Tekirdağ", "Balıkesir", "Sakarya"},
	"İç Anadolu":        {"Ankara", "Konya", "Kayseri", "Eskişehir", "Sivas"},
	"Ege":               {"İzmir", "Manisa", "Aydın", "Denizli", "Muğla"},
	"Akdeniz":           {"Antalya", "Adana", "Mersin", "Hatay", "Isparta"},
	"Karadeniz":         {"Samsun", "Trabzon", "Ordu", "Rize", "Zonguldak"},
	"Güneydoğu Anadolu": {"Gaziantep", "Şanlıurfa", "Diyarbakır", "Mardin", "Batman"},
	"Doğu Anadolu":      {"Erzurum", "Malatya", "Elazığ", "Van", "Ağrı"},
}

// cityWeights distributes a region's totals across its cities (descending).
var cityWeights = []float64{0.40, 0.22, 0.16, 0.12, 0.06, 0.04}

func roundThousands(v float64) float64 { return math.Round(v/1000) * 1000 }

// regionDashboard builds an internally consistent filtered dashboard for any
// region by scaling the full data set by that region's share of total sales.
func regionDashboard(row RegionRow) DashboardData {
	full := fullDashboard()
	var total float64
	for _, r := range fullRegions {
		total += r.Sales
	}
	ratio := 0.0
	if total > 0 {
		ratio = row.Sales / total
	}

	months := make([]MonthPoint, len(full.SalesByMonth))
	for i, m := range full.SalesByMonth {
		months[i] = MonthPoint{Month: m.Month, Sales: roundThousands(m.Sales * ratio)}
	}
	categories := make([]CategorySlice, len(full.SalesByCategory))
	for i, c := range full.SalesByCategory {
		categories[i] = CategorySlice{Category: c.Category, Sales: roundThousands(c.Sales * ratio)}
	}
	trend := make([]TrendPoint, len(full.OrderTrend))
	for i, t := range full.OrderTrend {
		trend[i] = TrendPoint{Label: t.Label, Orders: int(math.Round(float64(t.Orders) * ratio))}
	}
	products := make([]ProductRow, len(full.TopProducts))
	for i, p := range full.TopProducts {
		products[i] = ProductRow{
			ItemName: p.ItemName,
			Brand:    p.Brand,
			Quantity: int(math.Round(float64(p.Quantity) * ratio)),
			Revenue:  roundThousands(p.Revenue * ratio),
		}
	}
	genders := make([]GenderSlice, len(full.GenderDist))
	for i, g := range full.GenderDist {
		genders[i] = GenderSlice{
			Gender: g.Gender,
			Count:  int(math.Round(float64(g.Count) * ratio)),
			Sales:  roundThousands(g.Sales * ratio),
		}
	}

	names := regionCities[row.Region]
	cities := make([]CityRow, 0, len(names))
	for i, name := range names {
		w := cityWeights[i%len(cityWeights)]
		sales := roundThousands(row.Sales * w)
		orders := int(math.Round(float64(row.Orders) * w))
		basket := 0.0
		if orders > 0 {
			basket = math.Round(sales/float64(orders)*10) / 10
		}
		cities = append(cities, CityRow{City: name, Sales: sales, Orders: orders, AverageBasket: basket})
	}

	avg := 0.0
	if row.Orders > 0 {
		avg = row.Sales / float64(row.Orders)
	}
	return DashboardData{
		Filter: DashboardFilter{Region: row.Region},
		KPIs: KPIs{
			TotalSales:   row.Sales,
			TotalOrders:  row.Orders,
			Customers:    int(math.Round(float64(full.KPIs.Customers) * ratio)),
			AverageOrder: avg,
			ItemsSold:    int(math.Round(float64(full.KPIs.ItemsSold) * ratio)),
			ActiveCities: len(names),
		},
		SalesByRegion:   withShares([]RegionRow{row}),
		SalesByMonth:    months,
		SalesByCategory: categories,
		TopCities:       cities,
		OrderTrend:      trend,
		TopProducts:     products,
		GenderDist:      genders,
	}
}

func withShares(rows []RegionRow) []RegionRow {
	var total float64
	for _, r := range rows {
		total += r.Sales
	}
	out := make([]RegionRow, len(rows))
	for i, r := range rows {
		if total > 0 {
			r.Share = r.Sales / total * 100
		}
		out[i] = r
	}
	return out
}

func fullDashboard() DashboardData {
	return DashboardData{
		Filter: DashboardFilter{},
		KPIs: KPIs{
			TotalSales:   24_500_000,
			TotalOrders:  96_800,
			Customers:    41_250,
			AverageOrder: 24_500_000.0 / 96_800.0,
			ItemsSold:    198_400,
			ActiveCities: 81,
		},
		SalesByRegion: withShares(fullRegions),
		SalesByMonth: []MonthPoint{
			{monthNames[0], 1_620_000}, {monthNames[1], 1_480_000}, {monthNames[2], 1_910_000},
			{monthNames[3], 1_760_000}, {monthNames[4], 2_050_000}, {monthNames[5], 2_240_000},
			{monthNames[6], 2_310_000}, {monthNames[7], 2_180_000}, {monthNames[8], 2_020_000},
			{monthNames[9], 2_150_000}, {monthNames[10], 2_360_000}, {monthNames[11], 2_420_000},
		},
		SalesByCategory: []CategorySlice{
			{"Oyuncaklar", 8_575_000},
			{"Zeka Geliştirici", 5_390_000},
			{"Aktivite Setleri", 4_165_000},
			{"Ev ve Yaşam", 3_675_000},
			{"Diğer", 2_695_000},
		},
		TopCities: []CityRow{
			{"İstanbul", 5_120_000, 19_800, 258.6},
			{"Ankara", 2_240_000, 8_850, 253.1},
			{"İzmir", 1_980_000, 7_820, 253.2},
			{"Bursa", 1_180_000, 4_600, 256.5},
			{"Antalya", 1_020_000, 4_050, 251.9},
			{"Konya", 880_000, 3_480, 252.9},
		},
		OrderTrend: []TrendPoint{
			{monthNames[0], 6_400}, {monthNames[1], 5_900}, {monthNames[2], 7_500},
			{monthNames[3], 6_950}, {monthNames[4], 8_100}, {monthNames[5], 8_850},
			{monthNames[6], 9_120}, {monthNames[7], 8_600}, {monthNames[8], 7_980},
			{monthNames[9], 8_490}, {monthNames[10], 9_320}, {monthNames[11], 9_590},
		},
		TopProducts: []ProductRow{
			{"OYUNCAK PVC POS ET BEBEK", "OYUNCAK", 12_480, 194_400},
			{"ZEKA KÜPÜ 3X3", "AKIL OYUN", 9_720, 151_500},
			{"AHŞAP BLOK SETİ", "EDU PLAY", 8_150, 138_600},
			{"BOYAMA AKTİVİTE KİTABI", "SANAT", 7_640, 96_300},
			{"MİNİ MUTFAK SETİ", "EV YAŞAM", 6_020, 128_900},
		},
		GenderDist: []GenderSlice{
			{"K", 23_100, 13_720_000},
			{"E", 18_150, 10_780_000},
		},
	}
}

func marmaraDashboard() DashboardData {
	// Only Marmara remains in the region list, but the full region context is
	// preserved so the component can still highlight the selected row.
	regions := withShares([]RegionRow{fullRegions[0]})
	return DashboardData{
		Filter: DashboardFilter{Region: "Marmara"},
		KPIs: KPIs{
			TotalSales:   8_200_000,
			TotalOrders:  32_400,
			Customers:    14_880,
			AverageOrder: 8_200_000.0 / 32_400.0,
			ItemsSold:    66_300,
			ActiveCities: 11,
		},
		SalesByRegion: regions,
		SalesByMonth: []MonthPoint{
			{monthNames[0], 548_000}, {monthNames[1], 502_000}, {monthNames[2], 636_000},
			{monthNames[3], 588_000}, {monthNames[4], 690_000}, {monthNames[5], 752_000},
			{monthNames[6], 774_000}, {monthNames[7], 728_000}, {monthNames[8], 676_000},
			{monthNames[9], 720_000}, {monthNames[10], 792_000}, {monthNames[11], 794_000},
		},
		SalesByCategory: []CategorySlice{
			{"Oyuncaklar", 2_870_000},
			{"Zeka Geliştirici", 1_804_000},
			{"Aktivite Setleri", 1_394_000},
			{"Ev ve Yaşam", 1_230_000},
			{"Diğer", 902_000},
		},
		TopCities: []CityRow{
			{"İstanbul", 5_120_000, 19_800, 258.6},
			{"Bursa", 1_180_000, 4_600, 256.5},
			{"Kocaeli", 720_000, 2_850, 252.6},
			{"Tekirdağ", 480_000, 1_920, 250.0},
			{"Balıkesir", 410_000, 1_650, 248.5},
			{"Sakarya", 290_000, 1_580, 183.5},
		},
		OrderTrend: []TrendPoint{
			{monthNames[0], 2_180}, {monthNames[1], 1_990}, {monthNames[2], 2_520},
			{monthNames[3], 2_330}, {monthNames[4], 2_720}, {monthNames[5], 2_970},
			{monthNames[6], 3_060}, {monthNames[7], 2_880}, {monthNames[8], 2_680},
			{monthNames[9], 2_850}, {monthNames[10], 3_130}, {monthNames[11], 3_190},
		},
		TopProducts: []ProductRow{
			{"OYUNCAK PVC POS ET BEBEK", "OYUNCAK", 4_180, 65_100},
			{"ZEKA KÜPÜ 3X3", "AKIL OYUN", 3_260, 50_800},
			{"AHŞAP BLOK SETİ", "EDU PLAY", 2_740, 46_600},
			{"BOYAMA AKTİVİTE KİTABI", "SANAT", 2_560, 32_300},
			{"MİNİ MUTFAK SETİ", "EV YAŞAM", 2_020, 43_200},
		},
		GenderDist: []GenderSlice{
			{"K", 8_390, 4_612_000},
			{"E", 6_490, 3_588_000},
		},
	}
}
