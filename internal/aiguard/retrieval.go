package aiguard

import "strings"

// retrievalPlan is the small, deterministic retriever in front of ATLAS. The
// previous demo pulled the same latest eight rows for every question, which
// made the UI look dynamic while the model context was actually fixed. A plan
// now records why a row belongs in this turn's context.
type retrievalPlan struct {
	Kind   string // none | broad | topic
	Status string // optional ticket status
	Term   string // optional LIKE term
}

const (
	retrievalNone  = "none"
	retrievalBroad = "broad"
	retrievalTopic = "topic"
)

type topicRule struct {
	Needles []string
	Term    string
}

// Rules are ordered from specific to general. The Term is written as it exists
// in the seeded Turkish corpus; Needles use folded ASCII for robust matching.
var topicRules = []topicRule{
	{[]string{"katalog"}, "katalog"},
	{[]string{"entegrasyon", "entegrasyon"}, "Entegrasyon"},
	{[]string{"kargo", "takip numarasi"}, "Kargo"},
	{[]string{"fatura tutar", "yanlis fatura", "fatura yanlis"}, "Fatura tutarı"},
	{[]string{"tahsilat"}, "tahsilat"},
	{[]string{"fatura"}, "Fatura tutarı"},
	{[]string{"sifre", "hesaba gir", "giris yap"}, "Şifre"},
	{[]string{"adres"}, "Adres"},
	{[]string{"garanti"}, "Garanti"},
	{[]string{"hasarli", "hasar", "ezilmis"}, "hasarlı"},
	{[]string{"iptal"}, "iptal"},
	{[]string{"bakim"}, "bakım"},
	{[]string{"tesekkur"}, "Teşekkür"},
	{[]string{"rapor"}, "Rapor"},
	{[]string{"k. aslan", "aslan"}, "K. Aslan"},
	{[]string{"ayse demir", "ayse"}, "Ayşe Demir"},
	{[]string{"mehmet yildiz", "mehmet"}, "Mehmet Yıldız"},
	{[]string{"zeynep kara", "zeynep"}, "Zeynep Kara"},
	{[]string{"emre sahin", "emre"}, "Emre Şahin"},
	{[]string{"fatma ozturk", "fatma"}, "Fatma Öztürk"},
}

var broadRetrievalWords = []string{
	"destek", "talep", "ticket", "sikayet", "oncelik", "ozet", "acik kayit",
	"kapali kayit", "konular", "musteri mesaj", "tum kayit", "tum acik",
}

func planRetrieval(question string) retrievalPlan {
	q := foldText(question)
	status := ""
	if containsAny(q, "kapali", "cozulmus", "tamamlanmis") {
		status = "kapalı"
	} else if containsAny(q, "acik", "bekleyen", "cozulmemis") {
		status = "açık"
	}

	for _, rule := range topicRules {
		if containsAny(q, rule.Needles...) {
			return retrievalPlan{Kind: retrievalTopic, Status: status, Term: rule.Term}
		}
	}

	if containsAny(q, broadRetrievalWords...) {
		return retrievalPlan{Kind: retrievalBroad, Status: status}
	}

	// A greeting, general-knowledge question or any other out-of-domain prompt
	// gets no RAG rows. With no retrieved record there is no stored prompt
	// injection to "pretend" happened.
	return retrievalPlan{Kind: retrievalNone}
}

func foldText(s string) string {
	var b strings.Builder
	for _, r := range s {
		b.WriteRune(fold(r))
	}
	return strings.ToLower(b.String())
}

func containsAny(s string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(s, needle) {
			return true
		}
	}
	return false
}
