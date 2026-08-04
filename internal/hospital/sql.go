package hospital

// SQL and seed data for the hospital remote-support masking workload.
//
// The whole point of this demo is that the APPLICATION QUERY NEVER CHANGES:
// the identical parameterized SELECT is sent once over the direct connection
// and once through the Quentra gateway. Whatever each route returns is shown
// verbatim in the UI, so data only appears masked when the gateway actually
// masks it — the demo cannot fake a mask that did not happen.
//
// The dataset is entirely fictional: names, TC numbers, phones, addresses and
// diagnoses are invented for the demo. TC numbers deliberately fail the real
// checksum so they can never collide with a real person.

const (
	// DBName is the disposable database this workload provisions and owns.
	DBName = "HOSPITALSIM"
)

// patientQuery is THE query of the demo — the support screen's patient lookup.
// Both routes run exactly this text as a parameterized statement; a Quentra
// masking rule should match it regardless of the @id value. It returns a small
// page of rows so the demo's result grid looks like a real SSMS result set.
const patientQuery = `SELECT HASTA_ID, AD, SOYAD, TCKN, TELEFON, KAN_GRUBU, ADRES, TANI
FROM dbo.HASTA
WHERE HASTA_ID BETWEEN @id AND @id + 4`

// countSQL verifies the seed.
const countSQL = `SELECT COUNT_BIG(*) FROM dbo.HASTA`

// provisionStmts create and seed the disposable patient table. Idempotent.
var provisionStmts = []string{
	`IF OBJECT_ID('dbo.HASTA','U') IS NULL
	CREATE TABLE dbo.HASTA(
		HASTA_ID  INT           NOT NULL PRIMARY KEY,
		AD        NVARCHAR(40)  NOT NULL,
		SOYAD     NVARCHAR(40)  NOT NULL,
		TCKN      CHAR(11)      NOT NULL,
		TELEFON   VARCHAR(20)   NOT NULL,
		KAN_GRUBU VARCHAR(8)    NOT NULL,
		ADRES     NVARCHAR(160) NOT NULL,
		TANI      NVARCHAR(160) NOT NULL
	);`,
	seedInsert,
}

// seedInsert loads the curated fictional patients. Row 1 is the pitch's
// "Ahmet Yılmaz" so the live demo reproduces the scenario word for word.
const seedInsert = `IF NOT EXISTS (SELECT 1 FROM dbo.HASTA)
INSERT INTO dbo.HASTA(HASTA_ID, AD, SOYAD, TCKN, TELEFON, KAN_GRUBU, ADRES, TANI) VALUES
 (1,  N'Ahmet',    N'Yılmaz',    '12345678901', '0532 417 28 45', 'A Rh+',  N'Ankara, Çankaya, Bağlıca Mah. 1214. Sk. No:7',      N'Tip 2 Diyabet — kontrol muayenesi'),
 (2,  N'Elif',     N'Demir',     '10000000146', '0533 611 74 02', '0 Rh-',  N'İstanbul, Kadıköy, Koşuyolu Mah. Salih Omurtak Sk. 12', N'Hipertansiyon — ilaç takibi'),
 (3,  N'Mehmet',   N'Kaya',      '10000000238', '0542 318 90 66', 'B Rh+',  N'İzmir, Bornova, Kazımdirik Mah. 372. Sk. No:18',    N'Astım — bahar alerjisi kontrolü'),
 (4,  N'Zeynep',   N'Şahin',     '10000000320', '0505 226 41 87', 'AB Rh+', N'Bursa, Nilüfer, Ataevler Mah. Gazi Cad. No:44',     N'Migren — nöroloji konsültasyonu'),
 (5,  N'Mustafa',  N'Çelik',     '10000000412', '0536 745 12 30', 'A Rh-',  N'Antalya, Muratpaşa, Fener Mah. Bülent Ecevit Blv. 9', N'Lomber disk hernisi — FTR programı'),
 (6,  N'Ayşe',     N'Arslan',    '10000000504', '0544 892 65 13', '0 Rh+',  N'Ankara, Keçiören, Etlik Mah. Yozgat Blv. No:21',    N'Hipotiroidi — TSH takibi'),
 (7,  N'Emre',     N'Koç',       '10000000696', '0538 154 77 29', 'B Rh-',  N'İstanbul, Üsküdar, Acıbadem Mah. Tekin Sk. 5',      N'Gastrit — endoskopi sonucu değerlendirme'),
 (8,  N'Fatma',    N'Aydın',     '10000000788', '0507 463 28 51', 'A Rh+',  N'Konya, Selçuklu, Bosna Hersek Mah. Uğurlu Sk. 3',   N'Anemi — demir eksikliği tedavisi'),
 (9,  N'Burak',    N'Özdemir',   '10000000870', '0531 907 34 18', '0 Rh+',  N'Adana, Çukurova, Güzelyalı Mah. Turgut Özal Blv. 61', N'Menisküs yırtığı — ortopedi kontrolü'),
 (10, N'Selin',    N'Yıldız',    '10000000962', '0545 720 89 06', 'AB Rh-', N'Eskişehir, Tepebaşı, Batıkent Mah. Çamlıca Sk. 14', N'Vertigo — KBB değerlendirmesi'),
 (11, N'Hakan',    N'Yıldırım',  '10000001057', '0534 286 50 73', 'A Rh+',  N'Samsun, Atakum, Denizevleri Mah. Atatürk Blv. 228', N'KOAH — solunum fonksiyon testi'),
 (12, N'Merve',    N'Öztürk',    '10000001149', '0553 341 96 20', 'B Rh+',  N'Gaziantep, Şahinbey, Karataş Mah. 103. Cad. No:8',  N'Gebelik takibi — 24. hafta'),
 (13, N'Onur',     N'Aslan',     '10000001231', '0539 578 03 46', '0 Rh-',  N'Kayseri, Melikgazi, Alpaslan Mah. Farabi Sk. 27',   N'Böbrek taşı — üroloji kontrolü'),
 (14, N'Gamze',    N'Doğan',     '10000001323', '0506 812 47 95', 'A Rh-',  N'Trabzon, Ortahisar, Kalkınma Mah. Deha Sk. 2',      N'Sedef hastalığı — dermatoloji takibi'),
 (15, N'İbrahim',  N'Kılıç',     '10000001415', '0541 635 21 78', 'B Rh+',  N'Mersin, Yenişehir, Pozcu Mah. GMK Blv. No:190',     N'Koroner arter hastalığı — efor testi'),
 (16, N'Esra',     N'Kurt',      '10000001507', '0530 194 68 32', '0 Rh+',  N'Denizli, Pamukkale, Kınıklı Mah. Üniversite Cad. 40', N'Panik bozukluk — psikiyatri takibi'),
 (17, N'Serkan',   N'Kara',      '10000001699', '0546 057 83 14', 'AB Rh+', N'Diyarbakır, Kayapınar, Peyas Mah. 296. Sk. No:11',  N'Epilepsi — EEG kontrolü'),
 (18, N'Derya',    N'Erdoğan',   '10000001781', '0537 429 60 58', 'A Rh+',  N'Sakarya, Serdivan, Arabacıalanı Mah. Çark Cad. 76', N'Safra kesesi taşı — cerrahi değerlendirme'),
 (19, N'Kemal',    N'Polat',     '10000001873', '0554 368 15 90', '0 Rh-',  N'Malatya, Yeşilyurt, İnönü Mah. Sivas Cad. No:33',   N'Prostat hiperplazisi — PSA takibi'),
 (20, N'Nazlı',    N'Aksoy',     '10000001965', '0508 741 52 06', 'B Rh-',  N'Balıkesir, Karesi, Paşaalanı Mah. Soma Sk. 19',     N'Romatoid artrit — biyolojik ajan takibi'),
 (21, N'Tolga',    N'Güneş',     '10000002050', '0543 916 27 84', 'A Rh+',  N'Kocaeli, İzmit, Yahyakaptan Mah. Şehit Rafet Cad. 4', N'Uyku apnesi — CPAP titrasyonu'),
 (22, N'Büşra',    N'Bulut',     '10000002142', '0535 083 49 61', '0 Rh+',  N'Aydın, Efeler, Ata Mah. Adnan Menderes Blv. 105',   N'Polikistik over sendromu — endokrin takip'),
 (23, N'Volkan',   N'Özkan',     '10000002234', '0549 652 70 38', 'B Rh+',  N'Tekirdağ, Süleymanpaşa, Hürriyet Mah. Şehitler Cad. 58', N'Ülseratif kolit — gastroenteroloji takibi'),
 (24, N'İrem',     N'Şimşek',    '10000002326', '0532 570 94 12', 'AB Rh-', N'Manisa, Yunusemre, Muradiye Mah. Mimar Sinan Blv. 22', N'Skolyoz — ortopedi kontrol grafisi'),
 (25, N'Cem',      N'Taş',       '10000002418', '0555 208 36 79', 'A Rh-',  N'Hatay, Antakya, Haraparası Mah. Yavuz Selim Cad. 7', N'Hepatit B taşıyıcılığı — karaciğer paneli'),
 (26, N'Pınar',    N'Çetin',     '10000002500', '0540 867 91 25', '0 Rh+',  N'Van, İpekyolu, Şerefiye Mah. Cumhuriyet Cad. 89',   N'Guatr — tiroid ultrasonu'),
 (27, N'Barış',    N'Korkmaz',   '10000002692', '0533 435 08 67', 'B Rh+',  N'Muğla, Menteşe, Orhaniye Mah. Uğur Mumcu Blv. 31',  N'Aşil tendiniti — spor hekimliği takibi'),
 (28, N'Seda',     N'Acar',      '10000002784', '0545 129 53 40', 'A Rh+',  N'Erzurum, Yakutiye, Lalapaşa Mah. Orduevi Sk. 6',    N'B12 eksikliği — replasman tedavisi');`

// PatientCount is how many curated rows the seed loads; the worker cycles
// through IDs 1..PatientCount.
const PatientCount = 28
