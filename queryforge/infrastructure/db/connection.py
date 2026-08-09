"""Deterministic SQLite connection lifecycle helpers."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def sqlite_connection(
    database: str | Path,
    *,
    uri: bool = False,
    timeout: float = 5.0,
) -> Iterator[sqlite3.Connection]:
    """Commit or roll back a unit of work and always close its connection.

    ``sqlite3.Connection`` commits or rolls back when used as a context manager,
    but it does not close itself.  The distinction matters on Windows, where an
    open connection keeps the database file locked against atomic replacement
    and deletion.
    """

    connection = sqlite3.connect(database, uri=uri, timeout=timeout)
    try:
        with connection:
            yield connection
    finally:
        connection.close()
