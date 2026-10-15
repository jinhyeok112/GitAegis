import "server-only";
import mysql, { type Pool } from "mysql2/promise";
import { ServiceError } from "@/lib/server/errors";

const databaseGlobal = globalThis as typeof globalThis & { gitAegisPool?: Pool };

export function isDatabaseConfigured() {
  return Boolean(process.env.MYSQL_DATABASE?.trim() && process.env.MYSQL_USER?.trim());
}

export function getDatabase() {
  if (!isDatabaseConfigured()) throw new ServiceError("DATABASE_NOT_CONFIGURED", "DB 연결 설정이 필요합니다.");
  if (!databaseGlobal.gitAegisPool) {
    databaseGlobal.gitAegisPool = mysql.createPool({
      host: process.env.MYSQL_HOST || "127.0.0.1",
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD || "",
      database: process.env.MYSQL_DATABASE,
      connectionLimit: 5,
      maxIdle: 2,
      idleTimeout: 60000,
      connectTimeout: 5000,
      waitForConnections: true,
      queueLimit: 20,
      charset: "utf8mb4",
      timezone: "Z",
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
  }
  return databaseGlobal.gitAegisPool;
}
