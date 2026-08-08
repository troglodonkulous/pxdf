"""The oracle harness: config list in, pass/fail diff table out, unattended.

See `docs/ORACLE_HARNESS.md` for the design and how to run it.

    python -m tools.oracle.harness run              # dry-run against captures/*.pcapng (default)
    python -m tools.oracle.harness list-interfaces   # dumpcap -D, for finding the floor NIC

Everything here reuses `mapper/` -- `mapper.pcapng` for decoding, `mapper.verify`
for the byte-level diff primitive, `mapper.floors`/`mapper.frame`/`mapper.plan`
for geometry and the expected wire bytes. Nothing in this package reimplements
the protocol; it only orchestrates what `mapper/` already does against a list
of configs and turns the result into a table.
"""
