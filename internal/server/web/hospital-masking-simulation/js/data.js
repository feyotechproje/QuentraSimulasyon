// data.js — demo dataset + client-side mask functions.
//
// Demo mode dramatizes the intended behavior with fictional patients and these
// mask functions. In LIVE mode none of this is used for the data itself: the
// screens render exactly what each SQL route returned, so masking only appears
// when the Quentra gateway really masked it.

export const DEMO_PATIENTS = [
  { id: 1, ad: "Ahmet",  soyad: "Yılmaz", tckn: "12345678901", telefon: "0532 417 28 45", kanGrubu: "A Rh+",  adres: "Ankara, Çankaya, Bağlıca Mah. 1214. Sk. No:7",        tani: "Tip 2 Diyabet — kontrol muayenesi" },
  { id: 2, ad: "Elif",   soyad: "Demir",  tckn: "10000000146", telefon: "0533 611 74 02", kanGrubu: "0 Rh-",  adres: "İstanbul, Kadıköy, Koşuyolu Mah. Salih Omurtak Sk. 12", tani: "Hipertansiyon — ilaç takibi" },
  { id: 3, ad: "Mehmet", soyad: "Kaya",   tckn: "10000000238", telefon: "0542 318 90 66", kanGrubu: "B Rh+",  adres: "İzmir, Bornova, Kazımdirik Mah. 372. Sk. No:18",       tani: "Astım — bahar alerjisi kontrolü" },
  { id: 4, ad: "Zeynep", soyad: "Şahin",  tckn: "10000000320", telefon: "0505 226 41 87", kanGrubu: "AB Rh+", adres: "Bursa, Nilüfer, Ataevler Mah. Gazi Cad. No:44",        tani: "Migren — nöroloji konsültasyonu" },
  { id: 5, ad: "Mustafa",soyad: "Çelik",  tckn: "10000000412", telefon: "0536 745 12 30", kanGrubu: "A Rh-",  adres: "Antalya, Muratpaşa, Fener Mah. B. Ecevit Blv. 9",      tani: "Lomber disk hernisi — FTR programı" },
  { id: 6, ad: "Ayşe",   soyad: "Arslan", tckn: "10000000504", telefon: "0544 892 65 13", kanGrubu: "0 Rh+",  adres: "Ankara, Keçiören, Etlik Mah. Yozgat Blv. No:21",       tani: "Hipotiroidi — TSH takibi" },
  { id: 7, ad: "Emre",   soyad: "Koç",    tckn: "10000000696", telefon: "0538 154 77 29", kanGrubu: "B Rh-",  adres: "İstanbul, Üsküdar, Acıbadem Mah. Tekin Sk. 5",         tani: "Gastrit — endoskopi değerlendirmesi" },
  { id: 8, ad: "Fatma",  soyad: "Aydın",  tckn: "10000000788", telefon: "0507 463 28 51", kanGrubu: "A Rh+",  adres: "Konya, Selçuklu, Bosna Hersek Mah. Uğurlu Sk. 3",      tani: "Anemi — demir eksikliği tedavisi" },
];

const star = (n) => "*".repeat(n);

export function maskName(s) {
  const t = (s || "").trim();
  if (!t) return t;
  return t[0] + star(Math.max(3, t.length - 1));
}

// "12345678901" -> "*** *** ** 901"
export function maskTC(tc) {
  const t = (tc || "").trim();
  return "*** *** ** " + t.slice(-3);
}

// "0532 417 28 45" -> "0532 *** ** 45"
export function maskPhone(p) {
  const t = (p || "").trim();
  return t.slice(0, 4) + " *** ** " + t.slice(-2);
}

export function maskBlood() { return "████"; }

// "Ankara, Çankaya, ..." -> "Ankara, ***"
export function maskAddress(a) {
  const t = (a || "").trim();
  const comma = t.indexOf(",");
  return (comma > 0 ? t.slice(0, comma) : t) + ", ***";
}

// The support engineer still needs the diagnosis to do the job — it stays open.
export function maskRow(r) {
  return {
    ...r,
    ad: maskName(r.ad),
    soyad: maskName(r.soyad),
    tckn: maskTC(r.tckn),
    telefon: maskPhone(r.telefon),
    kanGrubu: maskBlood(),
    adres: maskAddress(r.adres),
  };
}

export const MASKED_FIELDS = ["ad", "soyad", "tckn", "telefon", "kanGrubu", "adres"];

// The exact statement the backend sends down both routes (mirrors
// internal/hospital/sql.go). Typed into the SQL window and shown while idle /
// in demo mode; live mode's SQL panel replaces it with the DMV-captured text.
export const PATIENT_SQL = `SELECT HASTA_ID, AD, SOYAD, TCKN, TELEFON, KAN_GRUBU, ADRES, TANI
FROM dbo.HASTA
WHERE HASTA_ID BETWEEN @id AND @id + 4;`;

// A 5-row demo "result page" starting at idx (wraps around the demo set).
export function demoWindow(idx) {
  const out = [];
  for (let i = 0; i < 5; i++) out.push(DEMO_PATIENTS[(idx + i) % DEMO_PATIENTS.length]);
  return out;
}
