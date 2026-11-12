# Setup checklist

About 30 minutes, once. After that, adding a recipe is Share, then **Recipe Book**.

| | Step | Who | Time |
|---|---|---|---|
| 1 | Put the code on GitHub and turn on the website | Jordan (Claude pushes the code) | 5 min |
| 2 | Make the setup code | Jordan | 3 min |
| 3 | Pick the chef: API key or scheduled routine | Jordan | 10 min |
| 4 | Install the app on both phones | Each of you | 2 min each |
| 5 | Build the Shortcut, AirDrop it to Lauren | Jordan | 5 min |
| 6 | Optional: email links to harrishouse | Jordan | 5 min |

## 1. GitHub repo and website

1. Go to github.com/new. Name it **recipe-book**, make it **Public**, and don't add a README. Create it.
2. Claude pushes the code to it (it'll ask first).
3. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. **Actions** tab → **Website** → **Run workflow**. A minute later the book is at **https://jgrayharris.github.io/recipe-book/**. It's empty until the first recipe arrives.

Public means anyone with the address can see the book and the code. Nothing private lives there: recipes, your first names, and notes like "double the garlic". The setup code is never stored in the repo.

## 2. The setup code

A setup code is a GitHub "fine-grained personal access token": a password that only works for this one repo and only for what you tick. The phones, the Shortcut and the email script use it to add links.

1. Go to github.com/settings/personal-access-tokens/new.
2. Name: `Recipe Book phones`. Expiration: the longest it offers. Put a reminder in the calendar for a week before it ends.
3. Repository access: **Only select repositories** → **recipe-book**.
4. Permissions → Repository permissions: **Contents: Read and write** and **Issues: Read and write**. Leave everything else alone.
5. Generate it and copy it (it starts with `github_pat_`). Keep it in your password manager. GitHub won't show it again.

## 3. The chef

The chef is the Claude step that writes each recipe card. Pick one; you can switch any time with no other changes.

**A. Anthropic API key: recipes show up about 2 minutes after you share.**
1. Go to platform.claude.com, sign up, and add prepaid credits under Billing. Set a monthly spend limit while you're there.
2. **API Keys → Create key**, then copy it.
3. In the GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**. Name `ANTHROPIC_API_KEY`, then paste the key.
4. Cost: about 10¢ a recipe with Claude Opus 5.5, the default. For a fraction of a cent a recipe with rougher cards, add a repository **variable** (same page, Variables tab) named `CHEF_MODEL` with the value `claude-haiku-5-5`.

**B. Scheduled routine on your Claude plan: no key and no extra bill; recipes show up at the next run.**
Links still get prepped right away and wait in `queue/`. A Claude Code routine runs on the schedule you pick, writes the cards with the prompt in `pipeline/CHEF_ROUTINE.md`, and pushes them. Ask Claude Code to set it up with `/schedule`. It needs this repo connected to Claude on GitHub. The runs count toward your plan's usage.

## 4. The app on each phone

1. In **Safari**, open **https://jgrayharris.github.io/recipe-book/**.
2. Tap **Share → Add to Home Screen**.
3. Open it **from the home screen** (it keeps its own settings, separate from Safari), then tap ⚙️.
4. Tap your name, paste the setup code, and tap **Save**. It tests itself and says "All set".

## 5. The Shortcut

Follow `integrations/ios-shortcut.md`. Build it on one phone, then AirDrop it to the other.

## 6. Optional: email links to the house Gmail

For the "list of links we've been saving" case: email the links (one or a hundred) to the harrishouse address with **+recipes** added before the @, and each one becomes a recipe. Gmail delivers `+recipes` mail to the normal harrishouse inbox. Setup steps are at the top of `integrations/email-to-book.gs`. The addresses go in the script's Script Properties in the Google account, not in the repo, so they never become public. Only emails from the addresses in `SENDERS` get filed.

You can also paste a list of links on the app's **Add** page.

## When something goes wrong

- **The app's Add page** shows what's in the kitchen. A link marked "Needs a retry" has a **Retry** button. Failed links are also retried automatically once a day.
- **GitHub → Issues** has one issue per shared link. The Kitchen comments on each one with what it did.
- **GitHub → Actions → Kitchen** has the full log of each run.
- **Instagram** sometimes blocks the download. The recipe still arrives, marked "needs details". Open it and paste the caption.
