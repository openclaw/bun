# Backup owner rebind to R3

The previously exercised backup harness is unchanged except its SOURCE constant moves from57e6 to4fa442e332745f1f58ccedd27106abdafcf4e019. Its measurement helper remains byte-identical. Every one of the original eight source-contract files is byte-identical between those cuts: SQLite header worker and probe, worker URL, snapshot owners, backup creation, verification and CLI registration.

The additional backup-record.ts change adds an explicit TypeScript type to an existing object and removes a literal cast. It changes no emitted behavior. backup-database-discovery.ts adds a PostgreSQL pool initializer conditional on a configured PostgreSQL family; this fixture clears its environment and configures only SQLite/plugin resources. The schema-migration backup table changes add empty entries for PostgreSQL-only migrations. Their exact R3 bytes and the public plugin-backup contract are included in source-contract.json for native audit.

JIT controls use the fresh canonical ROOT/source/openclaw.mjs and its .buildstamp. The npm package does not ship that stamp; no compatibility bypass is added. Timed Node/Bun comparisons continue to use the fresh npm installation.

The real CLI creates and independently verifies a backup with an included managed .db resource, checks archived live rows/integrity/deleted-page compaction and unchanged source payloads, and rejects plugin runtime execution. This remains synthetic, credentialless and providerless. AOT receives only hash-admitted binaries from available native cells. Missing TS is explicitly not run. Results do not qualify restore activation, live writer locking, global/agent schema sanitization or comparative performance.

For the R3 freeze, all12 source-contract entries were rechecked against immutable59baf4a blobs and are byte-identical to the preceding R2 cut670a7ab. Fresh native receipts remain required.

For R4, all12 entries were checked against immutable4fa442e blobs and remain unchanged from R3. Source/current-root labels are rebound; no previous backup execution result transfers.
