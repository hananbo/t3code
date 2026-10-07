# APFS copy-on-write workspaces

CoW reuses a thread's `worktreePath` as its execution root. It deliberately does not
change event/projection storage, provider adapters, or Git UI routing.
`ThreadLaunchService` owns allocation for clients, scheduled tasks, handoffs and
workers. Capability is checked by the execution host; it never follows the client's OS.

## Supported content and native boundary

The initial backend requires macOS and one APFS volume for source and destination.
The signed helper uses descriptor-relative `fclonefileat`; there is no ordinary-file
copy fallback or runtime compiler. It copies current working contents, including
ignored inputs, excluding `.git` and `.t3`. Git metadata is prepared separately.
It supports SHA-1 ordinary repositories and linked worktrees, not alternate bases,
non-Git projects, shallow/partial clones, alternates, submodules, sparse/split indexes,
unresolved merges, nested repositories, external links, FIFOs or devices. Unix
sockets are omitted because they belong to running source processes; links to
those sockets are rejected rather than left dangling or shared with the source.

Regular files preserve executable/POSIX modes, extended attributes, ACLs and mtime.
The allocation root is private, with inherited ACLs removed. Directory metadata is
independently created, with source directory mode, mtime, ACLs and xattrs applied
after cloning children. Relative internal symlinks retain targets and mtime; their
ACLs/xattrs and birth times are not reproduced. Source hardlinks become
independent file clones. Sparse storage follows APFS's native clone semantics; no
storage savings are inferred from apparent sizes.

Creation compares native identities, size, mode, nanosecond timestamps, entries and
link targets, plus Git index, HEAD and refs. This detects cooperative concurrent
writers; it is not an atomic filesystem snapshot or adversarial containment.
A same-user unrestricted agent can access the source or host metadata directly.
Provider permissions and approval policy remain the enforcement boundary.

## Ownership, Git and integration

The trusted host stores versioned ownership records and journals under its state
folder, outside the agent checkout. Unknown records fail closed for the affected
copy. Opaque IDs bind project, host, thread, command and native root/Git identities.
Reserved CoW roots with missing journals must never be recreated as Git worktrees.

Each copy has private Git objects, refs, index, config and reflogs. Effective config
includes are flattened at creation; relative local remotes are resolved against the
source. User Git actions retain normal conversion, authentication and signing policy.
Internal commands suppress hooks, filters, external diff, pagers and global config,
and explicitly route Git/index/object environments. Baselines contain raw eligible
working bytes, captured with a private index before provider startup. Ignored inputs
are cloned but excluded from automatic integration.

Integration compares creation baseline B with current copy S and current original
checkout T. It never attributes inherited dirty edits to the session. Selected
additions, deletions, modes, links and binary files apply if T still matches B;
non-overlapping text edits merge, incompatible changes return conflicts without
writing. Source index and unrelated dirty files remain untouched. Multi-file writes
have a durable rollback journal and replay receipts. There is no network stage in
integration; publication remains an existing user Git action.

## Retention and compatibility

Archive keeps the copy and reopening verifies its ownership. Explicit removal
rejects active/shared use, requires separate discard confirmation for dirty or
ignored contents, and retains all refs plus detached/reflog/stash history in a
verified bundle before tombstoning the owned root. Source branch names are never
restored. Removed copies do not resume; bundle restoration is currently manual.
Automatic worktree cleanup intentionally skips private repositories.

Existing clients receive compatible root/worktree strategies plus optional CoW
hints. Durable server strategies retain CoW; older scheduled-task edits preserve
it. Ordinary local and worktree paths do not depend on native helper availability.
