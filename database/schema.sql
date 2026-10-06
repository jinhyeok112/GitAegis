-- GitAegis 초기 논리 설계를 옮긴 MySQL 8 초안입니다.
-- 실제 인증, 결제, 검사 연동 전에 키 정책과 보존 기간을 확정하세요.

CREATE TABLE users (
  id CHAR(36) PRIMARY KEY,
  github_user_id BIGINT UNSIGNED NOT NULL UNIQUE,
  github_login VARCHAR(100) NOT NULL,
  email VARCHAR(320) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);

CREATE TABLE subscriptions (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL UNIQUE,
  plan_code VARCHAR(50) NOT NULL,
  status ENUM('incomplete', 'active', 'past_due', 'canceled', 'paused') NOT NULL DEFAULT 'incomplete',
  billing_interval ENUM('month', 'year') NOT NULL DEFAULT 'month',
  currency CHAR(3) NOT NULL DEFAULT 'KRW',
  base_price DECIMAL(12, 2) NULL COMMENT '확정 전 가격은 NULL로 둠',
  provider VARCHAR(40) NULL,
  provider_customer_id VARCHAR(191) NULL,
  provider_subscription_id VARCHAR(191) NULL,
  current_period_start DATETIME(3) NULL,
  current_period_end DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_subscriptions_user FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE KEY uq_subscription_provider_id (provider, provider_subscription_id)
);

CREATE TABLE repositories (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  github_repository_id BIGINT UNSIGNED NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  visibility ENUM('public', 'private') NOT NULL,
  connected BOOLEAN NOT NULL DEFAULT TRUE,
  scan_on_push BOOLEAN NOT NULL DEFAULT TRUE,
  scheduled_scan_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  scheduled_scan_frequency ENUM('daily', 'weekly') NOT NULL DEFAULT 'weekly',
  scheduled_scan_weekday TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '월요일=1, 일요일=7; 주간 검사에서 사용',
  scheduled_scan_time TIME NOT NULL DEFAULT '09:00:00',
  scheduled_scan_timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Seoul',
  next_scheduled_at DATETIME(3) NULL COMMENT '실제 스케줄러가 계산하는 UTC 기준 다음 실행 시각',
  default_branch VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_repositories_user FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE KEY uq_repository_owner_github_id (user_id, github_repository_id),
  KEY idx_repositories_user_connected (user_id, connected),
  KEY idx_repositories_next_scheduled (scheduled_scan_enabled, next_scheduled_at),
  CONSTRAINT chk_repositories_scan_weekday CHECK (scheduled_scan_weekday BETWEEN 1 AND 7)
);

CREATE TABLE scans (
  id CHAR(36) PRIMARY KEY,
  repository_id CHAR(36) NOT NULL,
  trigger_type ENUM('push', 'schedule', 'manual') NOT NULL,
  commit_sha CHAR(40) NULL,
  base_commit_sha CHAR(40) NULL,
  status ENUM('queued', 'running', 'completed', 'failed', 'canceled') NOT NULL DEFAULT 'queued',
  sast_count INT UNSIGNED NOT NULL DEFAULT 0,
  dependency_count INT UNSIGNED NOT NULL DEFAULT 0,
  error_message TEXT NULL,
  started_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_scans_repository FOREIGN KEY (repository_id) REFERENCES repositories(id),
  KEY idx_scans_repository_created (repository_id, created_at),
  KEY idx_scans_status_created (status, created_at)
);

CREATE TABLE vulnerabilities (
  id CHAR(36) PRIMARY KEY,
  repository_id CHAR(36) NOT NULL,
  fingerprint CHAR(64) NOT NULL COMMENT '커밋이 바뀌어도 같은 문제를 연결하는 정규화 지문',
  source ENUM('sast', 'dependency') NOT NULL,
  external_id VARCHAR(191) NULL COMMENT '예: Semgrep 규칙 ID 또는 CVE/OSV ID',
  title VARCHAR(500) NOT NULL,
  severity ENUM('critical', 'high', 'medium', 'low', 'info') NOT NULL,
  description TEXT NULL,
  impact TEXT NULL,
  status ENUM('open', 'triaging', 'resolved', 'false_positive', 'accepted_risk') NOT NULL DEFAULT 'open',
  first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  resolved_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_vulnerabilities_repository FOREIGN KEY (repository_id) REFERENCES repositories(id),
  UNIQUE KEY uq_vulnerability_fingerprint (repository_id, fingerprint),
  KEY idx_vulnerabilities_repo_status_severity (repository_id, status, severity)
);

CREATE TABLE scan_findings (
  id CHAR(36) PRIMARY KEY,
  scan_id CHAR(36) NOT NULL,
  vulnerability_id CHAR(36) NOT NULL,
  file_path VARCHAR(1024) NULL,
  start_line INT UNSIGNED NULL,
  end_line INT UNSIGNED NULL,
  code_snippet TEXT NULL,
  dependency_name VARCHAR(255) NULL,
  dependency_ecosystem VARCHAR(80) NULL,
  installed_version VARCHAR(100) NULL,
  affected_version_range TEXT NULL,
  fixed_version VARCHAR(100) NULL,
  advisory_url VARCHAR(2048) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_findings_scan FOREIGN KEY (scan_id) REFERENCES scans(id),
  CONSTRAINT fk_findings_vulnerability FOREIGN KEY (vulnerability_id) REFERENCES vulnerabilities(id),
  UNIQUE KEY uq_finding_scan_vulnerability (scan_id, vulnerability_id),
  KEY idx_findings_vulnerability (vulnerability_id, scan_id)
);

CREATE TABLE vulnerability_events (
  id CHAR(36) PRIMARY KEY,
  vulnerability_id CHAR(36) NOT NULL,
  actor_user_id CHAR(36) NULL,
  previous_status VARCHAR(40) NULL,
  new_status VARCHAR(40) NOT NULL,
  note TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_vulnerability_events_vulnerability FOREIGN KEY (vulnerability_id) REFERENCES vulnerabilities(id),
  CONSTRAINT fk_vulnerability_events_actor FOREIGN KEY (actor_user_id) REFERENCES users(id),
  KEY idx_vulnerability_events_vulnerability (vulnerability_id, created_at)
);

CREATE TABLE ai_usage_records (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  repository_id CHAR(36) NULL,
  vulnerability_id CHAR(36) NULL,
  feature VARCHAR(80) NOT NULL,
  model_name VARCHAR(100) NULL,
  input_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens INT UNSIGNED NOT NULL DEFAULT 0,
  quantity DECIMAL(14, 4) NOT NULL DEFAULT 0,
  estimated_cost DECIMAL(12, 4) NULL COMMENT '확정 요율에 따라 계산. 현재 가격 미정',
  currency CHAR(3) NOT NULL DEFAULT 'KRW',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ai_usage_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_ai_usage_repository FOREIGN KEY (repository_id) REFERENCES repositories(id),
  CONSTRAINT fk_ai_usage_vulnerability FOREIGN KEY (vulnerability_id) REFERENCES vulnerabilities(id),
  KEY idx_ai_usage_user_created (user_id, created_at)
);

CREATE TABLE invoices (
  id CHAR(36) PRIMARY KEY,
  subscription_id CHAR(36) NOT NULL,
  billing_period_start DATETIME(3) NOT NULL,
  billing_period_end DATETIME(3) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'KRW',
  subscription_amount DECIMAL(12, 2) NULL,
  ai_usage_amount DECIMAL(12, 2) NULL,
  total_amount DECIMAL(12, 2) NULL,
  status ENUM('draft', 'pending', 'paid', 'failed', 'void') NOT NULL DEFAULT 'draft',
  provider_invoice_id VARCHAR(191) NULL,
  issued_at DATETIME(3) NULL,
  paid_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_invoices_subscription FOREIGN KEY (subscription_id) REFERENCES subscriptions(id),
  UNIQUE KEY uq_invoice_provider_id (provider_invoice_id),
  KEY idx_invoices_subscription_period (subscription_id, billing_period_start)
);
