# Maintainer notes

## GitHub repository settings

- **Description:** Capture thoughts, files and voice notes into Obsidian from anywhere. A free community plugin with a bento inbox.
- **Website:** leave empty (or the releases page).
- **Topics:** `obsidian`, `obsidian-plugin`, `quick-capture`, `note-taking`, `voice-notes`, `markdown`, `rust`, `global-shortcut`, `inbox`, `pdf`
- **Social preview:** upload `docs/social-preview.png` (Settings → General → Social preview).
- **Actions:** Settings → Actions → General → Workflow permissions → *Read and write permissions*.
- **Security:** Settings → Code security → turn on *Private vulnerability reporting*.

## Releasing

The tag must equal the version in `manifest.json`, with no leading `v` (Obsidian rejects `v1.0.0`).

First release (the version is already `1.0.0`):

```sh
git tag -a 1.0.0 -m "1.0.0"
git push origin 1.0.0
```

Later releases:

```sh
npm version patch   # or minor / major. Updates package.json, manifest.json, versions.json, then commits and tags.
git push && git push --tags
```

The workflow builds the plugin and the quick capture app for Windows, macOS and Linux and attaches everything to one **draft** release. Check it, add the notes from `CHANGELOG.md`, then publish.

## Community directory

Sign in at community.obsidian.md, link the GitHub account, add the plugin. It reads `manifest.json` from the default branch and installs from the release whose tag matches the version.

## Screenshots

The README images are in `docs/screenshots/`. The Wikipedia background in `capture-over-wikipedia.jpg` is from the "Cancer research" article (CC BY-SA 4.0); keep the credit under it in the README.
