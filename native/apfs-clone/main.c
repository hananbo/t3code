#define _DARWIN_C_SOURCE

#include <copyfile.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/clonefile.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

/* No copy or hard-link fallback exists. The parent owns creation/removal journals;
 * this helper only populates an already owned, empty private directory.
 * Native file clones preserve modes, timestamps, ACLs, xattrs and sparse extents;
 * directories preserve permission bits, atime/mtime, ACLs and xattrs. Root stays
 * private and ownership belongs to the creating user. Symlinks preserve literal
 * relative targets and atime/mtime, not link ACLs/xattrs. Creation/birth timestamps
 * of new directories and links are new. Source hard-link topology is flattened.
 * Before/after manifests detect cooperative writes, not hostile concurrent edits. */
static const char *failure = "io";
static char **exclusions;
static int exclusion_count;

typedef struct {
    char *path;
    char *target;
    struct stat info;
} Entry;

typedef struct {
    Entry *entries;
    size_t length;
    size_t capacity;
} Manifest;

static int fail(const char *reason) {
    failure = reason;
    return -1;
}

static bool same(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino &&
        a->st_size == b->st_size && a->st_mode == b->st_mode &&
        a->st_uid == b->st_uid && a->st_gid == b->st_gid &&
        a->st_nlink == b->st_nlink && a->st_flags == b->st_flags &&
        a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec &&
        a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec &&
        a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec &&
        a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
}

static bool excluded(const char *path) {
    for (int i = 0; i < exclusion_count; i++) {
        size_t length = strlen(exclusions[i]);
        if (strncmp(path, exclusions[i], length) == 0 &&
            (path[length] == '\0' || path[length] == '/')) return true;
    }
    return false;
}

static bool relative_path(const char *path) {
    if (path[0] == '\0' || path[0] == '/') return false;
    const char *start = path;
    do {
        const char *end = strchr(start, '/');
        size_t length = end == NULL ? strlen(start) : (size_t)(end - start);
        if (length == 0 || (length == 1 && start[0] == '.') ||
            (length == 2 && start[0] == '.' && start[1] == '.')) return false;
        if (end == NULL) break;
        start = end + 1;
    } while (true);
    return true;
}

/* Open each ancestor separately: O_NOFOLLOW on the final component alone does
 * not prevent a substituted ancestor redirecting an absolute path. */
static int open_root(const char *path) {
    if (path[0] != '/') { errno = EINVAL; return fail("path"); }
    int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) return -1;
    char *copy = strdup(path);
    if (copy == NULL) { close(fd); return -1; }
    char *save;
    for (char *part = strtok_r(copy, "/", &save); part != NULL;
         part = strtok_r(NULL, "/", &save)) {
        if (strcmp(part, ".") == 0 || strcmp(part, "..") == 0) {
            close(fd); free(copy); errno = EINVAL; return fail("path");
        }
        int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        int saved = errno;
        close(fd);
        if (next < 0) { free(copy); errno = saved; return -1; }
        fd = next;
    }
    free(copy);
    return fd;
}

static int mount_pair(int source, int destination) {
    struct statfs a, b;
    if (fstatfs(source, &a) < 0 || fstatfs(destination, &b) < 0) return -1;
    if (strcmp(a.f_fstypename, "apfs") != 0 || strcmp(b.f_fstypename, "apfs") != 0) {
        errno = ENOTSUP; return fail("filesystem");
    }
    if (memcmp(&a.f_fsid, &b.f_fsid, sizeof(a.f_fsid)) != 0) {
        errno = EXDEV; return fail("cross-volume");
    }
    return 0;
}

static int add(Manifest *manifest, const char *path, struct stat info, char *target) {
    if (manifest->length == manifest->capacity) {
        size_t capacity = manifest->capacity == 0 ? 128 : manifest->capacity * 2;
        Entry *entries = realloc(manifest->entries, capacity * sizeof(*entries));
        if (entries == NULL) return -1;
        manifest->entries = entries;
        manifest->capacity = capacity;
    }
    char *copy = strdup(path);
    if (copy == NULL) return -1;
    manifest->entries[manifest->length++] = (Entry){ copy, target, info };
    return 0;
}

static void dispose(Manifest *manifest) {
    for (size_t i = 0; i < manifest->length; i++) {
        free(manifest->entries[i].path);
        free(manifest->entries[i].target);
    }
    free(manifest->entries);
}

static int compare_entry(const void *a, const void *b) {
    return strcmp(((const Entry *)a)->path, ((const Entry *)b)->path);
}

/* Symlinks must resolve within the root, including intermediate symlinks. */
static bool contained_target(const char *root, const char *path, const char *target) {
    if (target[0] == '\0' || target[0] == '/') return false;
    char location[PATH_MAX], resolved[PATH_MAX];
    if (snprintf(location, sizeof(location), "%s/%s", root, path) >= (int)sizeof(location)) return false;
    if (realpath(location, resolved) == NULL) return false;
    struct stat target_info;
    /* Runtime IPC sockets are omitted, so their links cannot survive the copy. */
    if (stat(resolved, &target_info) < 0 || S_ISSOCK(target_info.st_mode)) return false;
    size_t length = strlen(root);
    if (strncmp(root, resolved, length) != 0 ||
        (resolved[length] != '/' && resolved[length] != '\0')) return false;
    const char *relative = resolved + length;
    if (relative[0] == '/') relative++;
    if (excluded(relative)) return false;
    /* Lexical traversal must also remain beneath root: a link that leaves and
     * returns through another symlink would otherwise depend on source paths. */
    int depth = 0;
    for (const char *p = path; *p != '\0'; p++) if (*p == '/') depth++;
    char lexical[PATH_MAX];
    snprintf(lexical, sizeof(lexical), "%s", path);
    char *slash = strrchr(lexical, '/');
    if (slash != NULL) *slash = '\0';
    else lexical[0] = '\0';
    char *copy = strdup(target);
    if (copy == NULL) return false;
    char *save;
    bool valid = true;
    for (char *part = strtok_r(copy, "/", &save); part != NULL;
         part = strtok_r(NULL, "/", &save)) {
        if (strcmp(part, "..") == 0) {
            if (--depth < 0) { valid = false; break; }
            slash = strrchr(lexical, '/');
            if (slash != NULL) *slash = '\0';
            else lexical[0] = '\0';
        } else if (strcmp(part, ".") != 0) {
            depth++;
            size_t used = strlen(lexical);
            if (snprintf(lexical + used, sizeof(lexical) - used, "%s%s", used ? "/" : "", part) >=
                (int)(sizeof(lexical) - used)) { valid = false; break; }
            /* Even a target ending inside the root can depend on an excluded
             * intermediate directory, which would leave a broken clone link. */
            if (excluded(lexical)) { valid = false; break; }
        }
    }
    free(copy);
    return valid;
}

static int scan(int fd, const char *root, const char *prefix, Manifest *manifest) {
    int duplicate = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (duplicate < 0) return -1;
    DIR *directory = fdopendir(duplicate);
    if (directory == NULL) { close(duplicate); return -1; }
    int result = 0;
    struct dirent *item;
    errno = 0;
    while ((item = readdir(directory)) != NULL) {
        if (strcmp(item->d_name, ".") == 0 || strcmp(item->d_name, "..") == 0) continue;
        char path[PATH_MAX];
        if (snprintf(path, sizeof(path), "%s%s%s", prefix, prefix[0] ? "/" : "", item->d_name) >= (int)sizeof(path)) {
            errno = ENAMETOOLONG; result = -1; break;
        }
        if (excluded(path)) continue;
        if (prefix[0] != '\0' && strcmp(item->d_name, ".git") == 0) {
            errno = ENOTSUP; result = fail("unsupported-layout"); break;
        }
        struct stat info;
        if (fstatat(fd, item->d_name, &info, AT_SYMLINK_NOFOLLOW) < 0) { result = -1; break; }
        /* A socket is a live IPC endpoint, not workspace content. Neither
         * recreate it nor share it with the source process. */
        if (S_ISSOCK(info.st_mode)) continue;
        if (info.st_mode & (S_ISUID | S_ISGID)) { errno = ENOTSUP; result = fail("special-mode"); break; }
        char *target = NULL;
        if (S_ISLNK(info.st_mode)) {
            char link[PATH_MAX];
            ssize_t count = readlinkat(fd, item->d_name, link, sizeof(link) - 1);
            if (count < 0) { result = -1; break; }
            link[count] = '\0';
            if (!contained_target(root, path, link)) { errno = ENOTSUP; result = fail("external-symlink"); break; }
            target = strdup(link);
            if (target == NULL) { result = -1; break; }
        } else if (!S_ISDIR(info.st_mode) && !S_ISREG(info.st_mode)) {
            errno = ENOTSUP; result = fail("special-file"); break;
        }
        if (add(manifest, path, info, target) < 0) { free(target); result = -1; break; }
        if (S_ISDIR(info.st_mode)) {
            int child = openat(fd, item->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
            if (child < 0) { result = -1; break; }
            struct stat opened;
            if (fstat(child, &opened) < 0 || !same(&info, &opened)) {
                close(child); errno = ESTALE; result = fail("source-changed"); break;
            }
            result = scan(child, root, path, manifest);
            int saved = errno;
            close(child);
            errno = saved;
            if (result < 0) break;
        }
        errno = 0;
    }
    if (item == NULL && errno != 0) result = -1;
    int saved = errno;
    closedir(directory);
    errno = saved;
    return result;
}

static int clone_tree(int source, int destination, const char *root, const char *prefix) {
    int duplicate = openat(source, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (duplicate < 0) return -1;
    DIR *directory = fdopendir(duplicate);
    if (directory == NULL) { close(duplicate); return -1; }
    int result = 0;
    struct dirent *item;
    errno = 0;
    while ((item = readdir(directory)) != NULL) {
        if (strcmp(item->d_name, ".") == 0 || strcmp(item->d_name, "..") == 0) continue;
        char path[PATH_MAX];
        if (snprintf(path, sizeof(path), "%s%s%s", prefix, prefix[0] ? "/" : "", item->d_name) >= (int)sizeof(path)) {
            errno = ENAMETOOLONG; result = -1; break;
        }
        if (excluded(path)) continue;
        struct stat info;
        if (fstatat(source, item->d_name, &info, AT_SYMLINK_NOFOLLOW) < 0) { result = -1; break; }
        if (S_ISSOCK(info.st_mode)) continue;
        if (S_ISLNK(info.st_mode)) {
            char link[PATH_MAX];
            ssize_t count = readlinkat(source, item->d_name, link, sizeof(link) - 1);
            if (count < 0) { result = -1; break; }
            link[count] = '\0';
            if (!contained_target(root, path, link)) { errno = ENOTSUP; result = fail("external-symlink"); break; }
            if (symlinkat(link, destination, item->d_name) < 0) { result = -1; break; }
            struct timespec times[] = { info.st_atimespec, info.st_mtimespec };
            if (utimensat(destination, item->d_name, times, AT_SYMLINK_NOFOLLOW) < 0) { result = -1; break; }
        } else if (S_ISREG(info.st_mode) || S_ISDIR(info.st_mode)) {
            int flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
            if (S_ISDIR(info.st_mode)) flags |= O_DIRECTORY;
            int child = openat(source, item->d_name, flags);
            if (child < 0) { result = -1; break; }
            struct stat opened;
            if (fstat(child, &opened) < 0 || !same(&info, &opened)) {
                close(child); errno = ESTALE; result = fail("source-changed"); break;
            }
            if (S_ISREG(info.st_mode)) {
                /* Every source hard link gets its own clone/inode. This preserves
                 * contents and supports pnpm stores without sharing writable files. */
                result = fclonefileat(child, destination, item->d_name, CLONE_NOOWNERCOPY | CLONE_ACL);
            } else {
                result = mkdirat(destination, item->d_name, 0700);
                if (result == 0) {
                    int target = openat(destination, item->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
                    if (target < 0) result = -1;
                    else {
                        result = clone_tree(child, target, root, path);
                        if (result == 0) result = fcopyfile(child, target, NULL, COPYFILE_XATTR | COPYFILE_ACL);
                        if (result == 0) result = fchmod(target, info.st_mode & 01777);
                        struct timespec times[] = { info.st_atimespec, info.st_mtimespec };
                        if (result == 0) result = futimens(target, times);
                        int saved = errno;
                        close(target);
                        errno = saved;
                    }
                }
            }
            int saved = errno;
            close(child);
            errno = saved;
            if (result < 0) break;
        } else { errno = ENOTSUP; result = fail("special-file"); break; }
        errno = 0;
    }
    if (item == NULL && errno != 0) result = -1;
    int saved = errno;
    closedir(directory);
    errno = saved;
    return result;
}

static int clone(int source, int destination, const char *root) {
    struct stat source_info, destination_info;
    if (fstat(source, &source_info) < 0 || fstat(destination, &destination_info) < 0) return -1;
    if (source_info.st_dev == destination_info.st_dev && source_info.st_ino == destination_info.st_ino) {
        errno = EINVAL; return fail("destination");
    }
    /* Reject a destination beneath source before listing: otherwise cloning the
     * source would recursively enumerate the destination being populated. */
    int ancestor = openat(destination, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (ancestor < 0) return -1;
    struct stat current = destination_info;
    while (true) {
        int parent = openat(ancestor, "..", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        int saved = errno;
        close(ancestor);
        if (parent < 0) { errno = saved; return -1; }
        struct stat parent_info;
        if (fstat(parent, &parent_info) < 0) { saved = errno; close(parent); errno = saved; return -1; }
        if (parent_info.st_dev == source_info.st_dev && parent_info.st_ino == source_info.st_ino) {
            close(parent); errno = EINVAL; return fail("destination");
        }
        if (parent_info.st_dev == current.st_dev && parent_info.st_ino == current.st_ino) {
            close(parent); break;
        }
        ancestor = parent;
        current = parent_info;
    }
    if (destination_info.st_uid != getuid() || (destination_info.st_mode & 0777) != 0700) {
        errno = EACCES; return fail("destination");
    }
    int duplicate = openat(destination, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (duplicate < 0) return -1;
    DIR *directory = fdopendir(duplicate);
    if (directory == NULL) { close(duplicate); return -1; }
    struct dirent *item;
    errno = 0;
    bool empty = true;
    while ((item = readdir(directory)) != NULL) {
        if (strcmp(item->d_name, ".") != 0 && strcmp(item->d_name, "..") != 0) { empty = false; break; }
    }
    int result = errno == 0 ? 0 : -1;
    int listing_errno = errno;
    closedir(directory);
    errno = listing_errno;
    if (result < 0) return result;
    if (!empty) { errno = EEXIST; return fail("destination"); }
    /* A restrictive POSIX mode alone is insufficient when ACLs were inherited. */
    acl_t acl = acl_init(0);
    if (acl == NULL) return -1;
    result = acl_set_fd_np(destination, acl, ACL_TYPE_EXTENDED);
    int saved = errno;
    acl_free(acl);
    errno = saved;
    if (result < 0) return result;
    Manifest before = {0}, after = {0};
    if (add(&before, "", source_info, NULL) < 0) return -1;
    result = scan(source, root, "", &before);
    if (result == 0) {
        /* A bounded phase milestone permits progress reporting and synchronizes
         * concurrency tests without sleeps or filesystem watcher resources. */
        fputs("clone-start\n", stderr);
        fflush(stderr);
        result = clone_tree(source, destination, root, "");
    }
    struct stat final_info;
    if (result == 0) result = fstat(source, &final_info);
    if (result == 0) result = add(&after, "", final_info, NULL);
    if (result == 0) result = scan(source, root, "", &after);
    if (result == 0) {
        qsort(before.entries, before.length, sizeof(Entry), compare_entry);
        qsort(after.entries, after.length, sizeof(Entry), compare_entry);
        if (before.length != after.length) result = fail("source-changed");
        for (size_t i = 0; result == 0 && i < before.length; i++) {
            Entry *a = &before.entries[i], *b = &after.entries[i];
            if (strcmp(a->path, b->path) != 0 || !same(&a->info, &b->info) ||
                ((a->target == NULL) != (b->target == NULL)) ||
                (a->target != NULL && strcmp(a->target, b->target) != 0)) result = fail("source-changed");
        }
        if (result < 0) errno = ESTALE;
    }
    saved = errno;
    dispose(&before); dispose(&after);
    errno = saved;
    return result;
}

/* mount_pair already established that source and destination descriptors belong
 * to the same APFS volume. Use harmless bytes on that volume; probing must not
 * clone repository secrets before the parent's durable creation intent. */
static int probe(int parent) {
    char name[64];
    snprintf(name, sizeof(name), ".t3-cow-probe-%08x%08x", arc4random(), arc4random());
    int result = mkdirat(parent, name, 0700);
    if (result < 0) return result;
    int directory = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory < 0) result = -1;
    else {
        acl_t acl = acl_init(0);
        if (acl == NULL) result = -1;
        else {
            result = acl_set_fd_np(directory, acl, ACL_TYPE_EXTENDED);
            int saved = errno;
            acl_free(acl);
            errno = saved;
        }
        int file = -1;
        if (result == 0) {
            file = openat(directory, "source", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
            if (file < 0) result = -1;
        }
        if (file >= 0) {
            const char bytes[] = "t3-apfs-clone-probe";
            if (write(file, bytes, sizeof(bytes)) != sizeof(bytes)) result = -1;
            if (result == 0) result = fclonefileat(file, directory, "probe", CLONE_NOOWNERCOPY);
            int saved = errno;
            if (result == 0 && unlinkat(directory, "probe", 0) < 0) { result = -1; saved = errno; }
            close(file);
            if (unlinkat(directory, "source", 0) < 0 && result == 0) { result = -1; saved = errno; }
            errno = saved;
        }
        int saved = errno;
        close(directory);
        errno = saved;
    }
    int saved = errno;
    if (unlinkat(parent, name, AT_REMOVEDIR) < 0 && result == 0) { result = -1; saved = errno; }
    errno = saved;
    return result;
}

int main(int argc, char **argv) {
    if (argc < 4 || (strcmp(argv[1], "probe") != 0 && strcmp(argv[1], "clone") != 0)) return 64;
    bool probing = strcmp(argv[1], "probe") == 0;
    exclusions = argv + 4;
    exclusion_count = argc - 4;
    for (int i = 0; i < exclusion_count; i++) {
        if (!relative_path(exclusions[i])) { errno = EINVAL; fail("path"); goto error; }
    }
    int source = open_root(argv[2]);
    if (source < 0) goto error;
    int destination = open_root(argv[3]);
    if (destination < 0) { int saved = errno; close(source); errno = saved; goto error; }
    int result = mount_pair(source, destination);
    if (result == 0) result = probing ? probe(destination) : clone(source, destination, argv[2]);
    int saved = errno;
    close(source); close(destination);
    errno = saved;
    if (result == 0) { puts("{\"ok\":true}"); return 0; }
error:
    if (strcmp(failure, "io") == 0 && errno == ENOTSUP) failure = "filesystem";
    if (strcmp(failure, "io") == 0 && errno == EXDEV) failure = "cross-volume";
    printf("{\"ok\":false,\"reason\":\"%s\",\"errno\":%d}\n", failure, errno);
    return 1;
}
