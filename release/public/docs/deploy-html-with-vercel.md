# Put an HTML page on the web with Vercel

When you make an HTML page with elanous — a report, a note, a diagram, a site draft — this guide puts it at a public address in a few minutes. It uses Vercel, a hosting service with a free plan.

## 1. One-time setup

1. Create an account at vercel.com. The free Hobby plan is for personal, non-commercial use; use a paid plan for business sites.
2. Install the command-line tool and sign in:
   ```bash
   npm i -g vercel
   vercel login
   ```

## 2. Deploy a folder

Put the page and everything it uses (images, CSS) in one folder, with the main file named `index.html`. Then:

```bash
cd my-page
vercel deploy --prod
```

The first time, answer the questions (project name, scope). Vercel prints the address, for example `https://my-page.vercel.app`.

## 3. Update it

Change the files and run `vercel deploy --prod` again in the same folder. The address stays the same.

## 4. Optional

| Want | Do |
|---|---|
| A preview address before going live | `vercel deploy` (without `--prod`) |
| Your own domain | Vercel dashboard → Project → Settings → Domains |
| Keep it out of search engines | Add `<meta name="robots" content="noindex">` to the page |

## Before you publish

- A deployed page is public. Do not put passwords, keys, personal data or private documents in the folder.
- Check that you have the right to publish every image and text in it.
