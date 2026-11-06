import sys

# Tested on 3.11-3.13. Refuse older Pythons loudly, before importing anything
# that could fail halfway and look like a different bug.
if sys.version_info < (3, 11):
    sys.exit(
        f"pxdf mapper needs Python 3.11 or newer; this is {sys.version.split()[0]} "
        f"({sys.executable})."
    )

from .cli import main

sys.exit(main())
