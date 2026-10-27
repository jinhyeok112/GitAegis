import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import mysql from "mysql2/promise";

const require = createRequire(import.meta.url);
require("@next/env").loadEnvConfig(process.cwd());
const database = process.env.MYSQL_DATABASE;
if (!database || !/^[A-Za-z0-9_]+$/.test(database) || !process.env.MYSQL_USER) {
  throw new Error("Set MYSQL_DATABASE and MYSQL_USER in .env.local before initialization.");
}
let connection;
try {
  connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || "",
    connectTimeout: 5000,
    multipleStatements: true,
  });
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await connection.query(`USE \`${database}\``);
  const schema = await readFile(new URL("../database/schema.sql", import.meta.url), "utf8");
  await connection.query(schema.replaceAll("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "));
  const [scopeColumns] = await connection.query("SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = ? AND table_name = 'scans' AND column_name = 'scan_scope'", [database]);
  if (!scopeColumns.length) await connection.query("ALTER TABLE scans ADD COLUMN scan_scope ENUM('unknown', 'sast', 'sast_dependency') NOT NULL DEFAULT 'unknown' AFTER status");
  const [rows] = await connection.query("SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = ?", [database]);
  console.log(`MySQL schema ready: ${rows[0].count} tables. Existing records preserved.`);
} catch (error) {
  console.error("Database initialization failed:", error.code || "UNKNOWN_ERROR");
  process.exitCode = 1;
} finally {
  await connection?.end();
}
