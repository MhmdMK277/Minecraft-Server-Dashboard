# 0006. One repo, one platform

**Status:** accepted
**Date:** 2026-08-01

## Decision

This project ships one repository for one platform: Windows hosts running
their servers from Task Scheduler. There will be no stub repositories for
other platforms, no placeholder "coming soon" ports, and no repository map,
README matrix or organisation layout implying work that does not exist.

## Why

- **A stub repository is a claim.** An empty `mcdash-linux` repo tells a
  visitor that a Linux port is real, planned and owned. Until code exists,
  that is a statement about the future presented as a statement about the
  present, the same shape of dishonesty as a dashboard reading it cannot
  back (and the same shape as finding F6 in the security audit: words
  implying a mechanism nobody built).
- **The platform assumptions are structural, not cosmetic.** Identity comes
  from Windows process trees, scheduled-task lineage, and NTFS paths;
  launch is `start.bat` and `schtasks`; the proofs run against a real
  Windows fleet. A port is a project, not a folder.
- **One repo keeps the proofs honest.** Every claim in this repository is
  checkable on the machine class it names. A multi-platform layout would
  dilute that to "checkable somewhere, probably".

## What this means

- Requests for other platforms are answered by this document: out of scope
  until someone actually builds it, and building it means its own repo with
  its own proofs, not a stub here.
- Docker is separately out of scope for identification reasons; see
  decision 0004.
