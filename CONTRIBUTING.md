# Contributing

This repository is a **read-only mirror** of `skills/` in
[`danybgoode/golden-beans`](https://github.com/danybgoode/golden-beans). Every merge there that touches `skills/` is
pushed here as a fast-forward (`git subtree split --prefix=skills`), and a version bump then releases here as before
(see [RELEASING.md](RELEASING.md)).

- **Issues and pull requests:** open them in `danybgoode/golden-beans`.
- **Don't commit here directly.** A ruleset lets only the mirror's deploy key update `main` (a repo admin can bypass it
  in an emergency). A direct commit would make every later mirror push fail as non-fast-forward, blocking releases
  until it's merged back into golden-beans with `git subtree pull` (no `--squash`).
