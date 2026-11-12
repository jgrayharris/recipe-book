/**
 * Email links to the recipe book.
 *
 * Runs inside the harrishouse Google account (script.google.com), every 10 minutes.
 * It reads unread emails sent to the recipes address, pulls out every link, and adds
 * each one to the book, the same way the phone Shortcut does. One email can hold one
 * link or a whole list. Handled emails are marked read and labelled "Recipe Book".
 *
 * Setup (about 5 minutes; also in SETUP.md):
 *   1. Signed in as harrishouse, open script.google.com, click New project, name it "Recipe Book email".
 *   2. Replace the code with this file. Edit CONFIG below: ADDRESS and SENDERS.
 *   3. Project Settings (gear) > Script Properties > Add: GITHUB_TOKEN = the setup code.
 *   4. Back in the editor, choose the function "install" and click Run. Allow the access it asks for.
 * To stop it: Triggers (clock icon) > delete the trigger.
 */

const CONFIG = {
  REPO: 'jgrayharris/recipe-book',
  // Emails sent here are filed. Gmail delivers "name+anything@gmail.com" to "name@gmail.com".
  ADDRESS: 'harrishouse+recipes@gmail.com',
  // Only emails from these addresses are filed, so a stranger can't add to the book.
  // The name is what the book shows as "Added by".
  SENDERS: {
    'harrishouse@gmail.com': 'Us',
    // 'jordan@example.com': 'Jordan',
    // 'lauren@example.com': 'Lauren',
  },
  LABEL: 'Recipe Book',
};

// Links that are never recipes: unsubscribe footers, Google redirects, images.
const SKIP = /unsubscribe|mailto:|google\.com\/(maps|calendar)|accounts\.google|support\.google|apple\.com\/|\.(png|jpe?g|gif|webp)(\?|$)/i;

function fileRecipeEmails() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('Add GITHUB_TOKEN under Project Settings > Script Properties.');
  const label = GmailApp.getUserLabelByName(CONFIG.LABEL) || GmailApp.createLabel(CONFIG.LABEL);
  const threads = GmailApp.search(`to:${CONFIG.ADDRESS} is:unread`, 0, 20);
  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      if (!msg.isUnread()) continue;
      const from = msg.getFrom();
      const email = ((from.match(/<([^>]+)>/) || [null, from])[1] || '').trim().toLowerCase();
      const who = CONFIG.SENDERS[email];
      if (who) {
        const links = findLinks(msg.getSubject() + '\n' + msg.getPlainBody());
        links.forEach(url => {
          addToBook(token, url, who);
          Utilities.sleep(1500);   // GitHub dislikes bursts
        });
        console.log(`Filed ${links.length} link(s) from ${email}`);
      } else {
        console.log(`Ignored an email from ${email}: not in SENDERS`);
      }
      msg.markRead();
    }
    thread.addLabel(label);
  }
}

function findLinks(text) {
  const found = (text.match(/https?:\/\/[^\s<>"'()\[\]{}]+/gi) || [])
    .map(u => u.replace(/[.,;:!?*>]+$/, ''))
    .map(u => {   // undo Google's link wrapping
      const m = u.match(/^https?:\/\/www\.google\.com\/url\?(?:.*&)?q=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : u;
    })
    .filter(u => !SKIP.test(u));
  return [...new Set(found)];
}

function addToBook(token, url, who) {
  UrlFetchApp.fetch(`https://api.github.com/repos/${CONFIG.REPO}/issues`, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ title: 'Add recipe', body: `${url}\nfrom: ${who}\nvia: email` }),
  });
}

/** Run once: checks the inbox every 10 minutes from now on. */
function install() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'fileRecipeEmails')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('fileRecipeEmails').timeBased().everyMinutes(10).create();
  fileRecipeEmails();
}
