# Tably Team × Meta Global AI Developer Hackathon

**Track:** Startups · **Problem statement:** Build for Your World · **Building period:** Oct 27 – Nov 4, 2026

Tably Team is an existing product: a platform where a team of AI agents with roles (CEO, CTO, Head of Engineering, Product, Design, QA) debates an idea, researches reference apps, designs the screens, writes the code, reviews it and publishes the app. The hackathon rules allow startups to build on an existing codebase as long as the new work is clearly identified. This file is that identification.

## Where the line is

- Everything up to the git tag **`pre-hackathon`** (commit `62cccb4`, Oct 22, 2026) existed before the event.
- Everything after that tag was built during the building period. To see exactly what is new:

```bash
git log --oneline pre-hackathon..main
git diff --stat pre-hackathon..main
```

The demo video and the live demo only show the features listed under "Built during the hackathon".

## What existed before (for context only)

- The multi-model council (Claude, GPT, Gemini, DeepSeek, Grok, Llama, Kimi, Mistral, OpenRouter, Ollama), the direct builder lane, the design stage, the builder (Claude Code, Codex or an API model), reference research with a real browser, Tably Cloud (own git, one-click publish, Neon/Supabase provisioning), mobile builds with Expo, the blog and FAQ.
- The repository history before the tag is the proof.

## Built during the hackathon (with Meta models)

Each item links to the code and names the Meta model it uses. This list is updated as the work lands.

| # | Feature | Meta model | Where |
|---|---|---|---|
| 1 | **Meta · Muse as a first-class provider**: Muse Spark 1.3 and Muse Wonder 1.0 available for every role of the council, for prompt engineering and as the API builder, through the Meta Model API (OpenAI-compatible surface). | `muse-spark-1.3`, `muse-wonder-1.0` | `backend/app/providers.py`, `backend/app/pricing.py`, `frontend/src/lib/brand.ts`, `frontend/src/components/ProviderRow.tsx` |
| 2 | **Muse Code as the desktop builder**: Tably runs `muse exec --json` headless on the project (streams text, tool activity and tokens), resumes sessions, and «My sessions» lists and continues Muse Code conversations from this machine. Auth with the user's Meta Model API key or `muse login`. | Muse Code (`muse-wonder-1.0` by default) | `backend/app/local_engine.py`, `backend/app/agent_sessions.py`, `frontend/src/components/AgentSessions.tsx`, `frontend/src/components/SubscriptionPanel.tsx` |
| 3 | **Muse-first product**: every role lands on its recommended Muse model (Wonder for direction and engineering, Spark for product, design and QA), prompt engineering on Spark, shares and intros grouped by Muse model, Muse-only pickers for the hackathon edition. | `muse-wonder-1.0`, `muse-spark-1.3` | `frontend/src/lib/muse.ts`, `frontend/src/lib/flags.ts`, `frontend/src/components/Setup.tsx` |
| 4 | **Growth levels, Tably Analytics and the marketplace**: every project climbs a strict ladder the team follows to the letter (1 En línea → 2 Medido → 3 Visible → 4 Monetizado). Each level is a list of checks evaluated on the real project (files, council verdict, Tably Cloud, analytics hits); the builder and the council get the pending checks of the level being climbed as blocking items, the president marks each one and the UI shows the % towards the next level. Level 2 brings a built-in, cookie-less analytics collector (`/a.js` + `/api/a/<site>`). From level 1 the app can be listed on the marketplace (pitch, price, real visits) and its ownership transferred to another account. | council and builder on `muse-wonder-1.0` / `muse-spark-1.3` | `backend/app/levels.py`, `backend/app/orchestrator.py`, `backend/app/builder.py`, `backend/app/main.py`, `frontend/src/components/LevelsPanel.tsx`, `frontend/src/components/Marketplace.tsx` |
| 5 | **Notion tickets resolved by the team**: connect Notion (one-click OAuth or an internal token), pick the tickets database and link it to a Tably project. The Tickets screen groups them by urgency; «Resolver ticket» turns the page's Markdown into the builder's change request, the council verifies the result against the ticket (unmet items are blocking), and on approval the branch is pushed and the pull request opened; the ticket moves To do → In progress → Code review in Notion with a comment linking the PR. The merge stays human. | council and builder on `muse-wonder-1.0` / `muse-spark-1.3` | `backend/app/tickets.py`, `backend/app/main.py`, `frontend/src/components/Tickets.tsx` |
| 6 | **Video ads for Meta, made from the app**: the «Anuncios» pane captures the app's real screens (its routes, read from the code), Muse reads the code, README, brief and screens and writes a summary of what the app does (the user can correct it), recommends 5 of 20 ad templates (structures that are performing on Meta and TikTok in 2026, renewed monthly) and writes the script for the chosen one. Remotion renders it with After Effects-style motion (3D devices with light sweeps, masked text with motion blur, zoom-blur and whip transitions, grain) in vertical 9:16 and square 1:1, in the app's own colours or the user's choice of colours, type, background and text motion, previewed live in the browser. Publishing to Meta Ads (Marketing API) creates a paused campaign; it turns on once the Meta app passes review. | `muse-spark-1.3` | `backend/app/ads.py`, `backend/app/meta_ads.py`, `backend/video/src/`, `frontend/src/components/AdsPanel.tsx`, `frontend/src/components/AdTemplates.tsx` |
| 7 | **Ad Studio, five agents on the user's own footage**: from the home, the user uploads videos and images; a Listener transcribes them with Muse Voice Transcribe (realtime ASR, turn timestamps) and picks the best moments, a Director looks at frames of every video and the images and writes the edit plan, an Editor cuts it with Remotion (subtitles word by word, images with camera moves, title cards, transitions, end card), a Finisher watches the cut and improves it, and an Approver approves it or sends it back to the Finisher until it is right; then it exports vertical and square. | `muse-voice-transcribe-1.0`, `muse-spark-1.3` (vision) | `backend/app/studio.py`, `backend/app/transcribe.py`, `backend/app/media.py`, `backend/video/src/Studio.tsx`, `frontend/src/components/AdStudio.tsx` |

_(more rows are added as features ship: SAM 3.1 on reference screenshots, Muse Image in the design stage, Muse Voice Transcribe for spoken requests)_

## How to run it

See `README.md` and `docs/railway.md`. To use the Meta models, add a Meta Model API key under *Models and API keys* (env `META_API_KEY` for a server-wide key). For the one-click Notion connection set `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` (a public integration whose redirect URI is `<TABLY_CLOUD_URL>/api/notion/callback`) and `TABLY_APP_URL`; without them the Tickets screen takes an internal integration token.

## Team

Ivan Kolariki (solo founder) with the Tably Team agents.
