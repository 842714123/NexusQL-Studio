import sqlite3
import tempfile
import unittest
from pathlib import Path

from queryforge.infrastructure.db.sqlite_connector import SQLiteConnector, SQLiteConnectorError


class SQLiteConnectorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temporary.name) / "schools.sqlite"
        connection = sqlite3.connect(self.database_path)
        connection.execute(
            "CREATE TABLE schools (id INTEGER PRIMARY KEY, name TEXT NOT NULL)"
        )
        connection.execute("INSERT INTO schools (name) VALUES ('Alpha')")
        connection.commit()
        connection.close()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_schema_and_query_result(self) -> None:
        with SQLiteConnector(str(self.database_path)) as connector:
            self.assertEqual(connector.list_tables(), ["schools"])
            schema = connector.describe_table("schools")
            self.assertEqual([column.name for column in schema.columns], ["id", "name"])
            self.assertTrue(schema.columns[0].primary_key)
            self.assertFalse(schema.columns[1].nullable)
            result = connector.execute_sql("SELECT name FROM schools")
        self.assertEqual(result.rows, [["Alpha"]])
        self.assertEqual(result.row_count, 1)

    def test_read_only_connection_blocks_write(self) -> None:
        with SQLiteConnector(str(self.database_path)) as connector:
            with self.assertRaises(SQLiteConnectorError):
                connector.execute_sql("DELETE FROM schools")

    def test_schema_exposes_physical_foreign_keys(self) -> None:
        connection = sqlite3.connect(self.database_path)
        connection.execute("CREATE TABLE districts (id INTEGER PRIMARY KEY)")
        connection.execute(
            "CREATE TABLE enrollments (id INTEGER PRIMARY KEY, district_id INTEGER "
            "REFERENCES districts(id))"
        )
        connection.commit()
        connection.close()
        with SQLiteConnector(str(self.database_path)) as connector:
            schema = connector.describe_table("enrollments")
        self.assertEqual(
            [foreign_key.model_dump() for foreign_key in schema.foreign_keys],
            [
                {
                    "column": "district_id",
                    "referenced_table": "districts",
                    "referenced_column": "id",
                }
            ],
        )

    def test_finds_question_matching_values(self) -> None:
        with SQLiteConnector(str(self.database_path)) as connector:
            values = connector.find_matching_values(
                "schools", "name", ["alpha"], limit=3
            )
        self.assertEqual(values, ["Alpha"])

    def test_missing_database_is_clear(self) -> None:
        with self.assertRaisesRegex(SQLiteConnectorError, "does not exist"):
            SQLiteConnector(str(self.database_path) + ".missing")

    def test_operations_do_not_keep_database_file_locked(self) -> None:
        connector = SQLiteConnector(str(self.database_path))
        connector.list_tables()
        connector.describe_table("schools")
        connector.execute_sql("SELECT name FROM schools")

        moved_path = self.database_path.with_name("moved.sqlite")
        self.database_path.replace(moved_path)
        self.database_path = moved_path

    def test_closed_connector_rejects_new_operations(self) -> None:
        connector = SQLiteConnector(str(self.database_path))
        connector.close()
        with self.assertRaisesRegex(SQLiteConnectorError, "closed"):
            connector.list_tables()


if __name__ == "__main__":
    unittest.main()
