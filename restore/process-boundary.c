/* Candidate only: one thread group with a hard address-space ceiling.
 * This narrows the container's existing seccomp profile; it never replaces it.
 * A restore driver must disable healthchecks/--init and never docker-exec an
 * additional process into this container. Multi-process workloads fail closed.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <sched.h>
#include <time.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/seccomp.h>

#if __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error Unsupported argument byte order
#endif

#if defined(__aarch64__)
#define EXPECTED_ARCH AUDIT_ARCH_AARCH64
#elif defined(__x86_64__)
#define EXPECTED_ARCH AUDIT_ARCH_X86_64
#else
#error Unsupported syscall ABI
#endif

#define REQUIRED_THREAD_FLAGS (CLONE_VM | CLONE_SIGHAND | CLONE_THREAD)
#define ALLOWED_THREAD_FLAGS (REQUIRED_THREAD_FLAGS | CLONE_FS | CLONE_FILES | \
    CLONE_SYSVSEM | CLONE_SETTLS | CLONE_PARENT_SETTID | \
    CLONE_CHILD_CLEARTID | CLONE_CHILD_SETTID | CLONE_DETACHED)
#define REJECT (SECCOMP_RET_ERRNO | EPERM)
#ifndef GUARD_WALL_SECONDS
#define GUARD_WALL_SECONDS 300
#endif
_Static_assert(GUARD_WALL_SECONDS > 0 && GUARD_WALL_SECONDS <= 300,
               "Invalid guard deadline");

static void refuse(void) {
    fputs("recovery_process_boundary_refused\n", stderr);
    _exit(125);
}

static void ceiling(int resource, rlim_t value) {
    const struct rlimit limit = {value, value};
    if (setrlimit(resource, &limit) != 0) refuse();
}

static void restrict_process_creation(void) {
    struct sock_filter instructions[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, EXPECTED_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
        /* x32 uses the same audit arch but a different syscall-number space. */
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000U, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
#ifdef SYS_fork
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fork, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, REJECT),
#endif
#ifdef SYS_vfork
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_vfork, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, REJECT),
#endif
#ifdef SYS_clone3
        /* BPF cannot inspect clone3's pointed-to flags. Allow libc fallback. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone3, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
#endif
#ifdef SYS_io_uring_setup
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_io_uring_setup, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, REJECT),
#endif
        /* Non-clone calls continue to the container's existing restrictions. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]) + 4),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, REJECT),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_STMT(BPF_ALU | BPF_AND | BPF_K, REQUIRED_THREAD_FLAGS),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, REQUIRED_THREAD_FLAGS, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, REJECT),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_STMT(BPF_ALU | BPF_AND | BPF_K, (uint32_t)~ALLOWED_THREAD_FLAGS),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, REJECT),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = {
        .len = sizeof(instructions) / sizeof(instructions[0]),
        .filter = instructions,
    };
    if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER,
                SECCOMP_FILTER_FLAG_TSYNC, &program) != 0) refuse();
}

static volatile sig_atomic_t stop_requested = 0;
static void stop(int signal_number) { (void)signal_number; stop_requested = 1; }

static void execute(char **argv, rlim_t memory) {
    ceiling(RLIMIT_CORE, 0);
    ceiling(RLIMIT_AS, memory);
    ceiling(RLIMIT_CPU, 60);
    ceiling(RLIMIT_NOFILE, 128);
    restrict_process_creation();
    execv(argv[2], argv + 2);
    refuse();
}

static double monotonic(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) refuse();
    return value.tv_sec + value.tv_nsec / 1e9;
}

int main(int argc, char **argv) {
    if (argc < 3 || argv[2][0] != '/' || getpid() != syscall(SYS_gettid)) refuse();
    uid_t real, effective, saved;
    struct __user_cap_header_struct header = {.version = _LINUX_CAPABILITY_VERSION_3, .pid = 0};
    struct __user_cap_data_struct caps[2] = {0};
    if (getresuid(&real, &effective, &saved) != 0 || !real || real != effective || real != saved ||
        syscall(SYS_capget, &header, caps) != 0 || caps[0].effective || caps[1].effective ||
        caps[0].permitted || caps[1].permitted || caps[0].inheritable || caps[1].inheritable) refuse();
    int watchdog = strcmp(argv[1], "vm-1536m") == 0 || strcmp(argv[1], "vm-1280m") == 0 || strcmp(argv[1], "vm-1024m") == 0;
    rlim_t memory;
    if (strcmp(argv[1], "probe-64m") == 0) memory = 64ULL * 1024 * 1024;
    else if (strcmp(argv[1], "application-2g") == 0) memory = 2ULL * 1024 * 1024 * 1024;
    else if (watchdog) memory = (strcmp(argv[1], "vm-1024m") == 0 ? 1024ULL :
        strcmp(argv[1], "vm-1280m") == 0 ? 1280ULL : 1536ULL) * 1024 * 1024;
    else refuse();
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) refuse();
    if (!watchdog) execute(argv, memory);

    /* Exactly one child is created before either process installs the filter.
     * Only the child executes the requested VM; parent memory is independently
     * clamped, and neither side can create another host process afterward.
     */
    if (getpid() != 1 || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) refuse();
    struct sigaction action = {.sa_handler = stop};
    if (sigemptyset(&action.sa_mask) != 0 || sigaction(SIGTERM, &action, NULL) != 0 ||
        sigaction(SIGINT, &action, NULL) != 0) refuse();
    const double started = monotonic();
    pid_t child = fork();
    if (child < 0) refuse();
    if (child == 0) execute(argv, memory);
    ceiling(RLIMIT_CORE, 0);
    ceiling(RLIMIT_AS, 64ULL * 1024 * 1024);
    ceiling(RLIMIT_CPU, 4);
    ceiling(RLIMIT_NOFILE, 128);
    restrict_process_creation();
    for (;;) {
        int status;
        pid_t result = waitpid(child, &status, WNOHANG);
        if (result == child) {
            if (WIFEXITED(status)) return WEXITSTATUS(status);
            if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
            refuse();
        }
        if (result < 0 && errno != EINTR) refuse();
        if (stop_requested || monotonic() - started >= GUARD_WALL_SECONDS) {
            if (kill(child, SIGKILL) != 0 && errno != ESRCH) refuse();
            while (waitpid(child, &status, 0) < 0) if (errno != EINTR) refuse();
            return stop_requested ? 143 : 124;
        }
        struct timespec pause = {.tv_sec = 0, .tv_nsec = 100000000};
        nanosleep(&pause, NULL);
    }
}
