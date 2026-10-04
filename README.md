# Home Fix

Snap a photo of a home problem and get the likely cause, a step-by-step fix, the tools and parts you need, and an honest call on when to bring in a pro. This app is the standalone companion to [Command Center](https://cstrigenzcrm.netlify.app/).

## v1 scope: DIY repair diagnosis

1. **Diagnose.** Add a photo (camera or library, compressed in the browser to 1280px JPEG) and/or a description, plus an optional room and the year the home was built. Then tap **Diagnose**.
2. **Result.** You get a title, likely cause, other possibilities, difficulty, time and a DIY cost range, tools, parts, ordered steps with cautions, and a list of "stop and call a pro if" conditions. Low-confidence results ask follow-up questions.
3. **Save to My fixes.** Each saved fix gets a thumbnail, a status (Open / In progress / Done) and a checkable step list. Checking the first step moves it to In progress, and checking the last step moves it to Done.

### Safety, in two layers
- **The model** is told to flag gas, the electrical panel, structural problems, asbestos or lead, large mold areas, roof or height work, sewage and anything that needs a permit.
- **Rule-based override** (`SAFETY_RULES` in the function): keyword rules run over your description and the model's title and cause. If any rule matches, the result is **forced** to "Call a pro," whatever the model said. The steps are deliberately not scanned, because "flip the breaker at the main panel" shouldn't flag every switch swap.

## Architecture
Same stack as Command Center: plain HTML, CSS and ES6, no build step, deployed on Netlify.

| File | What it does |
|---|---|
| `index.html`, `css/styles.css` | The UI, in the same retro palette and fonts as Command Center |
| `js/app.js` | Photo handling, the diagnose call, rendering, and the My fixes list |
| `js/storage.js` | Persistence. **v1 = localStorage only** (key `homefix-v1`). Built so it can be swapped for Supabase later. |
| `netlify/functions/diagnose-repair.js` | Calls Gemini (`gemini-3.6-flash`) with the photo inline. Uses schema-constrained JSON, 4096 max output tokens, a 55s timeout, a mime allowlist (JPEG/PNG/WebP), a 4 MB cap, and sends the key in a header, not the URL. |
| `test/diagnose-repair.test.js` | 14 tests with Gemini mocked: validation, safety rules, MAX_TOKENS, 503 and malformed output. Run with `node --test test/*.test.js` |

## Deploy checklist
1. Create the GitHub repo (e.g. `strigenzc/HomeFix`) and upload these files.
2. In Netlify, add a new site → import from that repo. No build command; publish directory `.`.
3. Under Site settings → Environment variables, add `GEMINI_API_KEY`. You can reuse the key from Command Center.
4. Deploy, then run one real diagnosis on your phone.

## Next up (not built)
- Supabase sync in the same project as Command Center, so fixes follow you across devices
- A link card on the Command Center Home tab (the decision on the Renovation tab is still open)
- Design inspiration → style/materials/budget plan
- Cost & material estimator
