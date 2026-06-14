@AGENTS.md

# FanslyTrends — Project Context

## [placeholder] in text templates

When a `text_template` on a post contains the word `[placeholder]`, it means that word should be swapped out for the model's niche/ethnicity when the content is generated for a specific model.

**Example:**
- Template stored: `On a 1-10 scale... how hot is my bare [placeholder] pussy?`
- Generated for an Asian model → `On a 1-10 scale... how hot is my bare asian pussy?`
- Generated for a British/milf model → `On a 1-10 scale... how hot is my bare British pussy?`

The replacement value comes from the model's niche or a niche-specific adjective (e.g. `asian`, `latina`, `muslim`, `british`). When generating overlay text for a model, always substitute `[placeholder]` with the appropriate term for that model's primary niche.

## Terminology

- **hashtags** — hashtags used on Fansly posts (e.g. `#milf`, `#british`)
- **niches** — niche keywords manually assigned to describe which models a piece of content is suitable for (e.g. `asian`, `teen`, `milf`, `muslim`). Stored in `trends_niches` table, dynamic and user-managed.
- **niche_tags** — `text[]` column on `trends_posts` used for feed filtering by content type
- **ideas** — bookmarked posts saved to `trends_ideas`, each tagged with one or more niches
- **matched ideas** — ideas whose niches overlap with a model's niches; surfaced on the model's page

## DB tables (key ones)

- `trends_posts` — scraped Fansly posts; has `text_template`, `niche_tags`, `hashtags`
- `trends_ideas` — bookmarked posts; has `post_id`, `niches text[]`, `notes`, `tags`
- `trends_models` — models tracked; has `fansly_username`, `niches text[]`, `hashtags`, `branding_file_md`
- `trends_niches` — user-managed niche definitions; has `name`, `emoji`, `color_key`, `sort_order`
- `video_jobs` — render job queue; statuses: `pending → approved → rendering → done → failed`
- `model_clips` — footage pools per model
