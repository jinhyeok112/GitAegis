import Dashboard from "@/components/dashboard";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDatabaseDesign } from "@/lib/database-design";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { requireDatabaseUser } from "@/lib/server/request-auth";
import { loadDashboard } from "@/lib/server/dashboard-data";
import { errorResponse } from "@/lib/server/errors";
import type { DashboardData } from "@/lib/types";

export default async function Home() {
  // Authorize on the server before reading or rendering protected content.
  const session = await auth();
  if (!session?.user) redirect("/login");

  let initialData: DashboardData | null = null;
  let initialError = "";
  try {
    const { userId } = await requireDatabaseUser();
    initialData = await loadDashboard(userId);
  } catch (error) {
    initialError = (await errorResponse(error).json()).error;
  }
  const sql = await readFile(join(process.cwd(), "database/schema.sql"), "utf8");
  return <Dashboard databaseDesign={parseDatabaseDesign(sql)} session={session} initialData={initialData} initialError={initialError} />;
}
