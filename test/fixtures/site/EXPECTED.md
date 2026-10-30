# TestFlow Fixture Ground Truth Specification (`EXPECTED.md`)

This document serves as the single source of truth for the TestFlow test harness fixture (`test/fixtures/site/`).
Golden snapshot tests assert against these exact values to deterministically verify TestFlow's aggregation, scoring, dedup, and categorization logic.

---

## 1. Page Findings Specification

| Page / Endpoint | Rule ID | Category | Severity | Confidence | Finding Type | Status | Expected Findings Count |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `/page-a11y-fail.html` | `axe-image-alt` | `accessibility` | `critical` | `confirmed` | `bug` | **CONFIRMED** | 1 |
| `/page-a11y-fail-2.html` | `axe-image-alt` | `accessibility` | `critical` | `confirmed` | `bug` | **CONFIRMED** | 1 |
| `/page-ok.html` | — | — | — | — | — | **NONE** (clean baseline) | 0 |
| `/page-timeout.html` | `page-load-failure` | `Scan Coverage` | `info` | `high` | `coverage-failure` | **COVERAGE_FAILURE** | 1 |
| `/api/always-400` | `api-status-mismatch` | `network` | `medium` | `confirmed` | `bug` | **CONFIRMED** | 1 |
| `/api/needs-session` | `api-status-mismatch` | `network` | `low` | `suspected` | `environmental` | **SUSPECTED** | 1 |
| `/page-heavy.html` | `perf-budget-pageSizeBytes` | `performance` | `medium` | `confirmed` | `warning` | **CONFIRMED** | 1 |
| `/page-cwv.html` | — | — | — | — | — | **NONE** (within budgets) | 0 |

---

## 2. Page-by-Page Ground Truth Details

### 1. `page-a11y-fail.html`
- **Rule ID**: `axe-image-alt`
- **WCAG Criterion**: 1.1.1 Non-text Content (Level A)
- **DOM Selector**: `#violating-hero-img`
- **Severity**: `critical`
- **Confidence**: `confirmed`
- **Finding Type**: `bug`
- **Status**: **CONFIRMED**
- **Description**: Image element is missing the required `alt` attribute.

### 2. `page-a11y-fail-2.html`
- **Rule ID**: `axe-image-alt`
- **WCAG Criterion**: 1.1.1 Non-text Content (Level A)
- **DOM Selector**: `#violating-hero-img` (Identical DOM structure and selector to page 1)
- **Severity**: `critical`
- **Confidence**: `confirmed`
- **Finding Type**: `bug`
- **Status**: **CONFIRMED**
- **Cross-Page Dedup Invariant**: Findings on `page-a11y-fail.html` and `page-a11y-fail-2.html` must **NOT** merge because they are on different pages (different page URLs).
- **Within-Run Dedup Invariant**: Scanning the same page (`page-a11y-fail.html`) multiple times within a run or across matrix cells must produce exactly 1 finding with incremented `occurrences`.

### 3. `page-ok.html`
- **Description**: Clean valid HTML document with correct `lang`, `title`, semantic landmarks, valid contrast, and proper alt text.
- **Expected Findings Count**: `0`
- **Expected Quality Score**: `100`
- **Purpose**: True-negative baseline. TestFlow must not produce false-positive findings.

### 4. `page-timeout.html`
- **Rule ID**: `page-load-failure`
- **Category**: `Scan Coverage`
- **Severity**: `info`
- **Finding Type**: `coverage-failure`
- **Status**: **COVERAGE_FAILURE**
- **Deduplication Invariant**: Deliberate route hang past timeout must produce **exactly one** coverage failure record in the report, regardless of how many executors attempted the page. It must **NOT** be counted in headline `totalFindings` or `confirmedBugs`.

### 5. `GET /api/always-400`
- **Rule ID**: `api-status-mismatch`
- **Category**: `network`
- **Severity**: `medium`
- **Confidence**: `confirmed`
- **Finding Type**: `bug`
- **Status**: **CONFIRMED**
- **Categorization Invariant**: Genuinely broken public endpoint that returns 400 even on public GET requests. TestFlow must **NOT** classify this as `SUSPECTED` or unauthenticated; it must remain a real confirmed network bug.

### 6. `GET /api/needs-session`
- **Rule ID**: `api-status-mismatch`
- **Category**: `network`
- **Severity**: `low`
- **Confidence**: `suspected`
- **Finding Type**: `environmental`
- **Status**: **SUSPECTED**
- **Categorization Invariant**: Endpoint requires session authentication (`requiresSession: true`). When replayed anonymously without session credentials, returning 400 must be downgraded to `SUSPECTED` / needs-verification and excluded from quality score penalty.

### 7. `page-heavy.html`
- **Rule ID**: `perf-budget-pageSizeBytes`
- **Category**: `performance`
- **Severity**: `medium`
- **Confidence**: `confirmed`
- **Finding Type**: `warning`
- **Status**: **CONFIRMED**
- **Trigger**: Page asset `/heavy-asset.bin` delivers 3.5 MB, exceeding the default 3.0 MB (`3,000,000 bytes`) `pageSizeBytes` budget.

### 8. `page-cwv.html`
- **Description**: Normal page with visual hero element, injected layout shift, and main-thread long task.
- **Metric Invariants**:
  - `LCP`: Measured number > 0 ms (never literal bare 0)
  - `CLS`: Measured number > 0 unitless (never unmeasured)
  - `TBT`: Measured number > 0 ms (never unmeasured)
  - `FCP`: Measured number > 0 ms (never literal bare 0)
  - `TTFB`: Measured number > 0 ms (never literal bare 0)
- **Output Invariant**: Every Core Web Vital is either a genuine measured positive number or explicitly flagged as `unmeasured` / `{ measured: false }`. Never a bare `0` standing in for a failed measurement.

---

## 3. Summary Arithmetic Invariant

For the complete fixture scan:
- **Confirmed findings**: `4` (2 a11y bugs + 1 API bug + 1 perf warning)
  - Of which **Confirmed Bugs**: `3` (2 a11y + 1 API bug)
- **Suspected findings**: `1` (1 session-gated API mismatch)
- **Coverage failures**: `1` (1 timeout failure on `/page-timeout.html`)
- **Total findings shown**: `Confirmed (4) + Suspected (1) + Coverage-failures (1) = 6`
- **Displayed headline arithmetic**:
  `Confirmed + Suspected + Coverage-failures === Total findings shown`
- **Coverage %**: `5 / 6 pages scanned (83.3% coverage)`
