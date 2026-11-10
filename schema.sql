CREATE TABLE IF NOT EXISTS users (
    chat_id INTEGER PRIMARY KEY,
    state TEXT DEFAULT 'IDLE',
    temp_scheme_code INTEGER,
    temp_scheme_name TEXT,
    temp_base_nav REAL
);

CREATE TABLE IF NOT EXISTS tracked_funds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    scheme_code INTEGER NOT NULL,
    scheme_name TEXT NOT NULL,
    baseline_nav REAL NOT NULL,
    target_pct REAL NOT NULL,
    target_nav REAL NOT NULL,
    last_nav REAL,
    is_triggered INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);