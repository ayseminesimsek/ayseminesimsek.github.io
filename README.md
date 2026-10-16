# Ayşe Mine Şimşek — personal website

Personal website of Ayşe Mine Şimşek, built automatically by GitHub Pages (Jekyll). Edit a file, press **Commit changes**, and the site updates within 1–2 minutes.

## Putting it online

1. Create a GitHub account. The site address will be **`<username>.github.io`**, so pick the username with that in mind.
2. Create a new **public** repository named exactly `<username>.github.io`.
3. **Add file → Upload files**, drag in everything inside this folder (not the folder itself) and press **Commit changes**.
4. **Settings → Pages** → Source: **Deploy from a branch**, Branch: **main / (root)** → Save.
5. In `_config.yml` change `url:` to `https://<username>.github.io`.
6. After 1–2 minutes the site is live at `https://<username>.github.io`.

## Editing from the site (no GitHub needed)

Open **`https://<username>.github.io/admin/`**. Everything can be edited there: profile and photo, CV, projects, links, blog posts (with images), PDFs and site settings. Every save becomes a commit, and the site updates 1–2 minutes later.

**First time only:** the page asks for a GitHub token and lets you choose a username and password. The steps for creating the token are shown on the page:

- **Repository access:** only this repository
- **Permission:** Contents, set to **Read and write**

The token is encrypted with your username and password and saved in `admin/key.json`. After that, the username and password are all you need on any device.

- **Forgot the password or the token expired?** On the login page choose **Token'ı yenile**, paste a new token and set new login details.
- **Change the password:** go to **Ayarlar → Giriş bilgileri**.
- **Pick a strong password (10+ characters).** `admin/key.json` sits in a public repository, so the password is what protects the token.

The sections below describe the files directly, which is still possible from GitHub.

## Where do I change what?

| What | File |
|---|---|
| Name, photo, tagline, city, social links | `_data/profile.yml` |
| About text | `_data/profile.yml` → `about:` |
| Contact details | `_data/profile.yml` → `contact:` |
| Education, interests, coursework, skills, experience | `_data/cv.yml` |
| Projects | `_data/projects.yml` |
| Links page | `_data/links.yml` |
| PDF titles and categories (optional) | `_data/documents.yml` |
| Blog posts | `_posts/` folder, one file per post |
| PDFs | `documents/` folder |
| Photo | `assets/photo.jpg` (upload a new photo with the same name) |
| Colours and layout | `assets/style.css` |

## Add a blog post

1. Open `_posts/2026-10-09-post-template.md` and copy its contents.
2. In the `_posts` folder choose **Add file → Create new file**.
3. Name it `YEAR-MONTH-DAY-post-name.md`, e.g. `2026-11-02-hot-rolling-notes.md` (lowercase letters, numbers and hyphens only).
4. Paste the template, delete the `published: false` line, write your post.
5. Press **Commit changes**.

The post appears at `<username>.github.io/blog/post-name/`. Posts dated in the future stay hidden until that date.

### Formatting (Markdown)

```
### Subheading
**bold**  *italic*
[link text](https://example.com)
- list item
> quote
![image description](/assets/image.jpg)
[Open the PDF](/documents/file-name.pdf)
$$E = mc^2$$          (needs "math: true" at the top of the post)
```

## Add a PDF

1. Open the `documents` folder → **Add file → Upload files**.
2. Drop the PDF in and press **Commit changes**.

It appears on the **Documents** page automatically. Nothing else to edit.

- Avoid spaces and special characters in file names: `phase-diagrams-notes.pdf`.
- For a nicer title, a description or a category, add an entry to `_data/documents.yml`.
- To remove a PDF from the site, delete the file from the `documents` folder.

## Hide something

- Post: add `published: false` at the top.
- Project: add `draft: true` under it.

## Good to know

- In `.yml` files the **spaces at the start of a line matter**. Keep the indentation when copying a line. Use spaces, not Tab.
- Keep text inside quotes `" "`. If you need a quote mark inside the text, use `'`.
- You rarely need to touch `_layouts`, `_includes` or `_config.yml`.
- If something breaks, open the **Actions** tab of the repository. A red cross shows the failing change and its error. Every file's **History** lets you go back to an older version.

Font: Latin Modern Roman (GUST Font License).
