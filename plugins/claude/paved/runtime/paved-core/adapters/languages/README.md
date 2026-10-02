# Language adapters

Knowledge tied to a programming language and its standard toolchain: build and package
tooling, test runners, type checkers and linters, module and visibility systems, and
idioms that affect how code is read and changed.

Framework-specific knowledge goes in `frameworks/`, even when a framework is tied to one
language. A framework adapter lists its language adapter under `requires.adapters`.
