# Harris House Recipes

A shared recipe book for Jordan and Lauren that fills itself. Share a TikTok, Instagram, Reddit or YouTube post (or any recipe site) to the **Recipe Book** Shortcut. After the chef's next run (Mondays and Thursdays at noon Pacific) it's a clean recipe card in the app: photo, shopping list, steps, time, and an Easy / Moderate / Professional label.

**First time? Start with [SETUP.md](SETUP.md).**

## How a link becomes a recipe

```
 iPhone share menu ─┐
 app's Add page ────┼──►  GitHub issue "Add recipe"  ──►  Kitchen workflow (GitHub Actions)
 email to harrishouse ┘   (the inbox: one per link)        1. gather: caption, comments, video, photos   pipeline/sources.py
                                                           2. stills + speech-to-text from the video    pipeline/media.py
                                                           3. the chef writes the card (Claude)         pipeline/chef.py
                                                           4. save recipes/<id>.json + images/<id>.jpg
                                                           5. comment on the issue and close it
                                                                    │
                                                                    ▼
                                                 Website workflow → GitHub Pages → the app on both phones
```

The chef runs one of two ways, and both follow `pipeline/chef_instructions.md`:
- **With `ANTHROPIC_API_KEY` set** (a repo secret), the Kitchen writes the card straight away.
- **Without it**, the Kitchen preps the link into `queue/` and labels the issue `needs-chef`. A scheduled Claude Code routine (`pipeline/CHEF_ROUTINE.md`) writes the cards and pushes them. The next Kitchen run closes the issues.

## Folders

| Path | What's there |
|---|---|
| `app/` | The website/app: `index.html`, `styles.css`, `app.js`, offline support (`sw.js`), icons. No build step. |
| `recipes/` | One JSON file per recipe: the source of truth. Edit one by hand and the website updates. |
| `images/` | `<id>.jpg` for the recipe page and `<id>-sm.jpg` for the browsing grid. |
| `data/household.json` | Favorites and "we made it" notes, saved by the app. |
| `queue/` | Prepped links waiting for the scheduled chef (empty when using an API key). |
| `pipeline/` | The Kitchen (Python). `kitchen.py` is the entry point; run it with no arguments for its commands. |
| `integrations/` | The iPhone Shortcut guide and the Gmail script. |
| `.github/workflows/` | `kitchen.yml` (cooks links) and `pages.yml` (publishes the website). |

## Handy commands

Run these from this folder with Python 3.10 or later:

```
python pipeline/kitchen.py test            # self-checks for the kitchen
python pipeline/kitchen.py preview         # build the website and open it at http://127.0.0.1:8000
python pipeline/kitchen.py try <link>      # cook one link on this computer (needs pip install -r pipeline/requirements.txt)
```

The app has its own self-checks: open it with `?test` at the end of the address.

## Settings you might change

- **Chef model:** repo variable `CHEF_MODEL` (default `claude-opus-5-5`; `claude-haiku-5-5` is much cheaper). `CHEF_EFFORT` is `medium` by default.
- **Speech-to-text model:** repo variable `WHISPER_MODEL` (default `small`; `base` is faster but makes more mistakes).
- **How the cards are written:** `pipeline/chef_instructions.md`. Card fields: `pipeline/recipe.schema.json`.
- **Names on the Settings page:** `HOUSEHOLD` at the top of `app/app.js`.
