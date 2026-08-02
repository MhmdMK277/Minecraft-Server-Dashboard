# 0007. The release stays a zip, not an exe

**Status:** accepted
**Date:** 2026-08-02

## Decision

Distribution is a zip containing the bundled Node runtime, the built app and
two `.bat` launchers, exactly as `scripts/package-release.ts` produces it.
No installer, no single-file exe, no self-extracting wrapper. Code signing is
revisited only if the project gets meaningful traction.

## Why

The recurring suggestion is "an exe would avoid the scary Windows warning".
It would not, and the reasoning keeps being re-derived, so it is recorded:

- **The warning is about being unsigned, not about being a zip.**
  SmartScreen and mark-of-the-web react to unsigned executable content from
  the internet. Repackaging the same unsigned code as an `.exe` does not
  remove the warning; it changes which dialog shows it.
- **A fresh unsigned exe scores worse.** SmartScreen reputation is built per
  file; a newly built, never-before-seen unsigned installer is exactly the
  shape it warns hardest about. The current zip keeps the bundled `node.exe`
  with its **valid OpenJS Authenticode signature intact through the zip
  round trip** (measured at release packaging), so the one program that
  actually runs is signed by a known publisher.
- **The zip is the category norm.** Crafty Controller's recommended Windows
  path is "extract and run" with no installer, and PocketMC ships a portable
  zip alongside its installer (`docs/comparison.md`). A portable zip with a
  bundled runtime is not a compromise here.
- **Unblocking is one action.** Explorer propagates mark-of-the-web to every
  extracted file, and unblocking the zip before extraction clears all of
  them at once (measured). `docs/install.md` documents that step.

## What this means

- Requests to "just make it an exe" are answered by this document.
- If traction ever justifies it, the change to make is **signing the
  existing zip's launcher path**, not switching container formats.
