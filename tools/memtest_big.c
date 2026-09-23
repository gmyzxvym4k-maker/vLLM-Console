#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <sys/mman.h>
int main(int argc, char **argv) {
    size_t gb = argc > 1 ? (size_t)atol(argv[1]) : 130;
    size_t total = gb << 30, step = 1UL << 30;
    unsigned char *p = mmap(NULL, total, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);
    if (p == MAP_FAILED) { perror("mmap"); return 1; }
    printf("mmap %zu GB ok\n", gb); fflush(stdout);
    for (size_t off = 0; off < total; off += step) {
        size_t n = (total - off) < step ? (total - off) : step;
        uint64_t *q = (uint64_t*)(p + off);
        for (size_t i = 0; i < n/8; i++) q[i] = (uint64_t)(off + i*8) ^ 0xA5A5A5A5A5A5A5A5ULL;
        printf("W %zu/%zu\n", (off+step)>>30, gb); fflush(stdout);
    }
    for (size_t off = 0; off < total; off += step) {
        size_t n = (total - off) < step ? (total - off) : step;
        uint64_t *q = (uint64_t*)(p + off);
        for (size_t i = 0; i < n/8; i++) {
            uint64_t want = (uint64_t)(off + i*8) ^ 0xA5A5A5A5A5A5A5A5ULL;
            if (q[i] != want) { printf("MISMATCH off=%zu i=%zu got=%llx want=%llx\n", off, i, (unsigned long long)q[i], (unsigned long long)want); return 2; }
        }
        printf("V %zu/%zu\n", (off+step)>>30, gb); fflush(stdout);
    }
    printf("ALL_OK\n"); return 0;
}
