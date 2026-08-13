"""Geometry-independent mapper for the TP-878 floor controller wire protocol.

Implements `docs/PROTOCOL.md` for any legal combination of floor type, tile
columns and tile rows, rather than the single 8x5 `8x8_8P` layout the original
PowerShell sender was written for.

Written from the specification in `docs/DECOMP_FINDINGS.md`. Contains no vendor
code.

Import from the submodule that owns the thing you want -- `mapper.floors`,
`mapper.frame`, `mapper.plan`, `mapper.orientation`, `mapper.sender`. This file
deliberately re-exports nothing. It used to carry a twenty-name `__all__`, and
no caller in the repo ever used it: every consumer already imports from the
module that defines what it needs, which is also the import that tells a reader
where the definition lives.
"""
