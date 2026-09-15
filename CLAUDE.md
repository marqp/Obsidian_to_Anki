# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## Project Overview

**Obsidian_to_Anki** is an Obsidian plugin that syncs flashcards from Markdown files to Anki via AnkiConnect. It parses custom syntax patterns in notes and creates/updates Anki cards accordingly.

## Tech Stack

- **TypeScript** - Main language for the Obsidian plugin
- **Rollup** - Bundler (builds `main.ts` → `main.js`)
- **Obsidian API** - Plugin framework
- **AnkiConnect** - HTTP API for Anki communication (port 8765)
- **WebdriverIO** - E2E testing with Docker
- **Python** - Additional test suite and standalone CLI script

## Common Commands

```bash
# Development build (watch mode)
npm run dev

# Production build
npm run build

# Run E2E tests (requires Docker)
npm run test-wdio

# Run Python tests
npm run test-py

# Copy built plugin to test vault
npm run copy
```

## Architecture

### Core Files

- `main.ts` - Plugin entry point, handles Obsidian lifecycle and vault scanning
- `src/anki.ts` - AnkiConnect API wrapper (HTTP requests to Anki)
- `src/files-manager.ts` - Manages file scanning and batches Anki requests
- `src/file.ts` - Parses individual markdown files for flashcard syntax
- `src/note.ts` - Represents a single flashcard note
- `src/format.ts` - Markdown-to-HTML conversion using Showdown
- `src/settings.ts` - Plugin settings UI

### Key Interfaces

- `PluginSettings` - User configuration (custom regexps, syntax tokens, defaults)
- `ParsedSettings` - Runtime-resolved settings with compiled regexps
- `AnkiConnectNote` - Note format for AnkiConnect API

### Data Flow

1. User triggers vault scan via ribbon icon or command
2. `FileManager` filters files by scan directory and ignore globs
3. Each file is parsed for notes matching configured syntax patterns
4. Notes are batched into AnkiConnect `multi` requests for efficiency
5. New notes are added, existing notes updated, deleted notes removed
6. File hashes track which files need re-scanning

## Testing

### E2E Tests (WebdriverIO)

Tests run in Docker with Anki + Obsidian. Test suites in `tests/defaults/test_vault_suites/` auto-generate spec files unless prefixed with `ng_` (no generation).

### Python Tests

Located in `tests/anki/`, these validate the Python CLI script (`obsidian_to_anki.py`).

## Important Notes

- **build_runner**: A `dart run build_runner watch -d` process runs in the background - don't run `build_runner build` manually
- AnkiConnect must be running on `127.0.0.1:8765` for the plugin to work
- The plugin stores data in `obsidian_to_anki_data.json` (file hashes, added media)
- Custom syntax is defined via regular expressions in plugin settings
