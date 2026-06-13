# FanslyTrends — AI Handoff: Two Broken Systems

You are inheriting a project with two independent problems. Both need to be diagnosed and fixed from scratch. The previous AI made multiple rounds of guesses without properly diagnosing root causes. Read this fully before touching any code.

---

## Project Overview

**Stack:** Next.js (Vercel) + Express pipeline server (Railway) + Supabase + Cloudflare R2 + GitHub Actions  
**Repo:** `/Users/leonardoguizzo/Documents/fansly-trends`  
**Pipeline service URL:** `https://fansly-trends-pipeline-production.up.railway.app`  
**Supabase project:** `krkezzuuyxfsihumbgut`  
**Supabase Management API PAT:** `sbp_7edb5cf80002f312396b7aca77906d9bf5babdf8`  
**After every git push:** run `railway up --service fansly-trends-pipeline` (auto-deploy is broken)

The tool has two parts:
1. **Scraper** — GitHub Actions cron, runs hourly, scrapes Fansly FYP + hashtag pages, stores posts in Supabase + videos in R2
2. **Pipeline** — Railway Express server, generates AI video briefs, composes videos with text overlay using Hyperframes, uploads to R2

---

## Problem 1: Scraper Stuck at ~1400 Posts

### Symptom
The scraper has been running hourly for 2+ days but the `trends_posts` table is stuck at ~1400 rows. It should be adding ~1000 new posts per day. Each run reports "added: 0" or very low numbers.

### Architecture
- `scraper/index.ts` — main orchestrator
- `scraper/fansly.ts` — Playwright login + FYP/hashtag API scraping
- `scraper/db.ts` — Supabase inserts
- `.github/workflows/scrape-daily.yml` — runs hourly, 10 fan accounts in `FANSLY_ACCOUNTS` secret

### How the scraper works
1. **Phase 1:** Loops over 10 fan accounts. For each: launches Playwright, logs into Fansly, captures auth headers from network requests to `apiv3.fansly.com`, then closes the browser. Calls `/api/v1/contentdiscovery/media/suggestionsnew` with `offset` pagination to collect up to `RAW_COLLECT_PER_ACCOUNT=300` posts per account.
2. **Phase 2:** Fetches top 150 hashtags. Distributes hashtag chunks across accounts. Scrapes each hashtag's pages via API.
3. **Phase 3:** Filters posts (`MIN_LIKES=150`, video-only, no banned hashtags). Checks `getExistingPostIds()` to skip already-stored posts. Downloads + uploads video/thumbnail to R2. Inserts into Supabase.
4. **Cap enforcement:** `MAX_POSTS_PER_CREATOR=20` — archives oldest posts when a creator exceeds 20.

### Likely root causes to investigate (in order of likelihood)

**A. FYP endpoint pagination limit**  
The `/contentdiscovery/media/suggestionsnew` endpoint may have a hard limit on how many unique posts it returns per session. With 10 accounts × 300 posts = 3000 raw collected, but if the API returns the same 140 posts per account regardless of offset, all 1400 posts are already in DB and every run inserts 0 new ones.  
**Diagnose:** Check the actual GitHub Actions run logs for Phase 1 output. Look at `+X (total: Y/300)` lines — are they making progress past offset ~1400/10=140, or is `noProgress` counter hitting 5 and stopping early?

**B. `getExistingPostIds` correctly reporting 100% duplicates**  
After 2 days of hourly runs, the FYP might simply be returning the same posts every time (Fansly's algorithm doesn't refresh fast enough). The scraper correctly skips them, but no new content enters.  
**Diagnose:** Check the logged line `📦 X already in DB, Y new` — if Y=0 consistently, this is it.

**C. Hashtag scraper not running (Phase 2 skipped)**  
Phase 2 only runs if `accountHeaders.length > 0` (i.e. Phase 1 successfully captured auth headers). If Phase 1 is failing to login or capture headers for all 10 accounts, Phase 2 is silently skipped.  
**Diagnose:** Look for `⚠️ No auth headers captured — skipping hashtag scraping` in logs.

**D. Fansly login / session expiry**  
The scraper tries to restore sessions from `session_*.json` files. In GitHub Actions, these files don't persist between runs (no artifact caching). So EVERY run re-logs in. If Fansly changed their login flow, rate-limits login attempts, or the TOTP key is wrong, all 10 accounts fail to authenticate.  
**Diagnose:** Look for `❌` or `Failed to capture auth headers` in Phase 1 logs.

**E. R2 upload bottleneck / timeout**  
Each post download+upload takes several seconds. If the Action is hitting the 120-minute timeout, runs are being killed mid-way.  
**Diagnose:** Check if GitHub Actions runs complete successfully (green) or are being cancelled/timed out.

### What to fix
- First: get the actual GitHub Actions run logs (the user can see these at github.com/trapitaleaks-debug/fansly-trends/actions)
- The most impactful fix is likely: **add more diverse data sources** beyond FYP pagination. The FYP endpoint has a finite window. Consider scraping by creator username (crawl top creators), not just FYP offset pagination.
- If session/login is the issue: cache sessions as GitHub Actions artifacts, or switch to a persistent scraper (Railway).

---

## Problem 2: Video Editing Pipeline Broken

### Symptom
The pipeline generates video "briefs" (AI-written instructions + text overlay) and is supposed to compose them using Hyperframes (HTML-to-video). The goal is to copy a trending Fansly video's style and apply it to the model's own footage. Key failures:
1. **Text is not appearing on videos** — even when "overlay_text" is set in the brief
2. **Text content is wrong** — the AI invents new text instead of copying the exact on-screen text from the source trending video
3. **Hyperframes has been failing** from day one with different bugs at each layer

### Architecture

```
pipeline/
  index.ts          — orchestrator: calls research → generate → process
  research.ts       — Claude generates video "briefs" (what to create per slot)
  generate.ts       — calls kie.ai to generate raw video from brief, OR uses own footage from R2
  process.ts        — composes video: Hyperframes (Linux) with ffmpeg fallback (Mac dev)
  compose.ts        — builds the Hyperframes HTML composition
  db.ts             — Supabase queries
  server.ts         — Express: POST /trigger/:handle runs the pipeline
```

### How video composition works (intended)

1. `research.ts` generates a brief per slot: `{ overlay_text, content_format, hook_description, own_footage_r2_key, ... }`
2. `process.ts::renderWithHyperframes()`:
   - Pre-normalizes video to H.264 mp4 (webm own footage → mp4)
   - Creates `comp_${slot}/` directory with `index.html` (from `compose.ts`) and `video.mp4` symlink
   - Runs: `hyperframes render comp_${slot}/ -o output.mp4 --no-browser-gpu --fps 30`
3. If Hyperframes fails → falls back to `ffmpeg drawtext`
4. Final video uploaded to R2

### Hyperframes bug history (all previously "fixed" but may still have issues)

**Bug 1 — Wrong HTML structure (FIXED in commit `ad9fab8`)**  
`data-composition-id` was placed on a `<meta>` tag in `<head>`. Hyperframes requires it on the **root `<div>` element** that wraps all clips. Without this, Hyperframes can't find the composition and fails immediately.  
Status: Fixed. `compose.ts` now uses correct structure. `hyperframes lint` returns 0 errors.

**Bug 2 — Using system chromium instead of chrome-headless-shell (FIXED in commit `45490fe`)**  
Hyperframes found `/usr/bin/chromium` (system Chrome from apt-get) instead of `chrome-headless-shell`. Regular Chrome doesn't support `HeadlessExperimental.beginFrame`, so Hyperframes fell back to screenshot mode (~2s/frame = 7+ minutes for a 10s video → timeout).  
Fix: Symlink `chrome-headless-shell` to `/usr/local/bin/chrome-headless-shell` and set `ENV HYPERFRAMES_BROWSER_PATH=/usr/local/bin/chrome-headless-shell` in Dockerfile.  
Status: Fixed in Dockerfile. **NOT YET VERIFIED in production** — the build was deploying when this document was written.

**Bug 3 — ffmpeg drawtext text not rendering (FIXED in commit `4352c0d`)**  
The ffmpeg fallback was generating text files with emoji (e.g. `😈`). Liberation Sans can't render emoji. When FreeType fails on an unsupported glyph, it silently fails the entire text measurement → `x=(w-text_w)/2` becomes NaN → text renders off-screen or not at all.  
Fix: Strip emoji from text before writing to the drawtext textfile.  
Status: Fixed.

### The core unsolved problem: text content

The pipeline's AI (`research.ts`) generates `overlay_text` for each brief. It is supposed to copy the trending source video's on-screen text. But:

- The scraper only stores the Fansly post's **caption** (hashtags + text typed by the creator below the video), NOT the text that's visually burned **on screen** in the video itself
- These are completely different — a post might have caption "#teen #18..." but have "You can only choose 2 options:" burned on the video frame
- When `text_mode = 'original'` is set in the suggestion approval UI, `research.ts` is told to "keep AI-generated overlay text" (there is no OCR step)
- The AI reads a brief description of the trending post and guesses what the on-screen text probably was — it's often wrong

**What needs to happen:**  
When a suggestion is approved with `text_mode = 'original'`, the pipeline should **extract the actual on-screen text** from the source video frame using OCR or Claude's vision capabilities, then use that as `overlay_text` rather than having the AI invent text.

**Implementation path:**
1. In `pipeline/process.ts` or a new `pipeline/ocr.ts`: download the source video's thumbnail from R2 (`thumbs/{fansly_post_id}.jpg`), send to Claude with vision (`claude-sonnet-4-6`, image + prompt "What text appears on screen in this video frame? Return only the exact text, nothing else"), use the result as `overlay_text`
2. This should happen in `research.ts` at brief generation time when `suggestion.text_mode === 'original'`
3. The `trends_posts` table has `thumbnail_r2_key` — use a presigned R2 URL to fetch the thumbnail

### Current state of the Railway deployment

As of writing, the pipeline server is running but failing with:
```
✗ Pipeline failed for @liisaofficial: getApprovedSuggestions: column trends_suggestions.reasoning does not exist
```

The `reasoning` column was dropped from the DB but the pipeline's `db.ts` query at `getApprovedSuggestions()` still selects it. This was fixed in commit `18f1c32` but the Railway build may still be deploying.

**Always check first:** `railway logs --service fansly-trends-pipeline` to see current errors before making changes.

---

## File Map

| File | Purpose |
|------|---------|
| `scraper/index.ts` | Main scraper: phases 1-3 |
| `scraper/fansly.ts` | Playwright login + API scraping |
| `scraper/hashtag.ts` | Hashtag page scraping |
| `scraper/db.ts` | Supabase insert/query for scraper |
| `.github/workflows/scrape-daily.yml` | Hourly GitHub Actions cron |
| `pipeline/server.ts` | Express server, `POST /trigger/:handle` |
| `pipeline/index.ts` | Pipeline orchestrator |
| `pipeline/research.ts` | Claude brief generation |
| `pipeline/generate.ts` | kie.ai video generation or own footage selection |
| `pipeline/process.ts` | Video composition (Hyperframes + ffmpeg fallback) |
| `pipeline/compose.ts` | Builds Hyperframes HTML composition |
| `pipeline/db.ts` | Supabase queries for pipeline |
| `Dockerfile` | Railway container (ffmpeg, chromium, chrome-headless-shell) |

---

## Key Environment Variables

```
HYPERFRAMES_BROWSER_PATH=/usr/local/bin/chrome-headless-shell   # set in Dockerfile
PRODUCER_BROWSER_GPU_MODE=software                               # SwiftShader on Railway
PRODUCER_PLAYER_READY_TIMEOUT_MS=90000
ANTHROPIC_API_KEY                                                # for research.ts + OCR
R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY          # Cloudflare R2
FANSLY_ACCOUNTS                                                  # JSON array of 10 accounts
```

---

## Diagnosis Checklist Before Writing Any Code

1. **Railway logs:** `railway logs --service fansly-trends-pipeline` — what's the current error?
2. **Trigger a run:** `curl -X POST https://fansly-trends-pipeline-production.up.railway.app/trigger/liisaofficial` — watch the logs in real time
3. **GitHub Actions:** Check the last 5 scraper runs at github.com/trapitaleaks-debug/fansly-trends/actions — what do the Phase 1 / Phase 2 logs say? Are runs completing or timing out?
4. **DB state:** Query `SELECT COUNT(*) FROM trends_posts WHERE archived_at IS NULL` to confirm actual post count
5. **Hyperframes:** After triggering a run, look for `[Hyperframes]` in logs — does it say "failed — falling back to ffmpeg" or does it succeed?
