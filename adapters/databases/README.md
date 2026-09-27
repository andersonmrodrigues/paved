# Database adapters

Knowledge tied to a database engine: schema and migration conventions, query analysis,
locking and transaction behavior that affects safe changes, and how to inspect a schema
without modifying data.

Migration-related tools are `destructive` unless they provably target a disposable
local database.
