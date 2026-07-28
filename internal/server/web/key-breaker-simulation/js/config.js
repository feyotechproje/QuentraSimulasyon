// config.js — static demo data + scene layout constants (virtual coordinate space).
// Everything here is in-memory demo content. No real IPs, no real users, no payload
// is ever executed or sent anywhere. IPs use RFC 5737 documentation ranges only.

export const VIEW = { W: 1280, H: 720 };

// Scene layout in virtual coordinates (VIEW space). The renderer scales this to fit.
export const LAYOUT = {
  attackerX: 150,
  attackerTop: 132,
  attackerGap: 92,
  heroCx: 560,          // Key Breaker character horizontal center
  heroBaseY: 690,       // feet baseline
  heroHeight: 520,
  shieldCx: 632,
  shieldCy: 372,
  shieldR: 196,
  gatewayX: 812,
  gatewayTop: 176,
  gatewayGap: 74,
  dbX: 1120,
  dbCy: 372,
  safeLaneY: 300,       // green corridor y (safe queries flow left->right)
};

// Attack types with severity + matched pattern label (visual only).
export const ATTACK_TYPES = {
  TAUTOLOGY:   { label: "Tautology Injection",      tag: "SQLi",       pattern: "TAUTOLOGY_ALWAYS_TRUE",          risk: 97, sev: "critical" },
  UNION:       { label: "UNION-based Injection",    tag: "UNION",      pattern: "UNION_SELECT_CREDENTIAL_ACCESS", risk: 98, sev: "critical" },
  STACKED:     { label: "Stacked Query",            tag: "DROP",       pattern: "STACKED_QUERY_DDL",              risk: 95, sev: "critical" },
  AUTH_BYPASS: { label: "Authentication Bypass",    tag: "AUTH BYPASS",pattern: "AUTH_COMMENT_BYPASS",            risk: 90, sev: "high" },
  CMD_EXEC:    { label: "Command Execution",        tag: "CMD EXEC",   pattern: "XP_CMDSHELL_RCE",                risk: 99, sev: "critical" },
  TIME_BLIND:  { label: "Time-based Blind",         tag: "TIME DELAY", pattern: "TIME_BASED_BLIND_DELAY",         risk: 88, sev: "high" },
  COMMENT:     { label: "Comment Bypass",           tag: "SQLi",       pattern: "INLINE_COMMENT_BYPASS",          risk: 84, sev: "high" },
  INFO_SCHEMA: { label: "Information Schema Probe",  tag: "SCHEMA",     pattern: "INFORMATION_SCHEMA_PROBE",       risk: 79, sev: "medium" },
  ERROR_BASED: { label: "Error-based Injection",    tag: "SQLi",       pattern: "ERROR_BASED_EXTRACTION",         risk: 86, sev: "high" },
};

// Malicious payloads (display-only strings). `hot` marks the dangerous substring
// that the renderer highlights in red.
export const PAYLOADS = {
  TAUTOLOGY:   { text: "' OR 1=1 --",                                     hot: "OR 1=1" },
  UNION:       { text: "' UNION SELECT username, password FROM Users --", hot: "UNION SELECT" },
  STACKED:     { text: "1; DROP TABLE Users; --",                         hot: "DROP TABLE" },
  AUTH_BYPASS: { text: "admin' --",                                        hot: "admin' --" },
  CMD_EXEC:    { text: "'; EXEC xp_cmdshell('dir'); --",                  hot: "xp_cmdshell" },
  TIME_BLIND:  { text: "' OR SLEEP(5) --",                                 hot: "SLEEP(5)" },
  COMMENT:     { text: "' OR '1'='1'/*",                                   hot: "'1'='1'" },
  INFO_SCHEMA: { text: "' UNION SELECT table_name FROM information_schema.tables --", hot: "information_schema" },
  ERROR_BASED: { text: "' AND extractvalue(1,concat(0x7e,version())) --",  hot: "extractvalue" },
};

// Attacker source nodes — RFC 5737 documentation IPs only.
export const ATTACKERS = [
  { id: "ATK-01", ip: "203.0.113.42",   type: "TAUTOLOGY" },
  { id: "ATK-02", ip: "198.51.100.23",  type: "UNION" },
  { id: "ATK-03", ip: "192.0.2.77",     type: "STACKED" },
  { id: "ATK-04", ip: "203.0.113.99",   type: "CMD_EXEC" },
  { id: "ATK-05", ip: "198.51.100.200", type: "TIME_BLIND" },
  { id: "ATK-06", ip: "192.0.2.55",     type: "AUTH_BYPASS" },
  { id: "ATK-07", ip: "203.0.113.17",   type: "ERROR_BASED" },
];

// Legitimate application queries (safe lane). Parameterised = safe.
export const SAFE_QUERIES = [
  "SELECT name, email FROM Users WHERE id = @id",
  "SELECT * FROM Orders WHERE Status = @status",
  "SELECT ProductName, Price FROM Products WHERE CategoryID = @categoryId",
  "SELECT COUNT(*) FROM Customers WHERE Region = @region",
  "SELECT * FROM Inventory WHERE WarehouseID = @wid",
];

// Gateway pipeline modules (activate in sequence when inspecting a threat).
export const GATEWAY_MODULES = [
  "SQL Parser",
  "Pattern Engine",
  "Behavior Analysis",
  "Risk Scoring",
  "Policy Engine",
  "Key Breaker",
];

// Threat-analysis pipeline steps (bottom panel + gateway).
export const PIPELINE = [
  "Request Received",
  "SQL Fingerprint",
  "Syntax Analysis",
  "Pattern Match",
  "Risk Assessment",
  "Decision",
  "Block / Allow",
];

// Spawn cadence (seconds between packets) per mode.
export const TIMINGS = {
  attackInterval: 0.85,
  safeInterval: 1.05,
  maxAttackPackets: 22,
  maxSafePackets: 16,
};

// Brand asset file names (drop the provided PNGs into ./assets to use them).
export const ASSETS = {
  hero: "assets/key-breaker.png",
  icon: "assets/quentra-icon.png",
  logo: "/assets/quentra-logo.jpeg",
  reference: "assets/key-breaker-reference.png",
};
