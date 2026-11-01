# Host test of the port engine (src/port.c), for testing without a Pico. The whole firmware runs
# against the emulated box in pico/sim (run.mjs --pico).
#   make test       port_test: the probe watch and mirror, the diagnostics serial both ways, an
#                   PARMOD session (both board revisions)
CC ?= cc
CFLAGS ?= -O2 -g -Wall -Wextra -Wno-unused-parameter
SRC = ../src
CPPFLAGS = -I$(SRC) -I.

all: port_test

port_test: port_test.c $(SRC)/port.c $(SRC)/link.c $(SRC)/*.h
	$(CC) $(CPPFLAGS) $(CFLAGS) -DLINK_HOST_SIM -pthread -o $@ port_test.c $(SRC)/port.c $(SRC)/link.c

test: port_test
	./port_test 2
	./port_test 1

clean:
	rm -rf port_test *.dSYM

.PHONY: all test clean
