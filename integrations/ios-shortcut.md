# The "Recipe Book" Shortcut

Puts **Recipe Book** in the iPhone share menu. In TikTok, Instagram, Reddit, YouTube or Safari: tap **Share**, then **Recipe Book**. (In TikTok and Instagram it may sit under **More** or **Share to…** the first time.) You'll get a "Saved" notification. The link is prepped right away, and the recipe shows up in the book after the chef's next run (Mondays and Thursdays at noon).

You need the **setup code** (the GitHub key from SETUP.md, step 2). Build it once on your phone, then AirDrop it to the other phone.

## Build it (about 5 minutes)

1. Open **Shortcuts**, tap **+**, and name it **Recipe Book**. Tap the icon to pick a color and a fork-and-knife glyph.
2. Tap the **ⓘ** (or the name at the top), turn on **Show in Share Sheet**, then tap **Done**.
3. At the top, the first block reads "Receive **Any** input from **Share Sheet**". Tap **Any** and leave only **URLs**, **Text** and **Safari web pages** ticked. Tap "If there's no input" and choose **Get Clipboard**. (Then running the Shortcut from the home screen adds whatever link you copied.)
4. Add these actions in order. Use the search bar at the bottom to find each one.
   1. **Get URLs from Input**. It fills in "Shortcut Input" by itself.
   2. **Text**. Type the following on three lines, inserting the **URLs** variable from step 1 where it says URLs (tap the field, then the variable bar above the keyboard):
      ```
      URLs
      from: Jordan
      via: shortcut
      ```
      On Lauren's phone, change `Jordan` to `Lauren`.
   3. **Get Contents of URL**.
      - URL: `https://api.github.com/repos/jgrayharris/recipe-book/issues`
      - Tap **Show More**. Method: **POST**.
      - Headers: add `Authorization` = `Bearer ` followed by the setup code (one space after Bearer). Add `Accept` = `application/vnd.github+json`.
      - Request Body: **JSON**. Add a Text field `title` = `Add recipe`. Add a Text field `body` and insert the **Text** variable from step 2.
   4. **Show Notification**: `Saved to the recipe book 🍳`
5. Tap **Done**.

## Test it

Open any TikTok, tap **Share**, then **Recipe Book**. You should see the notification. On GitHub, the repo's **Issues** tab gets an "Add recipe" issue. A few minutes later the Kitchen comments that the link is prepped and labels it `needs-chef`. After the chef's next run, the issue closes with a link to the new card. The app's **Add** page shows the same progress under "In the kitchen".

## Give it to the other phone

In Shortcuts, long-press **Recipe Book**, then **Share**, then **AirDrop**. On the other phone, open it, tap **Add Shortcut**, then edit the **Text** action to change the name.

Don't share it as an iCloud link. The Shortcut contains the setup code, and an iCloud link works for anyone who has it.

## If it stops working

- **"Bad credentials" or 401:** the setup code expired or was mistyped. Make a new one (SETUP.md, step 2) and paste it into the Authorization header, after `Bearer `.
- **Nothing in the share menu:** in the share menu, scroll the app row to the end, tap **More**, then **Edit**, and turn on Recipe Book.
