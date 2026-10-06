import Dashboard from "@/components/dashboard";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDatabaseDesign } from "@/lib/database-design";

export default async function Home() {
  const sql = await readFile(join(process.cwd(), "database/schema.sql"), "utf8");
  return <Dashboard databaseDesign={parseDatabaseDesign(sql)} />;
}
