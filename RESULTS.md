# QFlow scan results — 2026-10-07

Mode: **heuristic engine only** (`GEMINI_API_KEY` was empty, so the AI engine was disabled).
Run with `QFLOW_NON_INTERACTIVE=1`, headless Chromium, one site at a time.

| Site | Scan time | Raw findings | Valid | Same root cause (dup) | False positive |
|------|-----------|--------------|-------|-----------------------|----------------|
| vync-157i.vercel.app (own app) | 58 s | 9 | 7 | 0 | 2 |
| books.toscrape.com | 102 s | 9 | 6 | 3 | 0 |
| quotes.toscrape.com | 96 s | 7 | 7 | 0 | 0 |
| the-internet.herokuapp.com | 101 s | 13 | 5 | 7 | 1 |
| demo.playwright.dev/todomvc | 33 s | 8 | 8 | 0 | 0 |
| **Total** | **390 s (avg 78 s/site)** | **46** | **33** | **10** | **3** |

After grouping duplicates by root cause: **37 distinct issues, 34 real (92%), 3 false positives.**

## Triage notes

**Vync (own app)**
- Valid: missing security headers (only HSTS is set), FCP 3.9 s (single sample), 3 dead `href="#"` links,
  1 button without accessible label, no focus ring on "Continue with Google", missing OG tags,
  **Clerk loaded with development keys in production** (should be fixed).
- False positive: `_rsc` prefetch requests `ERR_ABORTED` (normal Next.js behaviour when navigation cancels a prefetch).
- False positive (likely): nav items "not visible" — scan landed on the sign-in redirect.

**books.toscrape.com**
- Valid: mixed content (jQuery over `http://`), security headers, h1→h3 heading jump, 68 small touch targets,
  missing meta description, missing OG tags.
- Duplicates: crawl issues, 23 console errors and 23 failed assets are all the same mixed-content jQuery block.

**quotes.toscrape.com** — all 7 valid; missing viewport meta and favicon verified with curl.

**the-internet.herokuapp.com**
- Valid: security headers, 45 small touch targets, missing meta description, favicon (verified 404), OG tags.
- Same root cause: the site was returning 503 for static assets during the scan, which produced the
  31 s load time, failed JS/images, `$ is not defined`, and the crawl/console/network findings.
- False positive: `/basic_auth` and `/digest_auth` returning 401 is intentional on this practice site.

**demo.playwright.dev/todomvc** — all 8 valid; missing viewport and favicon verified with curl.

## QFlow improvements spotted
- Dedupe identical messages (keyboard check lists the same button 4×, mixed content counted 23×).
- Treat `401` on auth-gated links and `ERR_ABORTED` on `_rsc` prefetches as expected.
