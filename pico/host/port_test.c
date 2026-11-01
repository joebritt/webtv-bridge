// Pin-level test of the port engine (src/port.c): one thread runs
// port_step() as core 1 would, another plays core 0, the main thread is the box:
//
//   1. the probe watch: the boot ROM's 0xF1/0xF2/0xF4/0xF8 with the four control lines high
//      switches IDLE (and PARMOD) to the dongle at once, and the status lines mirror D0-D3;
//      nothing happens with the watch off or for any other byte
//   2. the diagnostics serial at 19200 8N1: the box sends a prompt on nSelectIn, core 0 answers
//      "19\r", which the box reads on D7 the way the ROM's char in does
//   3. PARMOD, as src/lptmodem/parmod.js drives it: the entry signature and the version reply,
//      then modem and console data both ways (core 0 echoes,
//      slowly at times so the modem channel refuses and recovers), commands with LEGACY_ECP's
//      argument, and the carrier in the status byte
//
//   port_test [1|2]   board revision (default 2)
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <stdatomic.h>
#include <unistd.h>
#include <time.h>
#ifdef __APPLE__
#include <pthread/qos.h>
#endif
#include "port.h"
#include "link.h"
#include "link_hw.h"

_Atomic uint32_t sim_box_pins;
_Atomic uint32_t sim_bridge_pins;
_Atomic int sim_box_drives_data = 1;
static _Atomic int stop, core0_slow, core0_echo, carrier;
static int fails;

void sim_trace(void) {}

static struct timespec t0;
uint32_t sim_now_us(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint32_t)((t.tv_sec - t0.tv_sec) * 1000000 + (t.tv_nsec - t0.tv_nsec) / 1000);
}
static void spin_until(uint32_t us) { while ((int32_t)(sim_now_us() - us) < 0) { } }

#define CHECK(c, ...) do { if (!(c)) { printf("FAIL: " __VA_ARGS__); printf("\n"); fails++; } } while (0)

// the box and core 1 time a 19200 baud line by spinning: keep them on fast cores
static void fast_thread(void) {
#ifdef __APPLE__
    pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
#endif
}

static void *core1(void *arg) { (void)arg; fast_thread(); while (!atomic_load(&stop)) port_step(); return NULL; }

// core 0: echo PARMOD's modem and console channels, keep the diagnostics bytes, log commands
static char diag_got[256];
static size_t diag_len;
static uint8_t cmds[64];
static _Atomic size_t ncmds;
static void *core0(void *arg) {
    (void)arg;
    static uint8_t mpend[1 << 21], cpend[1 << 18];
    size_t mlen = 0, moff = 0, clen = 0, coff = 0;
    uint8_t buf[256], a;
    while (!atomic_load(&stop)) {
        int slow = atomic_load(&core0_slow);
        if (slow) usleep(3000);
        else if (!atomic_load(&core0_echo)) usleep(100);
        size_t n = port_diag_read(buf, sizeof buf);
        if (n && diag_len + n < sizeof diag_got) { memcpy(diag_got + diag_len, buf, n); diag_len += n; }
        if (atomic_load(&core0_echo)) {
            n = port_pm_modem_read(buf, slow ? 8 : sizeof buf);
            memcpy(mpend + mlen, buf, n); mlen += n;
            if (moff < mlen) moff += port_pm_modem_write(mpend + moff, mlen - moff);
            n = port_pm_console_read(buf, sizeof buf);
            memcpy(cpend + clen, buf, n); clen += n;
            if (coff < clen) coff += port_pm_console_write(cpend + coff, clen - coff);
        }
        int c;
        while ((c = port_pm_command(&a)) >= 0) { size_t k = atomic_load(&ncmds); if (k + 2 <= sizeof cmds) { cmds[k] = (uint8_t)c; cmds[k + 1] = a; atomic_store(&ncmds, k + 2); } }
        port_pm_carrier(atomic_load(&carrier));
    }
    return NULL;
}

static void box_ctrl(uint32_t set, uint32_t clr) {
    uint32_t v = atomic_load(&sim_box_pins);
    atomic_store(&sim_box_pins, (v | set) & ~clr);
}
static void box_data(uint8_t b) {
    atomic_store(&sim_box_drives_data, 1);
    uint32_t v = atomic_load(&sim_box_pins);
    atomic_store(&sim_box_pins, (v & ~M_DATA) | byte_to_pins(b));
}
static void box_release(void) { atomic_store(&sim_box_drives_data, 0); }
static uint32_t stat(void) { return hw_in(); }
static int wait_for(uint32_t mask, int high, uint32_t us) {
    uint32_t end = sim_now_us() + us;
    while ((int32_t)(sim_now_us() - end) < 0) if (!!(stat() & mask) == high) return 1;
    return 0;
}
static void settle(void) { usleep(200); }

// ---------------------------------------------------------------- 1. the probe watch

static uint8_t mirror_of(uint32_t in) {
    return (uint8_t)((in & M_ACK ? 1 : 0) | (in & M_BUSY ? 2 : 0) | (in & M_PERROR ? 4 : 0) | (in & M_FAULT ? 8 : 0));
}

static void test_probe(void) {
    box_ctrl(M_STROBE | M_AUTOFD | M_INIT | M_SELIN, 0);
    port_set_mode(PORT_IDLE);
    port_watch_probe(false);
    settle();
    box_data(0xf1); settle();
    CHECK(port_mode() == PORT_IDLE && !port_take_events(PORT_EV_PROBE), "probe seen with the watch off");
    box_data(0x00); settle();
    port_watch_probe(true); settle();
    box_data(0xf3); settle();
    CHECK(port_mode() == PORT_IDLE, "0xf3 taken for a probe");
    box_data(0xf1);
    // the ROM reads STAT right away: the mirror must be up within microseconds
    int ok = wait_for(M_BUSY | M_PERROR | M_FAULT, 0, 50) && (stat() & M_ACK);
    CHECK(ok, "no mirror of 0xf1 within 50 us");
    settle();
    CHECK(port_mode() == PORT_DONGLE && port_take_events(PORT_EV_PROBE) == PORT_EV_PROBE, "probe didn't switch to the dongle");
    const uint8_t pat[] = { 0xf2, 0xf4, 0xf8, 0x05, 0x0a };
    for (int i = 0; i < 5; i++) {
        box_data(pat[i]); settle();
        CHECK(mirror_of(stat()) == (pat[i] & 15) && !!(stat() & M_SELECT) == !!(pat[i] & 8), "mirror of 0x%02x shows 0x%x", pat[i], mirror_of(stat()));
    }
    // from PARMOD too (a crash or a reset in the OS's session)
    port_set_mode(PORT_PARMOD); port_watch_probe(true); box_data(0x00); settle();
    box_data(0xf8); settle();
    CHECK(port_mode() == PORT_DONGLE && port_take_events(PORT_EV_PROBE), "probe from PARMOD not seen");
    printf("probe watch: done\n");
}

// ---------------------------------------------------------------- 2. the diagnostics serial

#define BIT_US (1000000.0 / 19200 * 0.998)   // the box times its bits 0.2% fast

static void box_char_out(uint8_t c) {
    uint32_t t = sim_now_us();
    for (int n = 0; n < 10; n++) {
        int v = n == 0 ? 0 : n <= 8 ? (c >> (n - 1)) & 1 : 1;
        if (v) box_ctrl(M_SELIN, 0); else box_ctrl(0, M_SELIN);
        spin_until(t + (uint32_t)((n + 1) * BIT_US));
    }
}

// the ROM's char in: poll D7 for a start bit for up to `us`, then sample mid-bit
static int box_char_in(uint32_t us) {
    uint32_t end = sim_now_us() + us;
    while (stat() & byte_to_pins(0x80)) if ((int32_t)(sim_now_us() - end) >= 0) return -1;
    uint32_t t = sim_now_us();
    int c = 0;
    for (int n = 1; n <= 9; n++) {
        spin_until(t + (uint32_t)((n + 0.5) * BIT_US));
        int v = !!(stat() & byte_to_pins(0x80));
        if (n <= 8) c |= v << (n - 1);
        else if (!v) return -2;
    }
    return c;
}

// A host thread can be descheduled mid-char (the Pico's core 1 can't), so each direction gets
// three tries: a timing bug fails all three, scheduling jitter at most one.
static void test_serial(void) {
    box_release();
    box_ctrl(M_STROBE | M_AUTOFD | M_INIT | M_SELIN, 0);
    port_set_mode(PORT_DONGLE);
    usleep(3000);
    const char *prompt = "Dongle Attached!!!\r\nParallel in>";
    int tries, bad = 0;
    for (tries = 0; tries < 3; tries++) {
        diag_len = 0;
        for (const char *p = prompt; *p; p++) { box_char_out((uint8_t)*p); spin_until(sim_now_us() + 30); }
        usleep(20000);
        if (diag_len == strlen(prompt) && !memcmp(diag_got, prompt, diag_len)) break;
        printf("  box -> bridge, try %d: got %zu bytes \"%.*s\"\n", tries + 1, diag_len, (int)diag_len, diag_got);
        bad++;
    }
    CHECK(tries < 3, "box -> bridge: no clean try");
    // the box listens; core 0 types (it may start only after 1.5 ms of quiet)
    for (tries = 0; tries < 3; tries++) {
        port_diag_write((const uint8_t *)"19\r", 3);
        char got[8] = "";
        int n = 0, framing = 0;
        for (int k = 0; k < 400 && n < 3; k++) {
            int c = box_char_in(1000);
            if (c >= 0) got[n++] = (char)c;
            else if (c == -2) { framing = 1; break; }
        }
        while (!port_diag_tx_idle()) usleep(1000);
        if (!framing && n == 3 && !memcmp(got, "19\r", 3)) break;
        printf("  bridge -> box, try %d: got %d chars \"%.*s\"%s\n", tries + 1, n, n, got, framing ? ", framing error" : "");
        bad++;
        usleep(5000);
    }
    CHECK(tries < 3, "bridge -> box: no clean try");
    usleep(2000);
    CHECK(!(stat() & M_DIR) && port_diag_tx_idle(), "bus still driven after the chars");
    printf("diagnostics serial: done%s\n", bad ? " (with retries)" : "");
}

// ---------------------------------------------------------------- 3. PARMOD (parmod.js's pm_xfer)

enum { CTRL_OUT = 5, CTRL_IN = 4, MODEM_OUT = 3, MODEM_IN = 2, CON_OUT = 1, CON_IN = 6 };
static long xfail;

// one transaction: -> data (_IN) or -1; *sel = Select
static int xfer(int code, uint8_t out, int *sel) {
    if (!wait_for(M_BUSY, 0, 200000)) { xfail++; return -1; }
    uint32_t lines = (code & 4 ? M_SELIN : 0) | (code & 2 ? M_INIT : 0) | (code & 1 ? M_AUTOFD : 0);
    box_ctrl(lines | M_STROBE, (M_SELIN | M_INIT | M_AUTOFD) & ~lines);
    bool outward = code == CTRL_OUT || code == MODEM_OUT || code == CON_OUT;
    if (outward) box_data(out); else box_release();
    box_ctrl(0, M_STROBE);
    if (!wait_for(M_BUSY, 1, 200000)) { box_ctrl(M_STROBE, 0); xfail++; return -1; }
    uint32_t in = stat();
    *sel = !!(in & M_SELECT);
    box_ctrl(M_STROBE, 0);
    return outward ? 0 : pins_to_byte(in);
}
// pm_idle: the bus to all ones while the box still drives it, then released, then code 111
static void idle(void) {
    if (atomic_load(&sim_box_drives_data)) box_data(0xff);
    box_release();
    box_ctrl(M_SELIN | M_INIT | M_AUTOFD | M_STROBE, 0);
}

static void test_parmod(void) {
    int sel;
    idle();
    port_set_mode(PORT_PARMOD);
    port_watch_probe(true);          // the box idles with 0xFF on the bus: never the probe
    port_stats_t sp;
    port_get_stats(&sp);
    uint32_t probes0 = sp.probes;
    usleep(1000);
    atomic_store(&core0_echo, 1);
    const uint8_t sig[] = { 'L', 'P', 'T', '2' };
    for (int i = 0; i < 4; i++) { xfer(CTRL_OUT, sig[i], &sel); CHECK(sel, "signature byte %d not taken", i); }
    CHECK(port_mode() == PORT_PARMOD && port_take_events(PORT_EV_PARMOD), "no session event on the entry");
    int v = xfer(CTRL_IN, 0, &sel);
    CHECK(sel && v == 2, "version reply %d (Select %d)", v, sel);
    CHECK(port_pm_session(), "no session");
    idle(); usleep(500);
    CHECK(stat() & M_FAULT, "nFault low with nothing for the box");
    CHECK(!(stat() & M_PERROR), "PError high in a session");

    // commands
    xfer(CTRL_OUT, PM_DTR_ON, &sel);
    xfer(CTRL_OUT, PM_LEGACY_ECP, &sel); xfer(CTRL_OUT, 0x88, &sel);
    xfer(CTRL_OUT, PM_MODEM_RESET, &sel);
    idle(); usleep(5000);
    const uint8_t want_cmds[] = { PM_DTR_ON, 0, PM_LEGACY_ECP, 0x88, PM_MODEM_RESET, 0 };
    CHECK(atomic_load(&ncmds) == 6 && !memcmp(cmds, want_cmds, 6), "commands: got %zu bytes", atomic_load(&ncmds));

    // carrier: in the status byte (CTRL_IN with no reply: Select low)
    atomic_store(&carrier, 1); usleep(2000);
    v = xfer(CTRL_IN, 0, &sel);
    CHECK(!sel && (v & 8), "carrier not in the status byte (0x%x, Select %d)", v, sel);
    atomic_store(&carrier, 0); usleep(2000);

    // modem and console both ways, echoed by core 0
    const size_t N = 200000, NC = 20000;
    uint8_t *sent = malloc(N), *got = malloc(N), *csent = malloc(NC), *cgot = malloc(NC);
    for (size_t i = 0; i < N; i++) sent[i] = (uint8_t)(rand() >> 7);
    for (size_t i = 0; i < NC; i++) csent[i] = (uint8_t)(32 + rand() % 95);
    size_t ns = 0, ng = 0, cs = 0, cg = 0;
    long refused = 0;
    uint32_t deadline = sim_now_us() + 120000000u;
    while (ng < N || cg < NC) {
        if ((int32_t)(sim_now_us() - deadline) >= 0) {
            port_stats_t st;
            port_get_stats(&st);
            printf("PARMOD stuck: sent %zu got %zu, console sent %zu got %zu, nFault %d, %lu transactions\n", ns, ng, cs, cg,
                   !!(stat() & M_FAULT), (unsigned long)st.pm_xfers);
            break;
        }
        atomic_store(&core0_slow, ns >= 40000 && ns < 52000);
        // like pm_session: what is there for us (nFault low), then send until refused
        while (!(stat() & M_FAULT)) {
            int any = 0;
            while ((v = xfer(MODEM_IN, 0, &sel)) >= 0 && sel && ng < N) { got[ng++] = (uint8_t)v; any = 1; }
            while ((v = xfer(CON_IN, 0, &sel)) >= 0 && sel && cg < NC) { cgot[cg++] = (uint8_t)v; any = 1; }
            idle();
            if (!any) break;
        }
        for (int k = 0; k < 64 && ns < N; k++) {
            if (xfer(MODEM_OUT, sent[ns], &sel) < 0) break;
            if (sel) ns++; else { refused++; break; }
        }
        // console output is never refused (dropped when full), so the box sends it at printf
        // rates (50 KB/s here), and none while core 0 is slow
        if (!atomic_load(&core0_slow))
            for (int k = 0; k < 8 && cs < NC; k++) if (xfer(CON_OUT, csent[cs], &sel) >= 0) { cs++; spin_until(sim_now_us() + 20); }
        idle();
        if (xfail > 100) break;
    }
    CHECK(ng == N && !memcmp(sent, got, N), "modem: %zu of %zu bytes back, %s", ng, N, memcmp(sent, got, ng) ? "different" : "same so far");
    CHECK(cg == NC && !memcmp(csent, cgot, NC), "console: %zu of %zu bytes back", cg, NC);
    CHECK(!xfail, "%ld transactions unanswered", xfail);
    CHECK(refused > 0, "the modem channel never refused (the slow phase didn't fill it)");
    port_stats_t s0;
    port_get_stats(&s0);
    CHECK(!s0.pm_con_dropped && !s0.pm_cmd_dropped, "dropped: %lu console bytes, %lu commands", (unsigned long)s0.pm_con_dropped, (unsigned long)s0.pm_cmd_dropped);
    CHECK(s0.probes == probes0, "the probe watch fired during the session (%lu times)", (unsigned long)(s0.probes - probes0));
    // EXIT ends the session
    xfer(CTRL_OUT, PM_EXIT, &sel); idle(); usleep(1000);
    CHECK(!port_pm_session() && (stat() & M_PERROR), "EXIT didn't end the session");
    port_stats_t st;
    port_get_stats(&st);
    printf("PARMOD: %zu modem bytes and %zu console bytes each way, %ld refusals, %lu transactions, %lu attentions\n",
           N, NC, refused, (unsigned long)st.pm_xfers, (unsigned long)st.pm_attentions);
    free(sent); free(got); free(csent); free(cgot);
}

int main(int argc, char **argv) {
    static const link_board_t rev1 = BOARD_REV1, rev2 = BOARD_REV2;
    int rev = argc > 1 ? atoi(argv[1]) : 2;
    setvbuf(stdout, NULL, _IONBF, 0);
    fast_thread();
    clock_gettime(CLOCK_MONOTONIC, &t0);
    link_select_board(rev == 1 ? &rev1 : &rev2);
    atomic_store(&sim_box_pins, M_STROBE | M_AUTOFD | M_INIT | M_SELIN);
    link_init();
    port_resume();
    pthread_t t1, tc0;
    pthread_create(&t1, NULL, core1, NULL);
    pthread_create(&tc0, NULL, core0, NULL);
    test_probe();
    test_serial();
    test_parmod();
    atomic_store(&stop, 1);
    pthread_join(t1, NULL); pthread_join(tc0, NULL);
    printf("%s: board rev %d, %d failures\n", fails ? "FAIL" : "PASS", rev, fails);
    return fails ? 1 : 0;
}
