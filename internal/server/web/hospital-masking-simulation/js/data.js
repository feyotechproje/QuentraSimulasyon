// data.js — the query the editor starts with.
//
// It is a plain, runnable statement (no parameters), because the user executes
// it themselves from the SQL window: a parameterized @id would fail with
// "Must declare the scalar variable" when sent as an ad-hoc batch.
export const DEFAULT_SQL = `SELECT HASTA_ID, AD, SOYAD, TCKN, TELEFON, KAN_GRUBU, ADRES, TANI
FROM dbo.HASTA
WHERE HASTA_ID BETWEEN 1 AND 5;`;

// Identity columns: used only to decide whether an unmasked result deserves
// the "kimlik verisi açıkta" warning badge.
export const IDENTITY_COLUMNS = ["AD", "SOYAD", "TCKN", "TELEFON", "KAN_GRUBU", "ADRES"];
