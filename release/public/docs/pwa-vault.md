# Vault — your Obsidian notes in the browser

The **Vault** menu of the web app opens your Obsidian vault. You can browse
it, search it, read and edit notes, create new ones, and explore tags and
links. Changes are written straight to the Markdown files in your vault, so
Obsidian sees them too.

The menu's labels are in Korean today, so this page gives each label as it
appears on screen, for example **태그** (Tags).

## Before you start

elanous needs to know where your vault is. If the Vault menu says it cannot find
the vault (**Obsidian vault를 찾을 수 없습니다**), set the folder once — either in
the web app or in the terminal:

- **Web app:** open **Settings**, find the **Obsidian & Skills** card and fill in
  **Obsidian vault path**. The Vault menu uses the new folder right away; you do
  not need to restart anything.
- **Terminal:**

  ```bash
  elanous onboarding      # the Obsidian step asks for the vault folder
  ```

Give the absolute path of the folder that contains your notes (the one with
the `.obsidian` folder inside).

## Browse and search

- In the **파일** (Files) view, the left side shows the folder tree and a breadcrumb for the current folder.
  The right side previews the selected file: Markdown, images and plain text.
- The search box searches the text of every note. Type `#tag` to search by tag.
- The **태그** (Tags) view lists every `#tag` in the vault, most used first. Pick one
  to see the notes that use it.

## Read and edit a note

Open a note to edit it. The editor has a live preview next to the text.

- **Saving is automatic.** The note is saved about two and a half seconds
  after you stop typing. The status next to the title shows **● 편집 중**
  (editing), **저장 중…** (saving) and **✓ 저장됨** (saved).
- **Links.** Type `[[` to get suggestions from your note names.
- **Outline and backlinks.** The side panel shows the note's headings, and the
  other notes that link to it.

### When the note changed somewhere else

If the same note was changed on disk after you last saved it — in Obsidian, or
on another device — elanous does not overwrite it silently. The editor shows a
conflict message with two choices:

- **디스크 버전 로드** (load the disk version) — replace your text with what is on disk.
- **강제 덮어쓰기** (overwrite) — keep your text and write it over the disk version.

The check starts when you open the note: elanous remembers the version it
loaded and refuses to write over a newer one.

## Create a note

Use **+ 새 노트** (new note) to create:

- an empty note with a title,
- a note from one of your vault templates, or
- today's daily note (saved under `Daily/`).

A new note never replaces an existing one. If a note with the same name is
already there, the dialog says **이미 존재하는 노트입니다** (the note already
exists) and nothing is written — pick another name or open the existing note.

## Graph

The **그래프** (Graph) view draws your notes as dots and their `[[links]]` as lines.
Click a dot to open that note. Focus mode shows only the notes linked directly
to the one you picked.

## Troubleshooting

- **Obsidian vault를 찾을 수 없습니다** (vault not found) — the vault folder is not set or does not exist. Set
  it with `elanous onboarding`.
- **The page does not load at all** — see [The web app (PWA)](pwa.md).
